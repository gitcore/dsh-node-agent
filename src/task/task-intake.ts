/**
 * Task intake: accepts only v2 ClusterLink payload envelopes carrying DSH A2A messages,
 * normative A2A ID validation, context/task selection, and the serialized
 * run-to-completion driver.
 *
 * Semantics follow A2A v1.0 §3.4 plus the frozen DSH policy in
 * docs/todolist/pending/02-agent-user-clusterlink-inbox-consumer.md:
 *  - contextId is the sole persisted A2A conversation identifier;
 *  - DSH/SignalR runtime sessions are transient and never participate in
 *    conversation identity, recovery, or payload correlation;
 *  - taskId identifies one stateful task record inside that context;
 *  - server-owned IDs: unknown taskIds are TaskNotFoundError; a supplied
 *    contextId is rehydrated after a node restart without recreating any
 *    runtime session; and new tasks get server-generated taskIds on the A2A
 *    channel;
 *  - prompts into one context are strictly serialized (submitted FIFO ->
 *    working -> terminal); payload dispatches cannot hold input-required.
 */
import { randomUUID } from "node:crypto";
import { Message, TaskState as A2aTaskState, TaskStatusUpdateEvent } from "@a2a-js/sdk";
import type { Context } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { installModelSelection, type AgentHandle, type ModelSelection } from "@deepseek-ai/dsh-agent";
import type { A2AMessage, ClusterLinkPayloadEnvelope, PluginConfig } from "../protocol.js";
import { errorMessage, type HubConnectionManager } from "../connection/hub-connection.js";
import { ContextRegistry } from "./context-registry.js";
import { isTerminalState, type TaskSource, type TaskState, type TaskRegistry } from "./task-registry.js";
import type { EventRelay } from "../events/event-relay.js";
import type { Logger } from "../services/log-buffer.js";
import { summarizeOutcome } from "./task-completion.js";
import { resolveWorkspace, type WorkspaceTarget } from "./workspace.js";

export interface IntakeCounters {
  processedTasks: number;
  failedTasks: number;
}

interface DefaultModelService {
  currentSelection?: () => ModelSelection;
}

type StatusReport = { kind: string; message?: string };
const STATUS_REPORTS = { FAILED: "failed" } as const;

function contextIdOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Stable semantic request encoding; timestamp/id are deliberately excluded. */
function canonicalRequestSignature(envelope: ClusterLinkPayloadEnvelope): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, item]) => item !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, normalize(item)]),
      );
    }
    return value;
  };
  return JSON.stringify(normalize({
    toNodeId: envelope.toNodeId,
    correlationId: envelope.correlationId ?? null,
    payloadType: envelope.payloadType,
    // sessionId is intentionally excluded. It is a reserved DSH extension
    // field with no current behavior, so changing it cannot make a duplicate
    // ClusterLink dispatch conflict with its authoritative request.
    payload: {
      workspace: envelope.payload.workspace,
      a2a: envelope.payload.a2a,
    },
  }));
}

/** Official A2A TaskStatusUpdateEvent wire JSON built through the official SDK serializer. */
function statusUpdateEventJson(taskId: string, contextId: string, state: TaskState, messageText?: string): Record<string, unknown> {
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
  // Terminal/blocking states carry the surfaced text in status.message so the
  // server can persist an Agent reply (completed) or a failure reason (failed /
  // input-required). Per A2A, a message requires an id: the server no longer
  // fabricates one, so a status.message without messageId is rejected. The id
  // is unique per emission (taskId:state:uuid), never derived from DSH private
  // session ids. Non-terminal states (working/submitted) carry no message.
  const status: { state: number; message?: { role: string; messageId: string; parts: Array<{ text: string }> } } = { state: a2aState };
  if (messageText) {
    status.message = {
      role: "ROLE_AGENT",
      messageId: `${taskId}:${state}:${randomUUID()}`,
      parts: [{ text: messageText }],
    };
  }
  return TaskStatusUpdateEvent.toJSON(TaskStatusUpdateEvent.fromJSON({ taskId, contextId, status })) as Record<string, unknown>;
}

