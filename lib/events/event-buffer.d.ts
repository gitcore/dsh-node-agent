/**
 * Ordered relay queue: batching window + offline retention in one bounded
 * queue. The relay pushes {taskId, event} here; a timer (or the
 * post-registration hook) drains it into `reportTaskEvent` batches grouped by
 * task. Items whose send fails stay at the head until the hub is ready again.
 */
import { type RelayEvent } from "../protocol.js";
import type { HubConnectionManager } from "../connection/hub-connection.js";
import type { Logger } from "../services/log-buffer.js";
export interface QueuedEvent {
    taskId: string;
    /** A2A conversation context, echoed in the progress report. */
    contextId?: string;
    event: RelayEvent;
}
export declare class EventBuffer {
    private readonly capacity;
    private queue;
    private dropped;
    constructor(capacity: number);
    push(item: QueuedEvent): void;
    get size(): number;
    get droppedCount(): number;
    /**
     * Send everything the hub accepts, one `reportTaskEvent` (kind=progress)
     * per task. Returns the number of tasks flushed; failed tasks keep their
     * events queued for the next drain.
     */
    drain(hub: HubConnectionManager, log: Logger): Promise<number>;
    clear(): void;
    private contextOf;
    /** Optional hook so the drain can echo the record's A2A contextId. */
    setContextResolver(resolve: (taskId: string) => string | undefined): void;
    private contextResolver;
}
