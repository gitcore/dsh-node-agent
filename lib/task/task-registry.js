export class TaskRegistry {
    historyCapacity;
    tasks = new Map();
    handles = new Map();
    history = [];
    constructor(historyCapacity = 20) {
        this.historyCapacity = historyCapacity;
    }
    begin(taskId, source, contextId) {
        const record = { taskId, status: "starting", source, startedAt: Date.now(), seq: 0 };
        if (contextId)
            record.contextId = contextId;
        this.tasks.set(taskId, record);
        return record;
    }
    get(taskId) {
        return this.tasks.get(taskId);
    }
    has(taskId) {
        return this.tasks.has(taskId);
    }
    attachHandle(taskId, handle) {
        this.handles.set(taskId, handle);
    }
    getHandle(taskId) {
        return this.handles.get(taskId);
    }
    setRunning(taskId) {
        const record = this.tasks.get(taskId);
        if (record)
            record.status = "running";
    }
    touch(taskId, eventType) {
        const record = this.tasks.get(taskId);
        if (record) {
            record.lastEventType = eventType;
            record.lastEventAt = Date.now();
        }
    }
    nextSeq(taskId) {
        const record = this.tasks.get(taskId);
        if (!record)
            return 0;
        return ++record.seq;
    }
    finish(taskId, finishReason) {
        const record = this.tasks.get(taskId);
        if (!record)
            return undefined;
        record.status = finishReason === "completed" ? "completed" : "failed";
        record.finishReason = finishReason;
        record.finishedAt = Date.now();
        return record;
    }
    /** Tasks still occupying a concurrency slot. */
    activeCount() {
        let count = 0;
        for (const record of this.tasks.values()) {
            if (record.status === "starting" || record.status === "running")
                count++;
        }
        return count;
    }
    list() {
        return [...this.tasks.values()];
    }
    listActive() {
        return this.list().filter((r) => r.status === "starting" || r.status === "running");
    }
    /**
     * Remove the task record only. The AgentHandle is intentionally KEPT: the
     * agent's session must stay live after completion so the web-ui sidebar
     * keeps the conversation and the user can open it to read the result.
     * Idle handles are capped by {@link disposeIdleBeyond}.
     */
    delete(taskId) {
        this.tasks.delete(taskId);
    }
    /** Recent finished tasks, newest first (bounded). */
    recent() {
        return [...this.history];
    }
    /** Record a terminal outcome into the bounded history. */
    archive(taskId, finishReason, source, finalResponse) {
        const record = this.tasks.get(taskId);
        this.history.unshift({
            taskId,
            source,
            finishReason,
            startedAt: record?.startedAt ?? Date.now(),
            finishedAt: record?.finishedAt ?? Date.now(),
            durationMs: record?.finishedAt ? record.finishedAt - record.startedAt : 0,
            lastEventType: record?.lastEventType,
            ...(finalResponse ? { finalResponse } : {}),
        });
        if (this.history.length > this.historyCapacity)
            this.history.length = this.historyCapacity;
    }
    /**
     * Dispose idle agent handles beyond `keep`, oldest first (handles whose task
     * record is gone = completed). Disposing removes their sessions from the
     * live store, so old task conversations age out of the sidebar in bounded
     * numbers. Returns the disposed taskIds.
     */
    async disposeIdleBeyond(keep) {
        const idle = [...this.handles.entries()].filter(([taskId]) => !this.tasks.has(taskId));
        const excess = idle.length > keep ? idle.slice(0, idle.length - keep) : [];
        const disposed = [];
        for (const [taskId, handle] of excess) {
            try {
                await handle.dispose();
            }
            catch {
                /* ignore */
            }
            this.handles.delete(taskId);
            disposed.push(taskId);
        }
        return disposed;
    }
    /** Stop and dispose every live handle (plugin unload). */
    async disposeAll() {
        const handles = [...this.handles.values()];
        this.handles.clear();
        for (const handle of handles) {
            try {
                handle.agent.cancel({ kind: "disposed" });
            }
            catch {
                /* ignore */
            }
            try {
                await handle.dispose();
            }
            catch {
                /* ignore */
            }
        }
    }
}