export class TaskIntake {
  private readonly selection: ModelSelection | undefined;
  /** Live agent handles keyed by A2A contextId. */
  private readonly handles = new Map<string, AgentHandle>();
  /** Runtime agent ids are callback-routing details only; never persisted. */
  private readonly contextByRuntimeAgentId = new Map<string, string>();
  /** Per-context turn FIFO: prompts into one conversation never interleave. */
  private readonly sessionQueues = new Map<string, Promise<void>>();
  /** Next prompt per queued task (the context FIFO only carries task ids). */
  private readonly pendingTurns = new Map<string, string>();

  constructor(
    private readonly ctx: Context,
    private readonly config: PluginConfig,
    private readonly registry: TaskRegistry,
    private readonly contexts: ContextRegistry,
    private readonly hub: HubConnectionManager,
    private readonly relay: EventRelay,
    private readonly log: Logger,
    private readonly counters: IntakeCounters,
  ) {
    try {
      const service = ctx.get("agentDefaultModel") as DefaultModelService | undefined;
      this.selection = typeof service?.currentSelection === "function" ? service.currentSelection() : undefined;
    } catch {
      this.selection = undefined;
    }
  }

  onPayloadDispatched(envelope: ClusterLinkPayloadEnvelope): void {
    const correlationId = contextIdOf(envelope?.id);
    if (envelope?.payloadType !== "dsh.a2a.message" || !correlationId || !envelope.payload?.a2a) {
      this.log.warn("intake", "invalid dsh.a2a.message payload");
      return;
    }
    let message: A2AMessage;
    try {
      message = Message.fromJSON(envelope.payload.a2a as never);
    } catch (error) {
      this.log.error("intake", `invalid A2A message (dispatchId=${envelope.id}): ${errorMessage(error)}`);
      return;
    }
    const prompt = message.parts
      .map((part) => (part.content?.$case === "text" ? part.content.value : ""))
      .join("")
      .trim();
    if (prompt.length === 0) {
      this.log.warn("intake", `a2a message without text parts (dispatchId=${envelope.id})`);
      return;
    }
    this.log.info("intake", `dispatch ${envelope.id} contextId=${JSON.stringify(contextIdOf(message.contextId))} workspaceHint=${JSON.stringify(envelope.payload.workspace ?? null)}`);

    const claim = this.registry.claimDispatch(correlationId, canonicalRequestSignature(envelope));
    if (claim.kind === "duplicate-active") {
      this.log.info("intake", `duplicate active outer dispatch ${correlationId} ignored; original task remains authoritative`, claim.taskId ?? correlationId);
      return;
    }
    if (claim.kind === "duplicate-terminal") {
      this.log.info("intake", `duplicate terminal outer dispatch ${correlationId}; replaying the recorded terminal return`, correlationId);
      void this.hub.reportPayload(claim.terminalEnvelope).catch((error) => {
        this.log.error("intake", `terminal replay failed: ${errorMessage(error)}`, correlationId);
      });
      return;
    }
    if (claim.kind === "conflict") {
      // A wire-level terminal report under this correlation would be
      // indistinguishable from the original request's outcome. Reject loudly
      // in node logs and preserve the original active/terminal result.
      this.log.error("intake", `outer dispatch correlation conflict rejected: ${correlationId} was reused with different request data`, correlationId);
      return;
    }
    if (claim.kind === "capacity-exhausted") {
      this.log.error("intake", `outer dispatch ${correlationId} rejected: idempotency ledger is full of active entries`, correlationId);
      return;
    }
    const request = {
      channel: "payload",
      requestedTaskId: contextIdOf(message.taskId),
      generateTaskId: true,
      prompt,
      contextId: contextIdOf(message.contextId),
      workspaceHint: envelope.payload.workspace,
      correlationId,
    } satisfies Parameters<TaskIntake["accept"]>[0];
    void this.accept(request).catch(async (error) => {
      const detail = errorMessage(error).slice(0, 300);
      this.log.error("intake", `payload accept crashed: ${detail}`, envelope.id);
      try {
        // An accepted outer dispatch must never remain permanently active.
        // The reply carries the A2A context only. The reserved payload
        // sessionId field is never used as recovery state.
        await this.reportWith(
          request.requestedTaskId ?? "(unresolved)",
          request.contextId,
          { kind: STATUS_REPORTS.FAILED, message: `payload accept failed: ${detail}` },
          correlationId,
        );
      } catch (reportError) {
        // If the original path already sealed a terminal envelope, preserve it
        // instead of attempting to replace the authoritative outcome.
        this.log.error("intake", `payload accept failure could not be reported: ${errorMessage(reportError)}`, envelope.id);
      }
    });
  }

