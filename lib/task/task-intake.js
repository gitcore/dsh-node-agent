import { SessionId } from "@deepseek-ai/dsh-session";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { TASK_EVENT_KINDS, TASK_REQUEST_TYPE } from "../protocol.js";
import { errorMessage } from "../connection/hub-connection.js";
import { summarizeOutcome } from "./task-completion.js";
import { resolveWorkspace } from "./workspace.js";
export class TaskIntake {
    ctx;
    config;
    registry;
    hub;
    relay;
    log;
    counters;
    selection;
    constructor(ctx, config, registry, hub, relay, log, counters) {
        this.ctx = ctx;
        this.config = config;
        this.registry = registry;
        this.hub = hub;
        this.relay = relay;
        this.log = log;
        this.counters = counters;
        try {
            const service = ctx.get("agentDefaultModel");
            this.selection = typeof service?.currentSelection === "function" ? service.currentSelection() : undefined;
        }
        catch {
            this.selection = undefined;
        }
    }
    onTaskDispatched(payload) {
        const taskId = payload?.taskId;
        const prompt = payload?.prompt;
        if (!taskId || typeof prompt !== "string" || prompt.trim().length === 0) {
            this.log.warn("intake", `invalid taskDispatched payload: ${JSON.stringify({ taskId, hasPrompt: typeof prompt === "string" })}`);
            return;
        }
        const workspaceHint = payload?.metadata && typeof payload.metadata === "object" ? payload.metadata.workspace : undefined;
        void this.accept(taskId, prompt, payload.metadata, "taskDispatched", workspaceHint);
    }
    onA2AMessage(message) {
        if (message?.type !== TASK_REQUEST_TYPE) {
            this.log.info("intake", `ignoring a2a type=${message?.type ?? "?"} from=${message?.fromNodeId ?? "?"}`);
            return;
        }
        const payload = message.payload ?? {};
        const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
        const correlationId = typeof message.correlationId === "string" ? message.correlationId.trim() : "";
        const taskId = correlationId.length > 0 ? correlationId : `a2a-${message.messageId ?? Date.now()}`;
        if (prompt.trim().length === 0) {
            this.log.warn("intake", `a2a task.request without prompt (taskId=${taskId})`, taskId);
            return;
        }
        const workspaceHint = payload.workspace;
        const metadata = { ...payload, messageId: message.messageId, fromNodeId: message.fromNodeId };
        void this.accept(taskId, prompt, metadata, "a2a", workspaceHint);
    }
    async accept(taskId, prompt, metadata, source, workspaceHint) {
        if (this.registry.has(taskId)) {
            this.log.warn("intake", `duplicate taskId ${taskId}; rejecting`, taskId);
            await this.hub.reportTaskEvent({ taskId, kind: TASK_EVENT_KINDS.FAILED, message: "duplicate taskId" });
            return;
        }
        if (this.registry.activeCount() >= this.config.maxConcurrency) {
            this.log.warn("intake", `max concurrency (${this.config.maxConcurrency}) reached; rejecting ${taskId}`, taskId);
            await this.hub.reportTaskEvent({ taskId, kind: TASK_EVENT_KINDS.FAILED, message: `max concurrency reached (${this.config.maxConcurrency})` });
            return;
        }
        this.registry.begin(taskId, source);
        this.log.info("intake", `accepting task ${taskId} (source=${source})`, taskId);
        // Resolve the target workspace before creating the session (its path
        // becomes the session cwd, which is half of workspace membership).
        const workspace = await resolveWorkspace(this.ctx, workspaceHint, this.log);
        const cwd = workspace?.path ?? this.config.workspace;
        if (workspace)
            this.log.info("intake", `task ${taskId} -> workspace ${workspace.path}`, taskId);
        try {
            const handle = await this.ctx.agents.create({
                sessionId: SessionId(taskId),
                meta: { cwd },
                agentOptions: this.selection ? { provider: this.selection.provider, model: this.selection.model } : undefined,
                setup: (agentCtx) => {
                    if (this.selection)
                        installModelSelection(agentCtx, { current: this.selection, assembled: void 0 });
                },
            });
            this.registry.attachHandle(taskId, handle);
            // Attach the session to the workspace account (the other half of
            // membership) so the sidebar groups it under that workspace.
            if (workspace) {
                try {
                    await workspace.attach(taskId);
                }
                catch (error) {
                    this.log.warn("intake", `workspace attach failed for ${taskId}: ${errorMessage(error)}`, taskId);
                }
            }
            this.registry.setRunning(taskId);
            this.relay.attach(taskId);
            const accepted = await this.hub.reportTaskEvent({
                taskId,
                kind: TASK_EVENT_KINDS.STARTED,
                message: "node accepted the task",
                data: { sessionId: taskId, source, ...(workspace ? { workspace: workspace.path } : {}) },
            });
            if (!accepted)
                this.log.warn("intake", `started event not delivered (hub offline); session ${taskId} is running`, taskId);
            void this.run(taskId, handle, prompt);
        }
        catch (error) {
            this.registry.finish(taskId, "error");
            this.registry.archive(taskId, "error", source);
            this.registry.delete(taskId);
            this.counters.failedTasks++;
            const detail = errorMessage(error).slice(0, 300);
            this.log.error("intake", `agent create failed for ${taskId}: ${detail}`, taskId);
            await this.hub.reportTaskEvent({ taskId, kind: TASK_EVENT_KINDS.FAILED, message: `agent create failed: ${detail}` });
        }
    }
    async run(taskId, handle, prompt) {
        const { agent } = handle;
        try {
            await agent.whenIdle();
            const firstSeq = agent.session.seq;
            agent.followup(createUserMessage({ content: [{ type: "text", text: prompt }], source: { kind: "user" } }));
            await agent.whenIdle();
            await this.ctx.sessions.flush(agent.session);
            const outcome = summarizeOutcome(agent.session.events, firstSeq);
            this.relay.detach(taskId);
            const source = this.registry.get(taskId)?.source ?? "taskDispatched";
            if (outcome.finishReason === "completed") {
                this.registry.finish(taskId, "completed");
                this.registry.archive(taskId, "completed", source, outcome.text);
                this.counters.processedTasks++;
                this.log.info("intake", `task ${taskId} completed`, taskId);
                await this.hub.reportTaskEvent({
                    taskId,
                    kind: TASK_EVENT_KINDS.COMPLETED,
                    message: "task completed",
                    data: { finalResponse: outcome.text, finishReason: "completed" },
                });
            }
            else {
                this.registry.finish(taskId, outcome.finishReason);
                this.registry.archive(taskId, outcome.finishReason, source, outcome.text);
                this.counters.failedTasks++;
                this.log.warn("intake", `task ${taskId} finished with reason=${outcome.finishReason}`, taskId);
                await this.hub.reportTaskEvent({
                    taskId,
                    kind: TASK_EVENT_KINDS.FAILED,
                    data: { finishReason: outcome.finishReason, errorCode: outcome.errorCode ?? null, errorMessage: outcome.errorMessage?.slice(0, 300) ?? null },
                });
            }
        }
        catch (error) {
            this.relay.detach(taskId);
            this.registry.finish(taskId, "error");
            this.registry.archive(taskId, "error", this.registry.get(taskId)?.source ?? "taskDispatched");
            this.counters.failedTasks++;
            const detail = errorMessage(error).slice(0, 300);
            this.log.error("intake", `task ${taskId} crashed: ${detail}`, taskId);
            await this.hub.reportTaskEvent({ taskId, kind: TASK_EVENT_KINDS.FAILED, message: `execution error: ${detail}` });
        }
        finally {
            // Deliberately NOT handle.dispose(): dispose would remove the session
            // from the store and the sidebar conversation vanishes. The agent stays
            // idle and its session stays live so the user can open it and read the
            // result; idle agents are capped by enforceIdleCap().
            this.registry.delete(taskId);
            void this.enforceIdleCap();
        }
    }
    /** Dispose oldest idle agents beyond the cap (their sessions age out). */
    async enforceIdleCap() {
        try {
            const keep = Math.max(this.config.maxConcurrency * 3, 6);
            const disposed = await this.registry.disposeIdleBeyond(keep);
            for (const taskId of disposed)
                this.log.info("intake", `disposed idle agent/session ${taskId} (cap ${keep})`);
        }
        catch (error) {
            this.log.warn("intake", `idle-cap enforcement failed: ${errorMessage(error)}`);
        }
    }
}
