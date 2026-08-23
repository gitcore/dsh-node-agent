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
import type { ContextRegistry } from "../task/context-registry.js";
import type { TaskRegistry } from "../task/task-registry.js";
import type { EventBuffer } from "./event-buffer.js";
import type { Logger } from "../services/log-buffer.js";
export declare class EventRelay {
    private readonly ctx;
    private readonly contexts;
    private readonly tasks;
    private readonly buffer;
    private readonly log;
    constructor(ctx: Context, contexts: ContextRegistry, tasks: TaskRegistry, buffer: EventBuffer, log: Logger);
    /** Map a DSH session id (or bare contextId) to its current active task. */
    private resolveActiveTask;
    clear(): void;
}
