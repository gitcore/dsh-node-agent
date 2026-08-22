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
    // Cordis uses ctx.root.logger("scope") factory style; sandbox context gates
    // framework internals like .root, so we defensively probe for a working
    // logger and fall back to the global console.
    let cordisLog = null;
    try {
        // NOTE: ctx.root.logger("scope") returns an object with info/warn/error.
        // Any property access off the sandbox ctx that isn't whitelisted throws,
        // so probe through ctx.get() (which is always available).
        const root = ctx.get("root");
        if (typeof root?.logger === "function") {
            const l = root.logger(`node-agent:${nodeId}`);
            cordisLog = (tag) => l.info?.(tag);
        }
    }
    catch {
        /* sandbox denied access, ignore */
    }
    const emit = (level, scope, message, taskId) => {
        buffer.push({ ts: Date.now(), level, scope, message, ...(taskId ? { taskId } : {}) });
        const tag = `[node-agent:${nodeId}${taskId ? `:${taskId}` : ""}] ${scope}: ${message}`;
        try {
            if (level === "error")
                cordisLog?.(`[ERROR] ${tag}`) ?? console.error(tag);
            else if (level === "warn")
                cordisLog?.(`[WARN ] ${tag}`) ?? console.warn(tag);
            else
                cordisLog?.(`[INFO ] ${tag}`) ?? console.info(tag);
        }
        catch {
            /* any logging failure must not break the plugin */
        }
    };
    return {
        info: (scope, message, taskId) => emit("info", scope, message, taskId),
        warn: (scope, message, taskId) => emit("warn", scope, message, taskId),
        error: (scope, message, taskId) => emit("error", scope, message, taskId),
    };
}