  // ------------------------------------------------------------------
  // ID resolution (normative A2A rules + frozen DSH policy)
  // ------------------------------------------------------------------

  private async accept(request: {
    channel: TaskSource;
    requestedTaskId?: string;
    generateTaskId?: boolean;
    prompt: string;
    contextId?: string;
    workspaceHint?: unknown;
    correlationId: string;
  }): Promise<void> {
    const { channel, requestedTaskId, prompt } = request;

    if (this.registry.activeCount() >= this.config.maxConcurrency) {
      this.log.warn("intake", `max concurrency (${this.config.maxConcurrency}) reached; rejecting ${requestedTaskId ?? "(new)"}`, requestedTaskId);
      await this.reportWith(requestedTaskId ?? "unknown", request.contextId, { kind: STATUS_REPORTS.FAILED, message: `max concurrency reached (${this.config.maxConcurrency})` }, request.correlationId);
      return;
    }

    // No taskId on the A2A channel: either continue an existing context with
    // a new server-generated task, or start a brand-new conversation.
    if (requestedTaskId === undefined) {
      if (request.contextId && !this.contexts.has(request.contextId)) {
        // A node restart loses only runtime handles. The durable A2A context
        // is recreated locally without attempting to recover a SignalR/DSH
        // session or consulting the reserved payload.sessionId field.
        this.contexts.restore(request.contextId, {
          resolved: undefined,
          hint: typeof request.workspaceHint === "string" ? request.workspaceHint : undefined,
        });
      }
      if (request.contextId) {
        const record = this.contexts.get(request.contextId);
        if (!record) return;
        const conflict = this.checkBindingConflicts(record, request);
        if (conflict) {
          this.log.warn("intake", `a2a message rejected: ${conflict}`, request.contextId);
          await this.reportWith("(unresolved)", request.contextId, { kind: STATUS_REPORTS.FAILED, message: conflict }, request.correlationId);
          return;
        }
        const taskId = randomUUID();
        this.log.info("intake", `a2a continues conversation ${request.contextId} with new task ${taskId}`, taskId);
        this.beginAndQueue(taskId, request.contextId, channel, prompt, request.correlationId);
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
        await this.reportWith(requestedTaskId, liveRecord.contextId, { kind: STATUS_REPORTS.FAILED, message: "task context unavailable" }, request.correlationId);
        return;
      }
      if (request.contextId && request.contextId !== liveRecord.contextId) {
        this.log.warn("intake", `${channel} task ${requestedTaskId} rejected: contextId ${request.contextId} does not match the referenced task context ${liveRecord.contextId}`, requestedTaskId);
        await this.reportWith(requestedTaskId, request.contextId, { kind: STATUS_REPORTS.FAILED, message: "contextId does not match the referenced task" }, request.correlationId);
        return;
      }
      const conflict = this.checkBindingConflicts(contextRecord, request);
      if (conflict) {
        this.log.warn("intake", `${channel} task ${requestedTaskId} rejected: ${conflict}`, requestedTaskId);
        await this.reportWith(requestedTaskId, liveRecord.contextId, { kind: STATUS_REPORTS.FAILED, message: conflict }, request.correlationId);
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
        await this.reportWith(requestedTaskId, liveRecord.contextId, { kind: STATUS_REPORTS.FAILED, message: `task is ${liveRecord.state}` }, request.correlationId);
        return;
      }
      // Terminal live record: reject on the coordinator channel; on the A2A
      // channel the conversation continues with a NEW server-generated task.
      if (!request.generateTaskId) {
        this.log.warn("intake", `task ${requestedTaskId} is terminal (${liveRecord.state}); send its contextId ${liveRecord.contextId} to start a new task`, requestedTaskId);
        await this.reportWith(requestedTaskId, liveRecord.contextId, { kind: STATUS_REPORTS.FAILED, message: `task is ${liveRecord.state}; use its contextId to start a new task` }, request.correlationId);
        return;
      }
      const taskId = randomUUID();
      this.log.info("intake", `${channel} continues conversation ${liveRecord.contextId} with new task ${taskId}`, taskId);
      this.beginAndQueue(taskId, liveRecord.contextId, channel, prompt, request.correlationId);
      return;
    }

    // Normative rule: a provided taskId MUST reference an existing task.
    const knownTaskContext = this.registry.knownContextOf(requestedTaskId);
    if (knownTaskContext === undefined) {
      if (!request.generateTaskId) {
        // The coordinator owns taskId assignment; an unknown
        // id starts a new task under the coordinator-provided identity.
        return this.startNewContextTask(channel, requestedTaskId, request);
      }
      // A2A: unknown taskId is TaskNotFoundError — no replacement task,
      // session, or context may be created.
      this.log.warn("intake", `a2a message references unknown taskId ${requestedTaskId}; rejecting (task not found)`, requestedTaskId);
      await this.reportWith(requestedTaskId, request.contextId, { kind: STATUS_REPORTS.FAILED, message: "task not found" }, request.correlationId);
      return;
    }

    // The referenced task is terminal (its live record was already removed);
    // the bounded context memory still resolves it. A contradicting explicit
    // contextId MUST be rejected with zero side effects.
    const contextRecord = this.contexts.get(knownTaskContext);
    if (!contextRecord) {
      this.log.error("intake", `task ${requestedTaskId} references missing context ${knownTaskContext}; rejecting`, requestedTaskId);
      await this.reportWith(requestedTaskId, knownTaskContext, { kind: STATUS_REPORTS.FAILED, message: "task context unavailable" }, request.correlationId);
      return;
    }
    if (request.contextId && request.contextId !== knownTaskContext) {
      this.log.warn("intake", `${channel} task ${requestedTaskId} rejected: contextId ${request.contextId} does not match the referenced task context ${knownTaskContext}`, requestedTaskId);
      await this.reportWith(requestedTaskId, request.contextId, { kind: STATUS_REPORTS.FAILED, message: "contextId does not match the referenced task" }, request.correlationId);
      return;
    }
    const conflict = this.checkBindingConflicts(contextRecord, request);
    if (conflict) {
      this.log.warn("intake", `${channel} task ${requestedTaskId} rejected: ${conflict}`, requestedTaskId);
      await this.reportWith(requestedTaskId, knownTaskContext, { kind: STATUS_REPORTS.FAILED, message: conflict }, request.correlationId);
      return;
    }
    if (!request.generateTaskId) {
      this.log.warn("intake", `task ${requestedTaskId} already finished; send its contextId ${knownTaskContext} to start a new task`, requestedTaskId);
      await this.reportWith(requestedTaskId, knownTaskContext, { kind: STATUS_REPORTS.FAILED, message: `task already finished; use its contextId to start a new task` }, request.correlationId);
      return;
    }
    const taskId = randomUUID();
    this.log.info("intake", `${channel} continues conversation ${knownTaskContext} with new task ${taskId}`, taskId);
    this.beginAndQueue(taskId, knownTaskContext, channel, prompt, request.correlationId);
  }

