/**
 * Event relay: subscribes to `session/event` (and `agent/status`), filters to
 * whitelisted types for tasks this node owns, redacts task content out of
 * payloads, assigns per-task forward seqs, and pushes into the EventBuffer.
 *
 * Sessions are keyed by the A2A conversation context (contextId), so incoming
 * session events are attributed back to every task attached to that session.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
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
  /** Session key (= A2A contextId) → attached taskIds. */
  private readonly sessionTasks = new Map<string, Set<string>>();
  /** taskId → session key, for detach. */
  private readonly taskSessions = new Map<string, string>();

  constructor(
    private readonly ctx: Context,
    private readonly registry: TaskRegistry,
    private readonly buffer: EventBuffer,
    private readonly log: Logger,
  ) {
    ctx.on("session/event", (session: Session, event: SessionEvent) => {
      const taskIds = this.sessionTasks.get(session.id);
      if (!taskIds || taskIds.size === 0) return;
      if (!SESSION_EVENT_WHITELIST.has(event.type)) return;
      const payload = redactSessionEvent(event);
      if (payload === undefined) return;
      for (const taskId of taskIds) {
        const record = this.registry.get(taskId);
        if (!record) continue;
        const seq = this.registry.nextSeq(taskId);
        this.registry.touch(taskId, event.type);
        this.buffer.push({ taskId, contextId: record.contextId, event: { seq, type: event.type, ts: event.time, payload } });
      }
    });
    // agent/status is a separate channel, not a session/event. Its agent id is
    // resolved as a session key first, falling back to a plain taskId.
    ctx.on("agent/status", (payload: { agent: { id: string }; status: string }) => {
      const id = payload?.agent?.id;
      if (!id) return;
      const direct = this.taskSessions.has(id) ? [id] : [];
      const taskIds = this.sessionTasks.has(id) ? [...this.sessionTasks.get(id) ?? []] : direct;
      for (const taskId of taskIds) {
        const record = this.registry.get(taskId);
        if (!record) continue;
        this.buffer.push({ taskId, contextId: record.contextId, event: { seq: this.registry.nextSeq(taskId), type: "agent/status", ts: Date.now(), payload: { status: payload.status } } });
      }
    });
  }

  attach(taskId: string, sessionKey: string): void {
    this.detach(taskId);
    this.taskSessions.set(taskId, sessionKey);
    const set = this.sessionTasks.get(sessionKey);
    if (set) set.add(taskId);
    else this.sessionTasks.set(sessionKey, new Set([taskId]));
  }

  detach(taskId: string): void {
    const sessionKey = this.taskSessions.get(taskId);
    if (!sessionKey) return;
    this.taskSessions.delete(taskId);
    const set = this.sessionTasks.get(sessionKey);
    if (!set) return;
    set.delete(taskId);
    if (set.size === 0) this.sessionTasks.delete(sessionKey);
  }

  clear(): void {
    this.sessionTasks.clear();
    this.taskSessions.clear();
  }
}
