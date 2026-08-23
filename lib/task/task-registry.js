/** A2A v1 task states (spec §4.1.3 vocabulary used by the mapping doc). */
export const TASK_STATES = ["submitted", "working", "completed", "failed", "canceled", "input-required", "rejected", "auth-required"];
const TERMINAL_STATES = new Set(["completed", "failed", "canceled", "rejected"]);
export function isTerminalState(state) {
    return TERMINAL_STATES.has(state);
}
export class TaskRegistry {
    historyCapacity;
    contextMemoryCapacity;
    tasks = new Map();
    history = [];
    /**
     * taskId -> contextId for every accepted task, surviving deletion so a
     * later message can infer the context of a finished task (bounded).
     */
    contexts = new Map();
    constructor(historyCapacity = 20, contextMemoryCapacity = 1000) {
        this.historyCapacity = historyCapacity;
        this.contextMemoryCapacity = contextMemoryCapacity;
    }
    /** Create a task record in the initial `submitted` state. */
    begin(taskId, contextId, source) {
        if (this.tasks.has(taskId))
            throw new Error(`task ${taskId} already exists`);
        const now = Date.now();
        const record = { taskId, contextId, source, state: "submitted", createdAt: now, updatedAt: now, seq: 0 };
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
    get(taskId) {
        return this.tasks.get(taskId);
    }
    has(taskId) {
        return this.tasks.has(taskId);
    }
    /** Last known contextId of a task — including terminal/deleted ones (bounded memory). */
    knownContextOf(taskId) {
        return this.tasks.get(taskId)?.contextId ?? this.contexts.get(taskId);
    }
    /**
     * Advance a task's state exactly once along legal edges. Terminal states are
     * immutable; only `input-required` may return to `working` (via a follow-up
     * message on the same taskId).
     */
    transition(taskId, to) {
        const record = this.tasks.get(taskId);
        if (!record)
            return undefined;
        if (record.state === to)
            return record;
        if (isTerminalState(record.state))
            throw new Error(`task ${taskId} is terminal (${record.state}); cannot transition to ${to}`);
        if (to === "working" && record.state !== "submitted" && record.state !== "input-required")
            throw new Error(`task ${taskId}: illegal transition ${record.state} -> working`);
        record.state = to;
        record.updatedAt = Date.now();
        return record;
    }
    /** Attach the terminal result reference; the caller performs the state transition first. */
    setResult(taskId, result) {
        const record = this.tasks.get(taskId);
        if (!record)
            return;
        record.result = result;
        record.updatedAt = Date.now();
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
    /** Tasks still occupying a concurrency slot (non-terminal states). */
    activeCount() {
        let count = 0;
        for (const record of this.tasks.values()) {
            if (!isTerminalState(record.state))
                count++;
        }
        return count;
    }
    list() {
        return [...this.tasks.values()];
    }
    listActive() {
        return this.list().filter((record) => !isTerminalState(record.state));
    }
    /**
     * Remove the live task record only. The conversation (context) and its
     * session stay untouched; the bounded context map keeps taskId -> contextId
     * so later messages can still resolve the finished task's context.
     */
    delete(taskId) {
        this.tasks.delete(taskId);
    }
    /** Recent finished tasks, newest first (bounded). */
    recent() {
        return [...this.history];
    }
    /** Record a terminal outcome into the bounded history. */
    archive(taskId, state, finalResponse) {
        const record = this.tasks.get(taskId);
        this.history.unshift({
            taskId,
            contextId: record?.contextId ?? this.knownContextOf(taskId) ?? "",
            source: record?.source ?? "taskDispatched",
            state,
            startedAt: record?.createdAt ?? Date.now(),
            finishedAt: Date.now(),
            durationMs: record ? Date.now() - record.createdAt : 0,
            lastEventType: record?.lastEventType,
            ...(finalResponse ? { finalResponse } : {}),
        });
        if (this.history.length > this.historyCapacity)
            this.history.length = this.historyCapacity;
    }
}