  /** First contact (or a context-less dispatch): create context + task. */
  private async startNewContextTask(channel: TaskSource, taskId: string, request: { prompt: string; contextId?: string; workspaceHint?: unknown; correlationId: string }): Promise<void> {
    // Server-owned context policy: an explicit but unknown contextId cannot be
    // accepted and MUST NOT be replaced by a generated one.
    if (request.contextId && !this.contexts.has(request.contextId)) {
      this.log.warn("intake", `${channel} task ${taskId} rejected: unknown contextId ${request.contextId}`, taskId);
      await this.reportWith(taskId, request.contextId, { kind: STATUS_REPORTS.FAILED, message: "unknown contextId" }, request.correlationId);
      return;
    }

    // Known contextId + new task reuses only the A2A conversation identity.
    if (request.contextId) {
      const existing = this.contexts.get(request.contextId);
      if (!existing) return;
      const knownConflict = this.checkBindingConflicts(existing, request);
      if (knownConflict) {
        this.log.warn("intake", `${channel} task ${taskId} rejected: ${knownConflict}`, taskId);
        await this.reportWith(taskId, request.contextId, { kind: STATUS_REPORTS.FAILED, message: knownConflict }, request.correlationId);
        return;
      }
      this.log.info("intake", `${channel} continues known context ${request.contextId} with new task ${taskId}`, taskId);
      this.beginAndQueue(taskId, request.contextId, channel, request.prompt, request.correlationId);
      return;
    }

    const workspace = await resolveWorkspace(this.ctx, this.config, request.workspaceHint, this.log);
    const cwd = workspace?.path ?? this.config.workspace;
    if (workspace) this.log.info("intake", `task ${taskId} -> workspace ${workspace.path}`, taskId);

    // Provisional context record; rolled back if a transient runtime handle
    // cannot be created. Its runtime id never leaves this process.
    const record = this.contexts.create(request.contextId ?? randomUUID(), { resolved: workspace?.path, hint: typeof request.workspaceHint === "string" ? request.workspaceHint : undefined });
    const contextId = record.contextId;
    this.log.info("intake", `creating context ${contextId}${request.contextId ? "" : " (generated)"}`, taskId);
    try {
      const handle = await this.acquireSessionHandle(contextId, cwd);
      if (workspace) {
        try {
          await workspace.attach(handle.agent.session.id);
        } catch (error) {
          this.log.warn("intake", `workspace attach failed for context ${contextId}: ${errorMessage(error)}`, taskId);
        }
      }
      this.log.info("intake", `context ${contextId} started with a transient runtime handle`, taskId);
    } catch (error) {
      this.contexts.delete(contextId);
      this.counters.failedTasks++;
      const detail = errorMessage(error).slice(0, 300);
      this.log.error("intake", `runtime handle create failed for context ${contextId}: ${detail}`, taskId);
      await this.reportWith(taskId, contextId, { kind: STATUS_REPORTS.FAILED, message: `runtime handle create failed: ${detail}` }, request.correlationId);
      return;
    }

    this.beginAndQueue(taskId, contextId, channel, request.prompt, request.correlationId);
  }

