/**
 * Ordered relay queue: batching window + offline retention in one bounded
 * queue. The relay pushes {taskId, event} here; a timer (or the
 * post-registration hook) drains it locally. A2A task state is reported by
 * TaskIntake through the v2 DSH payload channel; relay diagnostics stay local.
 */
import type { RelayEvent } from "../protocol.js";
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
     * Relay diagnostics are not an A2A task-status schema, so they are never
     * sent through ClusterLink v2. Draining clears the local queue.
     */
    drain(hub: HubConnectionManager, log: Logger): Promise<number>;
    clear(): void;
    private contextOf;
    /** Optional hook so the drain can echo the record's A2A contextId. */
    setContextResolver(resolve: (taskId: string) => string | undefined): void;
    private contextResolver;
}
