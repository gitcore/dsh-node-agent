export class ContextRegistry {
    log;
    contexts = new Map();
    constructor(log) {
        this.log = log;
    }
    has(contextId) {
        return this.contexts.has(contextId);
    }
    get(contextId) {
        return this.contexts.get(contextId);
    }
    /** All context records (insertion order). */
    list() {
        return [...this.contexts.values()];
    }
    /**
     * Provision a brand-new A2A context record.
     */
    create(contextId, workspace) {
        if (this.contexts.has(contextId))
            throw new Error(`context ${contextId} already exists`);
        const record = {
            contextId,
            activeTaskId: null,
            queuedTaskIds: [],
            ...(workspace?.resolved ? { workspace: workspace.resolved } : {}),
            ...(workspace?.hint ? { workspaceHint: workspace.hint } : {}),
        };
        this.contexts.set(contextId, record);
        return record;
    }
    /** Recreate the persisted A2A context after a node restart. */
    restore(contextId, workspace) {
        const normalizedContextId = contextId.trim();
        if (!normalizedContextId)
            throw new Error("contextId is required");
        const existing = this.contexts.get(normalizedContextId);
        if (existing)
            return existing;
        const record = {
            contextId: normalizedContextId,
            activeTaskId: null,
            queuedTaskIds: [],
            ...(workspace?.resolved ? { workspace: workspace.resolved } : {}),
            ...(workspace?.hint ? { workspaceHint: workspace.hint } : {}),
        };
        this.contexts.set(normalizedContextId, record);
        this.log.info("intake", `restored A2A context ${normalizedContextId}`);
        return record;
    }
    /** Remove an unstarted context after runtime-handle creation failed. */
    delete(contextId) {
        const record = this.contexts.get(contextId);
        if (!record)
            return;
        if (record.activeTaskId || record.queuedTaskIds.length > 0) {
            throw new Error(`context ${contextId} cannot be removed while work is active`);
        }
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