  /** Shared tail: register the task record, announce it, and queue its turn. */
  private beginAndQueue(taskId: string, contextId: string, channel: TaskSource, prompt: string, correlationId: string): void {
    this.registry.bindDispatch(correlationId, taskId, contextId);
    this.registry.begin(taskId, contextId, channel, correlationId);
    void this.emitStatus(taskId, "submitted");
    this.contexts.enqueueTask(contextId, taskId);
    this.pendingTurns.set(taskId, prompt);
    this.pump(contextId);
  }

  /** Workspace binding checks against an existing context. */
  private checkBindingConflicts(record: { workspaceHint?: string }, request: { workspaceHint?: unknown }): string | undefined {
    if (typeof request.workspaceHint === "string" && record.workspaceHint && request.workspaceHint !== record.workspaceHint) {
      return `workspace conflict: context is bound to ${JSON.stringify(record.workspaceHint)}`;
    }
    return undefined;
  }

  // ------------------------------------------------------------------
  // Per-context serialized execution
  // ------------------------------------------------------------------

  /** Start the next queued turn unless a task is still active in the context. */
  private pump(contextId: string): void {
    const record = this.contexts.get(contextId);
    if (!record || record.activeTaskId) return;
    let head = record.queuedTaskIds.shift();
    while (head && !this.registry.get(head)) head = record.queuedTaskIds.shift();
    if (!head) return;
    try {
      this.registry.transition(head, "working");
    } catch (error) {
      this.log.error("intake", `task ${head} cannot enter working: ${errorMessage(error)}`, head);
      return;
    }
    this.contexts.setActiveTask(contextId, head);
    void this.emitStatus(head, "working");
    const prompt = this.pendingTurns.get(head) ?? "";
    this.pendingTurns.delete(head);
    void this.executeTurn(contextId, head, prompt);
  }

  private enqueueRun(contextId: string, taskId: string, prompt: string): void {
    const prev = this.sessionQueues.get(contextId) ?? Promise.resolve();
    const next = prev.then(() => this.executeTurn(contextId, taskId, prompt));
    this.sessionQueues.set(contextId, next);
    void next.finally(() => {
      if (this.sessionQueues.get(contextId) === next) this.sessionQueues.delete(contextId);
    });
  }

