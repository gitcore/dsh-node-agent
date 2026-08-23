export class ContextRegistry {
    log;
    contexts = new Map();
    byDshSession = new Map();
    constructor(log) {
        this.log = log;
    }
    has(contextId) {
        return this.contexts.has(contextId);
    }
    get(contextId) {
        return this.contexts.get(contextId);
    }
    /** Reverse lookup: which context owns this DSH session. */
    contextIdByDshSession(dshSessionId) {
        return this.byDshSession.get(dshSessionId);
    }
    /** All context records (insertion order). */
    list() {
        return [...this.contexts.values()];
    }
    /**
     * Provision a brand-new context record. The dshSessionId is empty until
     * {@link confirmSession} records the DSH-confirmed canonical value.
     */
    create(contextId, workspace) {
        if (this.contexts.has(contextId))
            throw new Error(`context ${contextId} already exists`);
        const record = {
            contextId,
            dshSessionId: "",
            activeTaskId: null,
            queuedTaskIds: [],
            ...(workspace?.resolved ? { workspace: workspace.resolved } : {}),
            ...(workspace?.hint ? { workspaceHint: workspace.hint } : {}),
        };
        this.contexts.set(contextId, record);
        return record;
    }
    /** Store the DSH-confirmed canonical session id and build the reverse index. */
    confirmSession(contextId, dshSessionId) {
        const record = this.contexts.get(contextId);
        if (!record)
            throw new Error(`context ${contextId} does not exist`);
        if (record.dshSessionId && record.dshSessionId !== dshSessionId)
            throw new Error(`context ${contextId} already bound to another DSH session`);
        record.dshSessionId = dshSessionId;
        this.byDshSession.set(dshSessionId, contextId);
    }
    /** Remove a provisioned record that never got a confirmed session (creation failure rollback). */
    deleteIfUnconfirmed(contextId) {
        const record = this.contexts.get(contextId);
        if (!record || record.dshSessionId)
            return;
        this.contexts.delete(contextId);
    }
    enqueueTask(contextId, taskId) {
        const record = this.require(contextId);
        record.queuedTaskIds.push(taskId);
    }
    dequeueHead(contextId) {
        const record = this.require(contextId);
        return record.queuedTaskIds.shift();
    }
    setActiveTask(contextId, taskId) {
        this.require(contextId).activeTaskId = taskId;
    }
    require(contextId) {
        const record = this.contexts.get(contextId);
        if (!record)
            throw new Error(`context ${contextId} does not exist`);
        return record;
    }
}
