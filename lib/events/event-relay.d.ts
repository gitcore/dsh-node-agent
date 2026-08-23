/**
 * Event relay: subscribes to `session/event` (and `agent/status`), filters to
 * whitelisted types for tasks this node owns, redacts task content out of
 * payloads, assigns per-task forward seqs, and pushes into the EventBuffer.
 *
 * Sessions are keyed by the A2A conversation context (contextId), so incoming
 * session events are attributed back to every task attached to that session.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { TaskRegistry } from "../task/task-registry.js";
import type { EventBuffer } from "./event-buffer.js";
import type { Logger } from "../services/log-buffer.js";
export declare class EventRelay {
    private readonly ctx;
    private readonly registry;
    private readonly buffer;
    private readonly log;
    /** Session key (= A2A contextId) → attached taskIds. */
    private readonly sessionTasks;
    /** taskId → session key, for detach. */
    private readonly taskSessions;
    constructor(ctx: Context, registry: TaskRegistry, buffer: EventBuffer, log: Logger);
    attach(taskId: string, sessionKey: string): void;
    detach(taskId: string): void;
    clear(): void;
}