  private async executeTurn(contextId: string, taskId: string, prompt: string): Promise<void> {
    const record = this.registry.get(taskId);
    const context = this.contexts.get(contextId);
    if (!record || !context) return;
    try {
      // The workspace hint is only resolved in startNewContextTask (first
      // contact, no contextId). A continuing dispatch carries a contextId, and
      // after a restart the context is restored with the immutable hint but no
      // resolved workspace — so the session would otherwise land in the default
      // workspace ("未分组"). Resolve the hint once here, cache the path, and
      // attach the session so it groups under the workspace.
      let workspacePath = context.workspace;
      let workspace: WorkspaceTarget | undefined;
      if (!workspacePath && context.workspaceHint) {
        workspace = await resolveWorkspace(this.ctx, this.config, context.workspaceHint, this.log);
        if (workspace) {
          workspacePath = workspace.path;
          context.workspace = workspacePath;
        }
      }
      const handle = await this.acquireSessionHandle(contextId, workspacePath ?? this.config.workspace);
      if (workspace) {
        try {
          await workspace.attach(handle.agent.session.id);
        } catch (error) {
          this.log.warn("intake", `workspace attach failed for context ${contextId}: ${errorMessage(error)}`, taskId);
        }
      }
      const { agent } = handle;
      await agent.whenIdle();
      const firstSeq = agent.session.seq;
      agent.followup(createUserMessage({ content: [{ type: "text", text: prompt }], source: { kind: "user" } }));
      await agent.whenIdle();
      await this.ctx.sessions.flush(agent.session);

      const outcome = summarizeOutcome(agent.session.snapshotEvents(), firstSeq);
      if (outcome.finishReason === "blocked") {
        // ClusterLink payload dispatches are one-shot ChatPush messages. A
        // later message has a new outer correlation and no prior taskId, so an
        // input-required hold could never be resumed and would deadlock the
        // context queue. Surface it as a terminal failure and release the
        // context; interactive transports may introduce held-task semantics at
        // their own boundary in the future.
        this.settle(
          taskId,
          "failed",
          undefined,
          "input-required-unsupported",
          "agent requested additional input, but ClusterLink payload messages do not support resuming a held task",
        );
        return;
      }
      const state: TaskState = outcome.finishReason === "completed" ? "completed" : "failed";
      this.settle(taskId, state, outcome.text, outcome.errorCode, outcome.errorMessage);
    } catch (error) {
      const detail = errorMessage(error).slice(0, 300);
      this.log.error("intake", `task ${taskId} crashed: ${detail}`, taskId);
      this.settle(taskId, "failed", undefined, "execution-error", detail);
    } finally {
      const latest = this.registry.get(taskId);
      if (!latest || isTerminalState(latest.state)) {
        // Terminal records leave the live map (bounded); the context memory
        // keeps taskId -> contextId for later inference. input-required tasks
        // stay live and keep holding the conversation.
        if (latest) this.registry.delete(taskId);
        if (context.activeTaskId === taskId) {
          context.activeTaskId = null;
          this.pump(contextId);
        }
      }
      void this.enforceIdleCap();
    }
  }

  private settle(taskId: string, state: TaskState, finalResponse?: string, errorCode?: string, errorMessageText?: string): void {
    const source = this.registry.get(taskId)?.source ?? "payload";
    try {
      this.registry.transition(taskId, state);
    } catch (error) {
      this.log.error("intake", `task ${taskId} terminal transition failed: ${errorMessage(error)}`, taskId);
      return;
    }
    this.registry.setResult(taskId, { finishReason: state === "completed" ? "completed" : "error", ...(finalResponse ? { finalResponse } : {}), ...(errorCode ? { errorCode } : {}), ...(errorMessageText ? { errorMessage: errorMessageText.slice(0, 300) } : {}) });
    this.registry.archive(taskId, state, finalResponse);
    if (state === "completed") this.counters.processedTasks++;
    else this.counters.failedTasks++;
    if (state === "completed") {
      // Reply text rides in the official A2A status.message so the server can
      // persist an Agent chat reply from the channel it consumes. The legacy
      // started/completed/failed scheduling events are deprecated for new nodes.
      const text = finalResponse ?? "";
      void this.emitStatus(taskId, state, text);
      this.log.info("intake", `task ${taskId} completed`, taskId);
    } else {
      // Terminal failure also carries a status.message per the A2A contract.
      const failureText = errorMessageText?.trim() || `task ${taskId} failed`;
      void this.emitStatus(taskId, state, failureText);
      this.log.warn("intake", `task ${taskId} finished with state=${state}`, taskId);
    }
  }

  /** Announce an A2A state transition as an official TaskStatusUpdateEvent. */
  private async emitStatus(taskId: string, state: TaskState, messageText?: string): Promise<void> {
    const record = this.registry.get(taskId);
    if (!record) return;
    const context = this.contexts.get(record.contextId);
    const envelope: ClusterLinkPayloadEnvelope = {
      id: randomUUID(),
      toNodeId: "server",
      correlationId: record.correlationId,
      payloadType: "dsh.a2a.task-status-update",
      payload: {
        a2a: statusUpdateEventJson(taskId, record.contextId, state, messageText),
      },
      timestampUtc: new Date().toISOString(),
    };
    if (isTerminalState(state)) this.registry.completeDispatch(record.correlationId, envelope);
    await this.hub.reportPayload(envelope);
  }

