/** Bounded ring buffer of log entries, newest last. */
export class LogBuffer {
    size;
    entries = [];
    constructor(size) {
        this.size = size;
    }
    push(entry) {
        this.entries.push(entry);
        if (this.entries.length > this.size)
            this.entries.splice(0, this.entries.length - this.size);
    }
    list(level) {
        return level === undefined || level === "all" ? [...this.entries] : this.entries.filter((e) => e.level === level);
    }
    get length() {
        return this.entries.length;
    }
}
/** Build a logger writing to both the Cordis logger and the ring buffer. */
export function createLogger(ctx, buffer, nodeId) {
    const emit = (level, scope, message, taskId) => {
        // taskId omitted when absent: the gateway's JSON-safety check rejects
        // undefined property values.
        buffer.push({ ts: Date.now(), level, scope, message, ...(taskId ? { taskId } : {}) });
        const tag = `[node-agent:${nodeId}${taskId ? `:${taskId}` : ""}] ${scope}: ${message}`;
        if (level === "error")
            ctx.logger.error(tag);
        else if (level === "warn")
            ctx.logger.warn(tag);
        else
            ctx.logger.info(tag);
    };
    return {
        info: (scope, message, taskId) => emit("info", scope, message, taskId),
        warn: (scope, message, taskId) => emit("warn", scope, message, taskId),
        error: (scope, message, taskId) => emit("error", scope, message, taskId),
    };
}
