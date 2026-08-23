export class TaskRegistry {
    historyCapacity;
    contextMemoryCapacity;
    tasks = new Map();
    /** Live agent handles keyed by session key (= A2A contextId). */
    handles = new Map();
    /** taskId → contextId for every accepted task (survives deletion; bounded). */
    contexts = new Map();
    history = [];
    constructor(historyCapacity = 20, contextMemoryCapacity = 1000) {
        this.historyCapacity = historyCapacity;
        this.contextMemoryCapacity = contextMemoryCapacity;
    }
    begin(taskId, source, contextId) {
        const record = { taskId, status: "starting", source, contextId, startedAt: Date.now(), seq: 0 };
        this.tasks.set(taskId, record);
        this.contexts.set(taskId, contextId);
        while (this.contexts.size > this.contextMemoryCapacity) {
            const oldest = this.contexts.keys().next().value;
            if (oldest === undefined)
                break;
            this.contexts.delete(oldest);
        }
        return record;
    }
    /** Last known contextId of a task — including finished/deleted ones (bounded memory). */
    knownContextOf(taskId) {
        return this.tasks.get(taskId)?.contextId ?? this.contexts.get(taskId);
    }
    get(taskId) {
        return this.tasks.get(taskId);
    }
    has(taskId) {
        return this.tasks.has(taskId);
    }
    attachHandle(taskId, handle) {
        const sessionKey = this.knownContextOf(taskId);
        if (sessionKey)
            this.handles.set(sessionKey, handle);
    }
    getHandleBySession(sessionKey) {
        return this.handles.get(sessionKey);
    }
    getHandle(taskId) {
        const sessionKey = this.knownContextOf(taskId);
        return sessionKey ? this.handles.get(sessionKey) : undefined;
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
     * Dispose idle agent handles beyond `keep`, oldest first (handles whose
     * context has no active task = completed). Disposing removes their sessions
     * from the live store, so old task conversations age out of the sidebar in
     * bounded numbers. Returns the disposed session keys.
     */
    async disposeIdleBeyond(keep) {
        const activeSessions = new Set();
        for (const record of this.tasks.values()) {
            if (record.status === "starting" || record.status === "running")
                activeSessions.add(record.contextId);
        }
        const idle = [...this.handles.entries()].filter(([sessionKey]) => !activeSessions.has(sessionKey));
        const excess = idle.length > keep ? idle.slice(0, idle.length - keep) : [];
        const disposed = [];
        for (const [sessionKey, handle] of excess) {
            try {
                await handle.dispose();
            }
            catch {
                /* ignore */
            }
            this.handles.delete(sessionKey);
            disposed.push(sessionKey);
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
