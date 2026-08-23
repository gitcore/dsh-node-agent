/**
 * Task intake: dual-channel acceptance (taskDispatched + a2aMessageReceived),
 * normative A2A ID validation, context/task selection, and the serialized
 * run-to-completion driver.
 *
 * Semantics follow A2A v1.0 §3.4 plus the frozen DSH policy in
 * docs/todolist/pending/dsh-a2a-context-session-mapping.md:
 *  - contextId identifies the conversation (1:1 with one DSH session via the
 *    context registry; the dshSessionId is opaque and never derived from an
 *    A2A id);
 *  - taskId identifies one stateful task record inside that context;
 *  - server-owned IDs: unknown taskIds are TaskNotFoundError, unknown
 *    contextIds are rejected without substitute generation, and new tasks get
 *    server-generated taskIds on the A2A channel;
 *  - prompts into one context are strictly serialized (submitted FIFO ->
 *    working -> terminal; input-required holds the queue).
 */
import { randomUUID } from "node:crypto";
import { Message, TaskState as A2aTaskState, TaskStatusUpdateEvent } from "@a2a-js/sdk";
import { SessionId } from "@deepseek-ai/dsh-session";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { TASK_EVENT_KINDS } from "../protocol.js";
import { errorMessage } from "../connection/hub-connection.js";
import { isTerminalState } from "./task-registry.js";
import { summarizeOutcome } from "./task-completion.js";
import { resolveWorkspace } from "./workspace.js";
function contextIdOf(value) {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
/** Official A2A TaskStatusUpdateEvent wire JSON built through the official SDK serializer. */
function statusUpdateEventJson(taskId, contextId, state) {
    const a2aState = {
        submitted: A2aTaskState.TASK_STATE_SUBMITTED,
        working: A2aTaskState.TASK_STATE_WORKING,
        completed: A2aTaskState.TASK_STATE_COMPLETED,
        failed: A2aTaskState.TASK_STATE_FAILED,
        canceled: A2aTaskState.TASK_STATE_CANCELED,
        rejected: A2aTaskState.TASK_STATE_REJECTED,
        "input-required": A2aTaskState.TASK_STATE_INPUT_REQUIRED,
        "auth-required": A2aTaskState.TASK_STATE_AUTH_REQUIRED,
    }[state];
    return TaskStatusUpdateEvent.toJSON(TaskStatusUpdateEvent.fromJSON({ taskId, contextId, status: { state: a2aState } }));
}
export class TaskIntake {
    ctx;
    config;
    registry;
    contexts;
    hub;
    relay;
    log;
    counters;
    selection;
    /** Live agent handles keyed by the confirmed canonical dshSessionId. */
    handles = new Map();
    /** Per-context turn FIFO: prompts into one conversation never interleave. */
    sessionQueues = new Map();
    /** Next prompt per queued task (the context FIFO only carries task ids). */
    pendingTurns = new Map();
    constructor(ctx, config, registry, contexts, hub, relay, log, counters) {
        this.ctx = ctx;
        this.config = config;
        this.registry = registry;
        this.contexts = contexts;
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
        const metadata = payload?.metadata && typeof payload.metadata === "object" ? payload.metadata : undefined;
        void this.accept({
            channel: "taskDispatched",
            requestedTaskId: taskId,
            prompt,
            contextId: contextIdOf(payload.contextId),
            workspaceHint: metadata?.workspace,
            dshSessionHint: contextIdOf(metadata?.sessionId),
            metadata,
        }).catch((error) => {
            // Safety net: an intake bug must degrade to a failed task report,
            // never an unhandled rejection that takes down the host process.
            this.log.error("intake", `taskDispatched accept crashed: ${errorMessage(error)}`, taskId);
        });
    }
    onA2AMessage(envelope) {
        let message;
        try {
            message = Message.fromJSON(envelope?.message);
        }
        catch (error) {
            this.log.error("intake", `invalid A2A message (deliveryId=${envelope?.messageId ?? "?"} from=${envelope?.fromNodeId ?? "?"}): ${errorMessage(error)}`);
            return;
        }
        const prompt = message.parts
            .map((part) => (part.content?.$case === "text" ? part.content.value : ""))
            .join("")
            .trim();
        if (prompt.length === 0) {
            this.log.warn("intake", `a2a message without text parts (deliveryId=${envelope.messageId ?? "?"} from=${envelope.fromNodeId ?? "?"})`);
            return;
        }
        const metadata = message.metadata && typeof message.metadata === "object" ? { ...message.metadata } : {};
        void this.accept({
            channel: "a2a",
            // Server-owned IDs: a client-provided taskId may only REFERENCE an
            // existing task; new tasks always get a server-generated id.
            requestedTaskId: contextIdOf(message.taskId),
            generateTaskId: true,
            prompt,
            contextId: contextIdOf(message.contextId),
            workspaceHint: metadata.workspace,
            metadata: { ...metadata, deliveryId: envelope.messageId, fromNodeId: envelope.fromNodeId },
        }).catch((error) => {
            // Safety net: see onTaskDispatched.
            this.log.error("intake", `a2a accept crashed: ${errorMessage(error)}`);
        });
    }
    // ------------------------------------------------------------------
    // ID resolution (normative A2A rules + frozen DSH policy)
    // ------------------------------------------------------------------
    async accept(request) {
        const { channel, requestedTaskId, prompt } = request;
        if (this.registry.activeCount() >= this.config.maxConcurrency) {
            this.log.warn("intake", `max concurrency (${this.config.maxConcurrency}) reached; rejecting ${requestedTaskId ?? "(new)"}`, requestedTaskId);
            await this.reportWith(requestedTaskId ?? "unknown", request.contextId, { kind: TASK_EVENT_KINDS.FAILED, message: `max concurrency reached (${this.config.maxConcurrency})` });
            return;
        }
        // No taskId on the A2A channel: either continue an existing context with
        // a new server-generated task, or start a brand-new conversation.
        if (requestedTaskId === undefined) {
            if (request.contextId && !this.contexts.has(request.contextId)) {
                // Server-owned context policy: an explicit but unknown contextId
                // cannot be accepted and MUST NOT be replaced by a generated one.
                this.log.warn("intake", `a2a message rejected: unknown contextId ${request.contextId}`);
                await this.reportWith("(unresolved)", request.contextId, { kind: TASK_EVENT_KINDS.FAILED, message: "unknown contextId" });
                return;
            }
            if (request.contextId) {
                const record = this.contexts.get(request.contextId);
                if (!record)
                    return;
                const conflict = this.checkBindingConflicts(record, request);
                if (conflict) {
                    this.log.warn("intake", `a2a message rejected: ${conflict}`, request.contextId);
                    await this.reportWith("(unresolved)", request.contextId, { kind: TASK_EVENT_KINDS.FAILED, message: conflict });
                    return;
                }
                const taskId = randomUUID();
                this.log.info("intake", `a2a continues conversation ${request.contextId} with new task ${taskId}`, taskId);
                this.beginAndQueue(taskId, request.contextId, channel, prompt);
                return;
            }
            return this.startNewContextTask(channel, randomUUID(), request);
        }
        // A live task record is referenced directly.
        const liveRecord = this.registry.get(requestedTaskId);
        if (liveRecord) {
            const contextRecord = this.contexts.get(liveRecord.contextId);
            if (!contextRecord) {
                this.log.error("intake", `task ${requestedTaskId} references missing context ${liveRecord.contextId}; rejecting`, requestedTaskId);
                await this.reportWith(requestedTaskId, liveRecord.contextId, { kind: TASK_EVENT_KINDS.FAILED, message: "task context unavailable" });
                return;
            }
            if (request.contextId && request.contextId !== liveRecord.contextId) {
                this.log.warn("intake", `${channel} task ${requestedTaskId} rejected: contextId ${request.contextId} does not match the referenced task context ${liveRecord.contextId}`, requestedTaskId);
                await this.reportWith(requestedTaskId, request.contextId, { kind: TASK_EVENT_KINDS.FAILED, message: "contextId does not match the referenced task" });
                return;
            }
            const conflict = this.checkBindingConflicts(contextRecord, request);
            if (conflict) {
                this.log.warn("intake", `${channel} task ${requestedTaskId} rejected: ${conflict}`, requestedTaskId);
                await this.reportWith(requestedTaskId, liveRecord.contextId, { kind: TASK_EVENT_KINDS.FAILED, message: conflict });
                return;
            }
            if (liveRecord.state === "input-required") {
                // Only a follow-up on the same taskId continues a held task.
                this.registry.transition(requestedTaskId, "working");
                this.log.info("intake", `task ${requestedTaskId} resumes from input-required`, requestedTaskId);
                this.enqueueRun(liveRecord.contextId, requestedTaskId, prompt);
                return;
            }
            if (!isTerminalState(liveRecord.state)) {
                this.log.warn("intake", `task ${requestedTaskId} is ${liveRecord.state}; rejecting concurrent message`, requestedTaskId);
                await this.reportWith(requestedTaskId, liveRecord.contextId, { kind: TASK_EVENT_KINDS.FAILED, message: `task is ${liveRecord.state}` });
                return;
            }
            // Terminal live record: reject on the coordinator channel; on the A2A
            // channel the conversation continues with a NEW server-generated task.
            if (!request.generateTaskId) {
                this.log.warn("intake", `task ${requestedTaskId} is terminal (${liveRecord.state}); send its contextId ${liveRecord.contextId} to start a new task`, requestedTaskId);
                await this.reportWith(requestedTaskId, liveRecord.contextId, { kind: TASK_EVENT_KINDS.FAILED, message: `task is ${liveRecord.state}; use its contextId to start a new task` });
                return;
            }
            const taskId = randomUUID();
            this.log.info("intake", `${channel} continues conversation ${liveRecord.contextId} with new task ${taskId}`, taskId);
            this.beginAndQueue(taskId, liveRecord.contextId, channel, prompt);
            return;
        }
        // Normative rule: a provided taskId MUST reference an existing task.
        const knownTaskContext = this.registry.knownContextOf(requestedTaskId);
        if (knownTaskContext === undefined) {
            if (!request.generateTaskId) {
                // taskDispatched: the coordinator owns taskId assignment; an unknown
                // id starts a new task under the coordinator-provided identity.
                return this.startNewContextTask(channel, requestedTaskId, request);
            }
            // A2A: unknown taskId is TaskNotFoundError — no replacement task,
            // session, or context may be created.
            this.log.warn("intake", `a2a message references unknown taskId ${requestedTaskId}; rejecting (task not found)`, requestedTaskId);
            await this.reportWith(requestedTaskId, request.contextId, { kind: TASK_EVENT_KINDS.FAILED, message: "task not found" });
            return;
        }
        // The referenced task is terminal (its live record was already removed);
        // the bounded context memory still resolves it. A contradicting explicit
        // contextId MUST be rejected with zero side effects.
        const contextRecord = this.contexts.get(knownTaskContext);
        if (!contextRecord) {
            this.log.error("intake", `task ${requestedTaskId} references missing context ${knownTaskContext}; rejecting`, requestedTaskId);
            await this.reportWith(requestedTaskId, knownTaskContext, { kind: TASK_EVENT_KINDS.FAILED, message: "task context unavailable" });
            return;
        }
        if (request.contextId && request.contextId !== knownTaskContext) {
            this.log.warn("intake", `${channel} task ${requestedTaskId} rejected: contextId ${request.contextId} does not match the referenced task context ${knownTaskContext}`, requestedTaskId);
            await this.reportWith(requestedTaskId, request.contextId, { kind: TASK_EVENT_KINDS.FAILED, message: "contextId does not match the referenced task" });
            return;
        }
        const conflict = this.checkBindingConflicts(contextRecord, request);
        if (conflict) {
            this.log.warn("intake", `${channel} task ${requestedTaskId} rejected: ${conflict}`, requestedTaskId);
            await this.reportWith(requestedTaskId, knownTaskContext, { kind: TASK_EVENT_KINDS.FAILED, message: conflict });
            return;
        }
        if (!request.generateTaskId) {
            this.log.warn("intake", `task ${requestedTaskId} already finished; send its contextId ${knownTaskContext} to start a new task`, requestedTaskId);
            await this.reportWith(requestedTaskId, knownTaskContext, { kind: TASK_EVENT_KINDS.FAILED, message: `task already finished; use its contextId to start a new task` });
            return;
        }
        const taskId = randomUUID();
        this.log.info("intake", `${channel} continues conversation ${knownTaskContext} with new task ${taskId}`, taskId);
        this.beginAndQueue(taskId, knownTaskContext, channel, prompt);
    }
    /** First contact (or a context-less dispatch): create context + task. */
    async startNewContextTask(channel, taskId, request) {
        // Server-owned context policy: an explicit but unknown contextId cannot be
        // accepted and MUST NOT be replaced by a generated one.
        if (request.contextId && !this.contexts.has(request.contextId)) {
            this.log.warn("intake", `${channel} task ${taskId} rejected: unknown contextId ${request.contextId}`, taskId);
            await this.reportWith(taskId, request.contextId, { kind: TASK_EVENT_KINDS.FAILED, message: "unknown contextId" });
            return;
        }
        // Known contextId + new task = conversation continuation: reuse the
        // existing record and its confirmed DSH session instead of calling
        // create() again (it throws "context already exists", whose unhandled
        // rejection used to kill the whole host process → container restart).
        if (request.contextId) {
            const existing = this.contexts.get(request.contextId);
            if (!existing)
                return;
            const knownConflict = this.checkBindingConflicts(existing, request);
            if (knownConflict) {
                this.log.warn("intake", `${channel} task ${taskId} rejected: ${knownConflict}`, taskId);
                await this.reportWith(taskId, request.contextId, { kind: TASK_EVENT_KINDS.FAILED, message: knownConflict });
                return;
            }
            this.log.info("intake", `${channel} continues known context ${request.contextId} with new task ${taskId}`, taskId);
            this.beginAndQueue(taskId, request.contextId, channel, request.prompt);
            return;
        }
        const workspace = await resolveWorkspace(this.ctx, this.config, request.workspaceHint, this.log);
        const cwd = workspace?.path ?? this.config.workspace;
        if (workspace)
            this.log.info("intake", `task ${taskId} -> workspace ${workspace.path}`, taskId);
        // Provisional context record; rolled back if the DSH session never confirms.
        const record = this.contexts.create(request.contextId ?? randomUUID(), { resolved: workspace?.path, hint: typeof request.workspaceHint === "string" ? request.workspaceHint : undefined });
        const contextId = record.contextId;
        this.log.info("intake", `creating context ${contextId}${request.contextId ? "" : " (generated)"}`, taskId);
        try {
            // Creation seed: transport-private hint or an opaque node-generated key
            // — never an A2A id. The canonical dshSessionId is whatever DSH
            // confirms back.
            const seed = request.dshSessionHint ?? randomUUID();
            const handle = await this.ctx.agents.create({
                sessionId: SessionId(seed),
                meta: { cwd },
                agentOptions: this.selection ? { provider: this.selection.provider, model: this.selection.model } : undefined,
                setup: (agentCtx) => {
                    if (this.selection)
                        installModelSelection(agentCtx, { current: this.selection, assembled: void 0 });
                },
            });
            this.handles.set(handle.agent.session.id, handle);
            this.contexts.confirmSession(contextId, handle.agent.session.id);
            if (workspace) {
                try {
                    await workspace.attach(handle.agent.session.id);
                }
                catch (error) {
                    this.log.warn("intake", `workspace attach failed for context ${contextId}: ${errorMessage(error)}`, taskId);
                }
            }
            this.log.info("intake", `context ${contextId} bound to dsh session ${handle.agent.session.id}`, taskId);
        }
        catch (error) {
            this.contexts.deleteIfUnconfirmed(contextId);
            this.counters.failedTasks++;
            const detail = errorMessage(error).slice(0, 300);
            this.log.error("intake", `dsh session create failed for context ${contextId}: ${detail}`, taskId);
            await this.reportWith(taskId, contextId, { kind: TASK_EVENT_KINDS.FAILED, message: `dsh session create failed: ${detail}` });
            return;
        }
        this.beginAndQueue(taskId, contextId, channel, request.prompt);
    }
    /** Shared tail: register the task record, announce it, and queue its turn. */
    beginAndQueue(taskId, contextId, channel, prompt) {
        this.registry.begin(taskId, contextId, channel);
        void this.emitStatus(taskId, "submitted");
        const record = this.registry.get(taskId);
        const dshSessionId = this.contexts.get(contextId)?.dshSessionId;
        void this.reportWith(taskId, contextId, {
            kind: TASK_EVENT_KINDS.STARTED,
            message: "node accepted the task",
            data: { source: channel, state: record?.state, ...(dshSessionId ? { sessionId: dshSessionId } : {}), ...(record ? { createdAt: record.createdAt } : {}) },
        });
        this.contexts.enqueueTask(contextId, taskId);
        this.pendingTurns.set(taskId, prompt);
        this.pump(contextId);
    }
    /** Workspace / private-session binding checks against an existing context. */
    checkBindingConflicts(record, request) {
        if (typeof request.workspaceHint === "string" && record.workspaceHint && request.workspaceHint !== record.workspaceHint) {
            return `workspace conflict: context is bound to ${JSON.stringify(record.workspaceHint)}`;
        }
        if (request.dshSessionHint && record.dshSessionId && request.dshSessionHint !== record.dshSessionId) {
            return "DshSessionMismatch: private sessionId does not match the context session";
        }
        return undefined;
    }
    // ------------------------------------------------------------------
    // Per-context serialized execution
    // ------------------------------------------------------------------
    /** Start the next queued turn unless a task is still active in the context. */
    pump(contextId) {
        const record = this.contexts.get(contextId);
        if (!record || record.activeTaskId)
            return;
        let head = record.queuedTaskIds.shift();
        while (head && !this.registry.get(head))
            head = record.queuedTaskIds.shift();
        if (!head)
            return;
        try {
            this.registry.transition(head, "working");
        }
        catch (error) {
            this.log.error("intake", `task ${head} cannot enter working: ${errorMessage(error)}`, head);
            return;
        }
        this.contexts.setActiveTask(contextId, head);
        void this.emitStatus(head, "working");
        const prompt = this.pendingTurns.get(head) ?? "";
        this.pendingTurns.delete(head);
        void this.executeTurn(contextId, head, prompt);
    }
    enqueueRun(contextId, taskId, prompt) {
        const prev = this.sessionQueues.get(contextId) ?? Promise.resolve();
        const next = prev.then(() => this.executeTurn(contextId, taskId, prompt));
        this.sessionQueues.set(contextId, next);
        void next.finally(() => {
            if (this.sessionQueues.get(contextId) === next)
                this.sessionQueues.delete(contextId);
        });
    }
    async executeTurn(contextId, taskId, prompt) {
        const record = this.registry.get(taskId);
        const context = this.contexts.get(contextId);
        if (!record || !context)
            return;
        try {
            const handle = await this.acquireSessionHandle(context.dshSessionId);
            const { agent } = handle;
            await agent.whenIdle();
            const firstSeq = agent.session.seq;
            agent.followup(createUserMessage({ content: [{ type: "text", text: prompt }], source: { kind: "user" } }));
            await agent.whenIdle();
            await this.ctx.sessions.flush(agent.session);
            const outcome = summarizeOutcome(agent.session.events, firstSeq);
            if (outcome.finishReason === "blocked") {
                // input-required holds the queue: the same taskId must be continued.
                this.registry.transition(taskId, "input-required");
                await this.emitStatus(taskId, "input-required");
                await this.report(taskId, { kind: TASK_EVENT_KINDS.PROGRESS, message: "waiting for input", data: { state: "input-required" } });
                this.log.info("intake", `task ${taskId} waits for input; queue held`, taskId);
                return;
            }
            const state = outcome.finishReason === "completed" ? "completed" : "failed";
            this.settle(taskId, state, outcome.text, outcome.errorCode, outcome.errorMessage);
        }
        catch (error) {
            const detail = errorMessage(error).slice(0, 300);
            this.log.error("intake", `task ${taskId} crashed: ${detail}`, taskId);
            this.settle(taskId, "failed", undefined, "execution-error", detail);
        }
        finally {
            const latest = this.registry.get(taskId);
            if (!latest || isTerminalState(latest.state)) {
                // Terminal records leave the live map (bounded); the context memory
                // keeps taskId -> contextId for later inference. input-required tasks
                // stay live and keep holding the conversation.
                if (latest)
                    this.registry.delete(taskId);
                if (context.activeTaskId === taskId) {
                    context.activeTaskId = null;
                    this.pump(contextId);
                }
            }
            void this.enforceIdleCap();
        }
    }
    settle(taskId, state, finalResponse, errorCode, errorMessageText) {
        const source = this.registry.get(taskId)?.source ?? "taskDispatched";
        try {
            this.registry.transition(taskId, state);
        }
        catch (error) {
            this.log.error("intake", `task ${taskId} terminal transition failed: ${errorMessage(error)}`, taskId);
            return;
        }
        this.registry.setResult(taskId, { finishReason: state === "completed" ? "completed" : "error", ...(finalResponse ? { finalResponse } : {}), ...(errorCode ? { errorCode } : {}), ...(errorMessageText ? { errorMessage: errorMessageText.slice(0, 300) } : {}) });
        this.registry.archive(taskId, state, finalResponse);
        if (state === "completed")
            this.counters.processedTasks++;
        else
            this.counters.failedTasks++;
        void this.emitStatus(taskId, state);
        if (state === "completed") {
            const text = finalResponse ?? "";
            this.log.info("intake", `task ${taskId} completed`, taskId);
            void this.report(taskId, { kind: TASK_EVENT_KINDS.COMPLETED, message: "task completed", data: { finalResponse: text, finishReason: "completed" } });
        }
        else {
            this.log.warn("intake", `task ${taskId} finished with state=${state}`, taskId);
            void this.report(taskId, {
                kind: TASK_EVENT_KINDS.FAILED,
                data: { state, errorCode: errorCode ?? null, errorMessage: errorMessageText?.slice(0, 300) ?? null },
            });
        }
    }
    /** Announce an A2A state transition as an official TaskStatusUpdateEvent. */
    async emitStatus(taskId, state) {
        const record = this.registry.get(taskId);
        if (!record)
            return;
        await this.hub.reportTaskEvent({
            taskId,
            contextId: record.contextId,
            kind: "a2a.status-update",
            data: statusUpdateEventJson(taskId, record.contextId, state),
            timestampUtc: new Date().toISOString(),
        });
    }
    async acquireSessionHandle(dshSessionId) {
        const existing = this.handles.get(dshSessionId);
        if (existing)
            return existing;
        // Recreate on the CONFIRMED canonical session id (continuation of the
        // persisted conversation log); never on an A2A-derived value.
        const handle = await this.ctx.agents.create({ sessionId: SessionId(dshSessionId) });
        this.handles.set(dshSessionId, handle);
        return handle;
    }
    /** Report one task event with the record's A2A contextId echoed. */
    async report(taskId, event) {
        return this.reportWith(taskId, this.registry.knownContextOf(taskId), event);
    }
    async reportWith(taskId, contextId, event) {
        return this.hub.reportTaskEvent({
            ...event,
            taskId,
            ...(contextId ? { contextId } : {}),
            timestampUtc: new Date().toISOString(),
        });
    }
    /** Dispose idle conversation handles beyond the cap, oldest first. */
    async enforceIdleCap() {
        try {
            const keep = Math.max(this.config.maxConcurrency * 3, 6);
            const busy = new Set();
            for (const context of this.contexts.list()) {
                if (context.activeTaskId || context.queuedTaskIds.length > 0)
                    busy.add(context.dshSessionId);
            }
            const disposed = [];
            for (const [dshSessionId, handle] of [...this.handles]) {
                if (busy.has(dshSessionId))
                    continue;
                if (this.handles.size - disposed.length <= keep)
                    break;
                try {
                    await handle.dispose();
                }
                catch {
                    /* ignore */
                }
                this.handles.delete(dshSessionId);
                disposed.push(dshSessionId);
            }
            for (const dshSessionId of disposed)
                this.log.info("intake", `disposed idle conversation session ${dshSessionId} (cap ${keep})`);
        }
        catch (error) {
            this.log.warn("intake", `idle-cap enforcement failed: ${errorMessage(error)}`);
        }
    }
    /** Stop and dispose every live conversation handle (plugin unload). */
    async disposeAll() {
        const handles = [...this.handles.values()];
        this.handles.clear();
        for (const handle of handles) {
            try {
                handle.agent.cancel({ kind: "disposed" });
            }
            catch {
                /* ignore */
            }
            try {
                await handle.dispose();
            }
            catch {
                /* ignore */
            }
        }
    }
}
