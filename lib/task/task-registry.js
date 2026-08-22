export class TaskRegistry {
    historyCapacity;
    tasks = new Map();
    handles = new Map();
    history = [];
    constructor(historyCapacity = 20) {
        this.historyCapacity = historyCapacity;
    }
    begin(taskId, source) {
        const record = { taskId, status: "starting", source, startedAt: Date.now(), seq: 0 };
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
    delete(taskId) {
        this.tasks.delete(taskId);
        this.handles.delete(taskId);
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
