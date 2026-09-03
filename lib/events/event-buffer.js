export class EventBuffer {
    capacity;
    queue = [];
    dropped = 0;
    constructor(capacity) {
        this.capacity = capacity;
    }
    push(item) {
        this.queue.push(item);
        if (this.queue.length > this.capacity) {
            this.queue.shift();
            this.dropped++;
        }
    }
    get size() {
        return this.queue.length;
    }
    get droppedCount() {
        return this.dropped;
    }
    /**
     * Relay diagnostics are not an A2A task-status schema, so they are never
     * sent through ClusterLink v2. Draining clears the local queue.
     */
    async drain(hub, log) {
        if (this.queue.length === 0 || !hub.isReady)
            return 0;
        const flushed = this.queue.length;
        this.queue = [];
        return flushed;
    }
    clear() {
        this.queue = [];
    }
    contextOf(taskId) {
        return this.contextResolver?.(taskId);
    }
    /** Optional hook so the drain can echo the record's A2A contextId. */
    setContextResolver(resolve) {
        this.contextResolver = resolve;
    }
    contextResolver;
}
