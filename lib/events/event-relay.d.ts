/**
 * Event relay: subscribes to `session/event` (and `agent/status`), filters to
 * whitelisted types, redacts task content out of payloads, assigns per-task
 * forward seqs, and pushes into the EventBuffer.
 *
 * Attribution uses a transient runtime-agent callback supplied by task intake.
 * It is never persisted or sent over ClusterLink; A2A contextId remains the
 * sole conversation identity. Only the active task's events are forwarded.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { ContextRegistry } from "../task/context-registry.js";
import type { TaskRegistry } from "../task/task-registry.js";
import type { EventBuffer } from "./event-buffer.js";
import type { Logger } from "../services/log-buffer.js";
export declare class EventRelay {
    private readonly ctx;
    private readonly contexts;
    private readonly resolveContextId;
    private readonly tasks;
    private readonly buffer;
    private readonly log;
    constructor(ctx: Context, contexts: ContextRegistry, resolveContextId: (runtimeAgentId: string) => string | undefined, tasks: TaskRegistry, buffer: EventBuffer, log: Logger);
    /** Resolve a transient runtime agent id (or bare contextId) to an active task. */
    private resolveActiveTask;
    clear(): void;
}
