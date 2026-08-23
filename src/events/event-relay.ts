/**
 * Event relay: subscribes to `session/event` (and `agent/status`), filters to
 * whitelisted types, redacts task content out of payloads, assigns per-task
 * forward seqs, and pushes into the EventBuffer.
 *
 * Attribution (dsh-a2a-context-session-mapping.md): a DSH event is mapped by
 * its dshSessionId -> context record -> activeTaskId. Only the active task's
 * events are forwarded; events that cannot be attributed are logged and
 * dropped — never guessed onto the nearest task.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import type { ContextRegistry } from "../task/context-registry.js";
import type { TaskRegistry } from "../task/task-registry.js";
import type { EventBuffer } from "./event-buffer.js";
import type { Logger } from "../services/log-buffer.js";

/** session/event types forwarded as progress (whitelist; token stream and prompt text stay local). */
const SESSION_EVENT_WHITELIST = new Set(["turn/start", "turn/end", "step/start", "step/end", "tool/call", "tool/result"]);

/** Redact one session event to a minimal, task-content-free payload. */
function redactSessionEvent(event: SessionEvent): unknown {
  switch (event.type) {
    case "turn/start":
      return { turn: event.data.turn };
    case "turn/end":
      return { turn: event.data.turn, reason: event.data.reason.kind };
    case "step/start":
    case "step/end":
      return { turn: event.data.turn, step: event.data.step };
    case "tool/call":
      // `arguments` may carry task data; forward only the tool identity.
      return { turn: event.data.turn, step: event.data.step, callId: event.data.callId, name: event.data.name };
    case "tool/result":
      return { turn: event.data.turn, step: event.data.step, error: event.data.error?.code ?? null };
    default:
      return undefined;
  }
}

export class EventRelay {
  constructor(
    private readonly ctx: Context,
    private readonly contexts: ContextRegistry,
    private readonly tasks: TaskRegistry,
    private readonly buffer: EventBuffer,
    private readonly log: Logger,
  ) {
    ctx.on("session/event", (session: Session, event: SessionEvent) => {
      const contextId = this.contexts.contextIdByDshSession(session.id);
      if (!contextId) return; // not a node-owned conversation
      const record = this.contexts.get(contextId);
      if (!record) return;
      if (!SESSION_EVENT_WHITELIST.has(event.type)) return;
      const taskId = record.activeTaskId;
      if (!taskId) {
        this.log.warn("relay", `session event for context ${contextId} has no active task; dropped (type=${event.type})`, contextId);
        return;
      }
      const task = this.tasks.get(taskId);
      if (!task) {
        this.log.warn("relay", `active task ${taskId} has no record; event dropped (type=${event.type})`, taskId);
        return;
      }
      const payload = redactSessionEvent(event);
      if (payload === undefined) return;
      const seq = this.tasks.nextSeq(taskId);
      this.tasks.touch(taskId, event.type);
      this.buffer.push({ taskId, contextId, event: { seq, type: event.type, ts: event.time, payload } });
    });
    // agent/status is a separate channel, not a session/event. Its agent id is
    // resolved as a DSH session id first, falling back to a plain taskId.
    ctx.on("agent/status", (payload: { agent: { id: string }; status: string }) => {
      const id = payload?.agent?.id;
      if (!id) return;
      let taskId = this.resolveActiveTask(id);
      if (!taskId && this.tasks.has(id)) taskId = id;
      if (!taskId) return;
      const task = this.tasks.get(taskId);
      if (!task) return;
      this.buffer.push({ taskId, contextId: task.contextId, event: { seq: this.tasks.nextSeq(taskId), type: "agent/status", ts: Date.now(), payload: { status: payload.status } } });
    });
  }

  /** Map a DSH session id (or bare contextId) to its current active task. */
  private resolveActiveTask(id: string): string | null | undefined {
    const contextId = this.contexts.contextIdByDshSession(id) ?? (this.contexts.has(id) ? id : undefined);
    if (!contextId) return undefined;
    return this.contexts.get(contextId)?.activeTaskId ?? null;
  }

  clear(): void {
    /* stateless attribution: nothing to reset */
  }
}
