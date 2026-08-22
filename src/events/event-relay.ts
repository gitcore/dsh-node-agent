/**
 * Event relay: subscribes to `session/event` (and `agent/status`), filters to
 * whitelisted types for tasks this node owns, redacts task content out of
 * payloads, assigns per-task forward seqs, and pushes into the EventBuffer.
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
  private attached = new Set<string>();

  constructor(
    private readonly ctx: Context,
    private readonly registry: TaskRegistry,
    private readonly buffer: EventBuffer,
    private readonly log: Logger,
  ) {
    ctx.on("session/event", (session: Session, event: SessionEvent) => {
      const taskId = session.id;
      if (!this.attached.has(taskId)) return;
      if (!SESSION_EVENT_WHITELIST.has(event.type)) return;
      const record = this.registry.get(taskId);
      if (!record) return;
      const payload = redactSessionEvent(event);
      if (payload === undefined) return;
      const seq = this.registry.nextSeq(taskId);
      this.registry.touch(taskId, event.type);
      const contextId = record.contextId;
      this.buffer.push({ taskId, ...(contextId ? { contextId } : {}), event: { seq, type: event.type, ts: event.time, payload } });
    });
    // agent/status is a separate channel, not a session/event.
    ctx.on("agent/status", (payload: { agent: { id: string }; status: string }) => {
      const taskId = payload?.agent?.id;
      if (!taskId || !this.attached.has(taskId)) return;
      this.buffer.push({ taskId, event: { seq: this.registry.nextSeq(taskId), type: "agent/status", ts: Date.now(), payload: { status: payload.status } } });
    });
  }

  attach(taskId: string): void {
    this.attached.add(taskId);
  }

  detach(taskId: string): void {
    this.attached.delete(taskId);
  }

  clear(): void {
    this.attached.clear();
  }
}
