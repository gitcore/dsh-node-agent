/**
 * Task intake: dual-channel acceptance (taskDispatched + a2a task.request),
 * in-process agent/session creation via ctx.agents.create, started/failed
 * reporting, and the run-to-completion driver with final report.
 */
import type { Context } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { installModelSelection, type AgentHandle, type ModelSelection } from "@deepseek-ai/dsh-agent";
import { TASK_EVENT_KINDS, type A2APart, type ClusterA2AMessageEnvelope, type ClusterTaskDispatch, type ClusterTaskEvent, type PluginConfig } from "../protocol.js";
import { errorMessage, type HubConnectionManager } from "../connection/hub-connection.js";
import type { TaskRegistry, TaskSource } from "./task-registry.js";
import type { EventRelay } from "../events/event-relay.js";
import type { Logger } from "../services/log-buffer.js";
import { summarizeOutcome } from "./task-completion.js";
import { resolveWorkspace } from "./workspace.js";

export interface IntakeCounters {
  processedTasks: number;
  failedTasks: number;
}

interface DefaultModelService {
  currentSelection?: () => ModelSelection;
}

function contextIdOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export class TaskIntake {
  private readonly selection: ModelSelection | undefined;

  constructor(
    private readonly ctx: Context,
    private readonly config: PluginConfig,
    private readonly registry: TaskRegistry,
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

  onTaskDispatched(payload: ClusterTaskDispatch): void {
    const taskId = payload?.taskId;
    const prompt = payload?.prompt;
    if (!taskId || typeof prompt !== "string" || prompt.trim().length === 0) {
      this.log.warn("intake", `invalid taskDispatched payload: ${JSON.stringify({ taskId, hasPrompt: typeof prompt === "string" })}`);
      return;
    }
    const workspaceHint = payload?.metadata && typeof payload.metadata === "object" ? (payload.metadata as Record<string, unknown>).workspace : undefined;
    void this.accept(taskId, prompt, payload.metadata, "taskDispatched", contextIdOf(payload.contextId), workspaceHint);
  }

  onA2AMessage(envelope: ClusterA2AMessageEnvelope): void {
    // The envelope's message is an official A2A v1 Message; the prompt is the
    // concatenated text parts and the workspace hint rides in metadata.
    const message = envelope?.message;
    const parts: readonly A2APart[] = Array.isArray(message?.parts) ? message.parts : [];
    const prompt = parts.filter((part) => typeof part?.text === "string").map((part) => part.text ?? "").join("").trim();
    if (prompt.length === 0) {
      this.log.warn("intake", `a2a message without text parts (deliveryId=${envelope?.messageId ?? "?"} from=${envelope?.fromNodeId ?? "?"})`);
      return;
    }
    const correlationId = typeof envelope.correlationId === "string" ? envelope.correlationId.trim() : "";
    const innerMessageId = typeof message?.messageId === "string" ? message.messageId.trim() : "";
    const taskId = correlationId.length > 0 ? correlationId : innerMessageId.length > 0 ? innerMessageId : `a2a-${envelope.messageId ?? Date.now()}`;
    const metadata = message?.metadata && typeof message.metadata === "object" ? { ...message.metadata } : {};
    const workspaceHint = metadata.workspace;
    void this.accept(
      taskId,
      prompt,
      { ...metadata, deliveryId: envelope.messageId, fromNodeId: envelope.fromNodeId },
      "a2a",
      contextIdOf(message?.contextId),
      workspaceHint,
    );
  }

  private async accept(taskId: string, prompt: string, metadata: Record<string, unknown> | null | undefined, source: TaskSource, contextId?: string, workspaceHint?: unknown): Promise<void> {
    if (this.registry.has(taskId)) {
      this.log.warn("intake", `duplicate taskId ${taskId}; rejecting`, taskId);
      await this.report(taskId, { kind: TASK_EVENT_KINDS.FAILED, message: "duplicate taskId" });
      return;
    }
    if (this.registry.activeCount() >= this.config.maxConcurrency) {
      this.log.warn("intake", `max concurrency (${this.config.maxConcurrency}) reached; rejecting ${taskId}`, taskId);
      await this.report(taskId, { kind: TASK_EVENT_KINDS.FAILED, message: `max concurrency reached (${this.config.maxConcurrency})` });
      return;
    }

    this.registry.begin(taskId, source, contextId);
    this.log.info("intake", `accepting task ${taskId} (source=${source}${contextId ? `, context=${contextId}` : ""})`, taskId);
    // Resolve the target workspace before creating the session (its path
    // becomes the session cwd, which is half of workspace membership).
    const workspace = await resolveWorkspace(this.ctx, this.config, workspaceHint, this.log);
    const cwd = workspace?.path ?? this.config.workspace;
    if (workspace) this.log.info("intake", `task ${taskId} -> workspace ${workspace.path}`, taskId);
    try {
      const handle = await this.ctx.agents.create({
        sessionId: SessionId(taskId),
        meta: { cwd },
        agentOptions: this.selection ? { provider: this.selection.provider, model: this.selection.model } : undefined,
        setup: (agentCtx) => {
          if (this.selection) installModelSelection(agentCtx, { current: this.selection, assembled: void 0 });
        },
      });
      this.registry.attachHandle(taskId, handle);
      // Attach the session to the workspace account (the other half of
      // membership) so the sidebar groups it under that workspace.
      if (workspace) {
        try {
          await workspace.attach(taskId);
        } catch (error) {
          this.log.warn("intake", `workspace attach failed for ${taskId}: ${errorMessage(error)}`, taskId);
        }
      }
      this.registry.setRunning(taskId);
      this.relay.attach(taskId);
      const accepted = await this.report(taskId, {
        kind: TASK_EVENT_KINDS.STARTED,
        message: "node accepted the task",
        data: { sessionId: taskId, source, ...(workspace ? { workspace: workspace.path } : {}) },
      });
      if (!accepted) this.log.warn("intake", `started event not delivered (hub offline); session ${taskId} is running`, taskId);
      void this.run(taskId, handle, prompt);
    } catch (error) {
      this.registry.finish(taskId, "error");
      this.registry.archive(taskId, "error", source);
      this.registry.delete(taskId);
      this.counters.failedTasks++;
      const detail = errorMessage(error).slice(0, 300);
      this.log.error("intake", `agent create failed for ${taskId}: ${detail}`, taskId);
      await this.report(taskId, { kind: TASK_EVENT_KINDS.FAILED, message: `agent create failed: ${detail}` });
    }
  }

  /** Report one task event with the record's A2A contextId echoed. */
  private async report(taskId: string, event: Omit<ClusterTaskEvent, "taskId" | "contextId" | "timestampUtc"> & { data?: Record<string, unknown> }): Promise<boolean> {
    const contextId = this.registry.get(taskId)?.contextId;
    return this.hub.reportTaskEvent({
      ...event,
      taskId,
      ...(contextId ? { contextId } : {}),
      timestampUtc: new Date().toISOString(),
    });
  }

  private async run(taskId: string, handle: AgentHandle, prompt: string): Promise<void> {
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
        await this.report(taskId, {
          kind: TASK_EVENT_KINDS.COMPLETED,
          message: "task completed",
          data: { finalResponse: outcome.text, finishReason: "completed" },
        });
      } else {
        this.registry.finish(taskId, outcome.finishReason);
        this.registry.archive(taskId, outcome.finishReason, source, outcome.text);
        this.counters.failedTasks++;
        this.log.warn("intake", `task ${taskId} finished with reason=${outcome.finishReason}`, taskId);
        await this.report(taskId, {
          kind: TASK_EVENT_KINDS.FAILED,
          data: { finishReason: outcome.finishReason, errorCode: outcome.errorCode ?? null, errorMessage: outcome.errorMessage?.slice(0, 300) ?? null },
        });
      }
    } catch (error) {
      this.relay.detach(taskId);
      this.registry.finish(taskId, "error");
      this.registry.archive(taskId, "error", this.registry.get(taskId)?.source ?? "taskDispatched");
      this.counters.failedTasks++;
      const detail = errorMessage(error).slice(0, 300);
      this.log.error("intake", `task ${taskId} crashed: ${detail}`, taskId);
      await this.report(taskId, { kind: TASK_EVENT_KINDS.FAILED, message: `execution error: ${detail}` });
    } finally {
      // Deliberately NOT handle.dispose(): dispose would remove the session
      // from the store and the sidebar conversation vanishes. The agent stays
      // idle and its session stays live so the user can open it and read the
      // result; idle agents are capped by enforceIdleCap().
      this.registry.delete(taskId);
      void this.enforceIdleCap();
    }
  }

  /** Dispose oldest idle agents beyond the cap (their sessions age out). */
  private async enforceIdleCap(): Promise<void> {
    try {
      const keep = Math.max(this.config.maxConcurrency * 3, 6);
      const disposed = await this.registry.disposeIdleBeyond(keep);
      for (const taskId of disposed) this.log.info("intake", `disposed idle agent/session ${taskId} (cap ${keep})`);
    } catch (error) {
      this.log.warn("intake", `idle-cap enforcement failed: ${errorMessage(error)}`);
    }
  }
}
