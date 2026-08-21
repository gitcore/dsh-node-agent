/**
 * Event relay: subscribes to `session/event` (and `agent/status`), filters to
 * whitelisted types for tasks this node owns, redacts task content out of
 * payloads, assigns per-task forward seqs, and pushes into the EventBuffer.
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
    private attached;
    constructor(ctx: Context, registry: TaskRegistry, buffer: EventBuffer, log: Logger);
    attach(taskId: string): void;
    detach(taskId: string): void;
    clear(): void;
}
