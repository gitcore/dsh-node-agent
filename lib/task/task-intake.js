/**
 * Task intake: dual-channel acceptance (taskDispatched + a2a task.request),
 * in-process agent/session creation via ctx.agents.create, started/failed
 * reporting, and the run-to-completion driver with final report.
 */
import { randomUUID } from "node:crypto";
import { Message } from "@a2a-js/sdk";
import { SessionId } from "@deepseek-ai/dsh-session";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { TASK_EVENT_KINDS } from "../protocol.js";
import { errorMessage } from "../connection/hub-connection.js";
import { summarizeOutcome } from "./task-completion.js";
import { resolveWorkspace } from "./workspace.js";
function contextIdOf(value) {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
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
        void this.accept(taskId, prompt, payload.metadata, "taskDispatched", contextIdOf(payload.contextId), workspaceHint);
    }
    onA2AMessage(envelope) {
        // The envelope's message is an official A2A v1 Message; parse it with the
        // official SDK (wire-compatible with the hub's .NET A2A model).
        let message;
        try {
            message = Message.fromJSON(envelope?.message);
        }
        catch (error) {
            this.log.error("intake", `invalid A2A message (deliveryId=${envelope?.messageId ?? "?"} from=${envelope?.fromNodeId ?? "?"}): ${errorMessage(error)}`);
            return;
        }
        // The prompt is the concatenated text parts; the workspace hint rides in metadata.
        const prompt = message.parts
            .map((part) => (part.content?.$case === "text" ? part.content.value : ""))
            .join("")
            .trim();
        if (prompt.length === 0) {
            this.log.warn("intake", `a2a message without text parts (deliveryId=${envelope.messageId ?? "?"} from=${envelope.fromNodeId ?? "?"})`);
            return;
        }
        const correlationId = typeof envelope.correlationId === "string" ? envelope.correlationId.trim() : "";
        const innerMessageId = typeof message.messageId === "string" ? message.messageId.trim() : "";
        const taskId = correlationId.length > 0 ? correlationId : innerMessageId.length > 0 ? innerMessageId : `a2a-${envelope.messageId ?? Date.now()}`;
        const metadata = message.metadata && typeof message.metadata === "object" ? { ...message.metadata } : {};
        const workspaceHint = metadata.workspace;
        void this.accept(taskId, prompt, { ...metadata, deliveryId: envelope.messageId, fromNodeId: envelope.fromNodeId }, "a2a", contextIdOf(message.contextId), workspaceHint);
    }
    async accept(taskId, prompt, metadata, source, contextId, workspaceHint) {
        if (this.registry.has(taskId)) {
            this.log.warn("intake", `duplicate taskId ${taskId}; rejecting`, taskId);
            await this.reportWith(taskId, this.registry.knownContextOf(taskId), { kind: TASK_EVENT_KINDS.FAILED, message: "duplicate taskId" });
            return;
        }
        if (this.registry.activeCount() >= this.config.maxConcurrency) {
            this.log.warn("intake", `max concurrency (${this.config.maxConcurrency}) reached; rejecting ${taskId}`, taskId);
            await this.reportWith(taskId, this.registry.knownContextOf(taskId), { kind: TASK_EVENT_KINDS.FAILED, message: `max concurrency reached (${this.config.maxConcurrency})` });
            return;
        }
        // A2A v1 semantics (spec §3.4): the contextId identifies the conversation,
        // the taskId a unit of work within it. A known taskId infers its context;
        // a provided contextId that contradicts the referenced task is rejected.
        const knownContext = this.registry.knownContextOf(taskId);
        if (contextId && knownContext && contextId !== knownContext) {
            this.log.warn("intake", `task ${taskId} rejected: contextId ${contextId} does not match the referenced task context ${knownContext}`, taskId);
            await this.reportWith(taskId, contextId, { kind: TASK_EVENT_KINDS.FAILED, message: "contextId does not match the referenced task" });
            return;
        }
        // Per the ClusterLink contract the node generates the conversation context
        // when neither the dispatch nor task history provides one, then echoes it
        // in every subsequent task event so the dispatcher can continue.
        const resolvedContextId = knownContext ?? contextId ?? randomUUID();
        this.registry.begin(taskId, source, resolvedContextId);
        this.log.info("intake", `accepting task ${taskId} (source=${source}, context=${resolvedContextId}${knownContext ? ", inferred" : contextId ? "" : ", generated"})`, taskId);
        // Resolve the target workspace before creating the session (its path
        // becomes the session cwd, which is half of workspace membership).
        const workspace = await resolveWorkspace(this.ctx, this.config, workspaceHint, this.log);
        const cwd = workspace?.path ?? this.config.workspace;
        if (workspace)
            this.log.info("intake", `task ${taskId} -> workspace ${workspace.path}`, taskId);
        this.registry.setRunning(taskId);
        // The DSH session is bound to the conversation (contextId); report the
        // session identity immediately, then acquire the handle inside the
        // per-conversation queue so concurrent dispatches into one context can
        // never create the same session twice.
        const accepted = await this.report(taskId, {
            kind: TASK_EVENT_KINDS.STARTED,
            message: "node accepted the task",
            data: { sessionId: resolvedContextId, source, ...(workspace ? { workspace: workspace.path } : {}) },
        });
        if (!accepted)
            this.log.warn("intake", `started event not delivered (hub offline); task queued`, taskId);
        void this.enqueueRun(resolvedContextId, taskId, source, prompt, cwd, workspace);
    }
    /**
     * Acquire the live handle for a conversation session. Must run inside the
     * per-conversation queue: two dispatches racing into one otherwise-fresh
     * context would both see no handle and create the same session twice.
     */
    async acquireSessionHandle(taskId, sessionKey, cwd, workspace) {
        const existing = this.registry.getHandleBySession(sessionKey);
        if (existing) {
            this.log.info("intake", `task ${taskId} joins existing conversation ${sessionKey}`, taskId);
            return existing;
        }
        const handle = await this.ctx.agents.create({
            sessionId: SessionId(sessionKey),
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
                await workspace.attach(handle.agent.session.id);
            }
            catch (error) {
                this.log.warn("intake", `workspace attach failed for ${taskId}: ${errorMessage(error)}`, taskId);
            }
        }
        return handle;
    }
    /** Report one task event with the record's A2A contextId echoed. */
    async report(taskId, event) {
        return this.reportWith(taskId, this.registry.get(taskId)?.contextId, event);
    }
    async reportWith(taskId, contextId, event) {
        return this.hub.reportTaskEvent({
            ...event,
            taskId,
            ...(contextId ? { contextId } : {}),
            timestampUtc: new Date().toISOString(),
        });
    }
    /**
     * Serialize turns per conversation: concurrent dispatches into one context
     * run their followups strictly in order instead of interleaving on the
     * shared agent/session.
     */
    sessionQueues = new Map();
    enqueueRun(sessionKey, taskId, source, prompt, cwd, workspace) {
        const prev = this.sessionQueues.get(sessionKey) ?? Promise.resolve();
        const next = prev.then(() => this.runTask(sessionKey, taskId, source, prompt, cwd, workspace));
        this.sessionQueues.set(sessionKey, next);
        void next.finally(() => {
            if (this.sessionQueues.get(sessionKey) === next)
                this.sessionQueues.delete(sessionKey);
        });
    }
    async runTask(sessionKey, taskId, source, prompt, cwd, workspace) {
        let handle;
        try {
            handle = await this.acquireSessionHandle(taskId, sessionKey, cwd, workspace);
        }
        catch (error) {
            this.registry.finish(taskId, "error");
            this.registry.archive(taskId, "error", source);
            this.registry.delete(taskId);
            this.counters.failedTasks++;
            const detail = errorMessage(error).slice(0, 300);
            this.log.error("intake", `agent create failed for ${taskId}: ${detail}`, taskId);
            await this.report(taskId, { kind: TASK_EVENT_KINDS.FAILED, message: `agent create failed: ${detail}` });
            return;
        }
        await this.runTurn(sessionKey, taskId, handle, prompt);
    }
    async runTurn(sessionKey, taskId, handle, prompt) {
        const { agent } = handle;
        try {
            await agent.whenIdle();
            const firstSeq = agent.session.seq;
            this.relay.attach(taskId, sessionKey);
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
                await this.report(taskId, {
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
                await this.report(taskId, {
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
            await this.report(taskId, { kind: TASK_EVENT_KINDS.FAILED, message: `execution error: ${detail}` });
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