  private async acquireSessionHandle(contextId: string, cwd: string): Promise<AgentHandle> {
    const existing = this.handles.get(contextId);
    if (existing) return existing;
    const handle = await this.ctx.agents.create({
      sessionId: SessionId(randomUUID()),
      meta: { cwd },
      agentOptions: this.selection ? { provider: this.selection.provider, model: this.selection.model } : undefined,
      setup: (agentCtx) => {
        if (this.selection) installModelSelection(agentCtx, { current: this.selection, assembled: void 0 });
      },
    });
    this.handles.set(contextId, handle);
    this.contextByRuntimeAgentId.set(handle.agent.session.id, contextId);
    return handle;
  }

  /** Used only by EventRelay for transient local callback attribution. */
  contextIdForRuntimeAgent(runtimeAgentId: string): string | undefined {
    return this.contextByRuntimeAgentId.get(runtimeAgentId);
  }

  /** Report one task event with the record's A2A contextId echoed. */
  private async report(taskId: string, event: StatusReport): Promise<boolean> {
    return this.reportWith(taskId, this.registry.knownContextOf(taskId), event);
  }

  private async reportWith(
    taskId: string,
    contextId: string | undefined,
    event: StatusReport,
    fallbackCorrelationId?: string,
  ): Promise<boolean> {
    const record = this.registry.get(taskId);
    const correlationId = record?.correlationId ?? fallbackCorrelationId;
    if (!correlationId) {
      this.log.warn("intake", `cannot report ${event.kind}: no established DSH task correlation`, taskId);
      return false;
    }
    // The official C# A2A SDK requires a non-empty contextId. Reuse a
    // supplied/generated A2A context when available; otherwise create an
    // opaque response-only context ID. It is never derived from a runtime
    // connection or the reserved payload.sessionId field.
    const reportContextId = contextId ?? randomUUID();
    // Rejection-only IDs make a standards-shaped A2A failure event but are
    // never registered as a task or context and cannot execute any work.
    const reportTaskId = taskId === "unknown" || taskId === "(unresolved)" ? randomUUID() : taskId;
    const envelope: ClusterLinkPayloadEnvelope = {
      id: randomUUID(),
      toNodeId: "server",
      correlationId,
      payloadType: "dsh.a2a.task-status-update",
      payload: {
        a2a: statusUpdateEventJson(reportTaskId, reportContextId, "failed", event.message),
      },
      timestampUtc: new Date().toISOString(),
    };
    this.registry.completeDispatch(correlationId, envelope);
    return this.hub.reportPayload(envelope);
  }

  /** Dispose idle conversation handles beyond the cap, oldest first. */
  private async enforceIdleCap(): Promise<void> {
    try {
      const keep = Math.max(this.config.maxConcurrency * 3, 6);
      const busy = new Set<string>();
      for (const context of this.contexts.list()) {
        if (context.activeTaskId || context.queuedTaskIds.length > 0) busy.add(context.contextId);
      }
      const disposed: string[] = [];
      for (const [contextId, handle] of [...this.handles]) {
        if (busy.has(contextId)) continue;
        if (this.handles.size - disposed.length <= keep) break;
        try {
          await handle.dispose();
        } catch {
          /* ignore */
        }
        this.handles.delete(contextId);
        this.contextByRuntimeAgentId.delete(handle.agent.session.id);
        disposed.push(contextId);
      }
      for (const contextId of disposed) this.log.info("intake", `disposed idle runtime handle for context ${contextId} (cap ${keep})`);
    } catch (error) {
      this.log.warn("intake", `idle-cap enforcement failed: ${errorMessage(error)}`);
    }
  }

  /** Stop and dispose every live conversation handle (plugin unload). */
  async disposeAll(): Promise<void> {
    const handles = [...this.handles.values()];
    this.handles.clear();
    this.contextByRuntimeAgentId.clear();
    for (const handle of handles) {
      try {
        handle.agent.cancel({ kind: "disposed" });
      } catch {
        /* ignore */
      }
      try {
        await handle.dispose();
      } catch {
        /* ignore */
      }
    }
  }
}
