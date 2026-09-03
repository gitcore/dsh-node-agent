/** A2A v1 task states (spec §4.1.3 vocabulary used by the mapping doc). */
export const TASK_STATES = ["submitted", "working", "completed", "failed", "canceled", "input-required", "rejected", "auth-required"];
const TERMINAL_STATES = new Set(["completed", "failed", "canceled", "rejected"]);
export function isTerminalState(state) {
    return TERMINAL_STATES.has(state);
}
export class TaskRegistry {
    historyCapacity;
    contextMemoryCapacity;
    dispatchLedgerCapacity;
    tasks = new Map();
    history = [];
    /**
     * taskId -> contextId for every accepted task, surviving deletion so a
     * later message can infer the context of a finished task (bounded).
     */
    contexts = new Map();
    /**
     * Process-local, bounded idempotency ledger for server-owned outer dispatch
     * IDs. It deliberately is not reconstructed from A2A/context/session IDs and
     * is not durable across a node process restart.
     */
    dispatches = new Map();
    constructor(historyCapacity = 20, contextMemoryCapacity = 1000, dispatchLedgerCapacity = 1000) {
        this.historyCapacity = historyCapacity;
        this.contextMemoryCapacity = contextMemoryCapacity;
        this.dispatchLedgerCapacity = dispatchLedgerCapacity;
    }
    /**
     * Claim one outer dispatch before any context/session/task side effect.
     * Exact active duplicates are ignored; exact terminal duplicates replay the
     * original terminal wire envelope. Reusing an ID for different request data
     * is a protocol conflict and never executes.
     */
    claimDispatch(correlationId, requestSignature) {
        const existing = this.dispatches.get(correlationId);
        if (existing) {
            existing.updatedAt = Date.now();
            if (existing.requestSignature !== requestSignature)
                return { kind: "conflict" };
            if (existing.state === "terminal") {
                if (!existing.terminalEnvelope)
                    throw new Error(`terminal dispatch ${correlationId} has no replay envelope`);
                return { kind: "duplicate-terminal", terminalEnvelope: structuredClone(existing.terminalEnvelope) };
            }
            return {
                kind: "duplicate-active",
                ...(existing.taskId ? { taskId: existing.taskId } : {}),
                ...(existing.contextId ? { contextId: existing.contextId } : {}),
            };
        }
        while (this.dispatches.size >= this.dispatchLedgerCapacity) {
            const oldestTerminal = [...this.dispatches].find(([, entry]) => entry.state === "terminal");
            if (!oldestTerminal)
                return { kind: "capacity-exhausted" };
            this.dispatches.delete(oldestTerminal[0]);
        }
        const now = Date.now();
        this.dispatches.set(correlationId, {
            correlationId,
            requestSignature,
            state: "active",
            createdAt: now,
            updatedAt: now,
        });
        return { kind: "accepted" };
    }
    /** Attach generated A2A identity to an already claimed outer dispatch. */
    bindDispatch(correlationId, taskId, contextId) {
        const entry = this.dispatches.get(correlationId);
        if (!entry)
            throw new Error(`dispatch ${correlationId} was not claimed`);
        if (entry.state === "terminal")
            throw new Error(`dispatch ${correlationId} is already terminal`);
        if (entry.taskId && entry.taskId !== taskId)
            throw new Error(`dispatch ${correlationId} is already bound to task ${entry.taskId}`);
        if (entry.contextId && entry.contextId !== contextId)
            throw new Error(`dispatch ${correlationId} is already bound to context ${entry.contextId}`);
        entry.taskId = taskId;
        entry.contextId = contextId;
        entry.updatedAt = Date.now();
    }
    /**
     * Persist the exact terminal wire return before attempting SignalR delivery.
     * A later exact duplicate therefore retries the same task/context/session,
     * body, message ID, outer envelope ID, and timestamp.
     */
    completeDispatch(correlationId, terminalEnvelope) {
        const entry = this.dispatches.get(correlationId);
        if (!entry)
            throw new Error(`dispatch ${correlationId} was not claimed`);
        if (terminalEnvelope.correlationId !== correlationId) {
            throw new Error(`terminal dispatch correlation ${terminalEnvelope.correlationId ?? "(missing)"} does not match ${correlationId}`);
        }
        if (entry.state === "terminal") {
            if (JSON.stringify(entry.terminalEnvelope) !== JSON.stringify(terminalEnvelope)) {
                throw new Error(`dispatch ${correlationId} already has a different terminal envelope`);
            }
            return;
        }
        entry.state = "terminal";
        entry.terminalEnvelope = structuredClone(terminalEnvelope);
        entry.updatedAt = Date.now();
    }
    /** Create a task record in the initial `submitted` state. */
    begin(taskId, contextId, source, correlationId) {
        if (this.tasks.has(taskId))
            throw new Error(`task ${taskId} already exists`);
        const now = Date.now();
        const record = { taskId, correlationId, contextId, source, state: "submitted", createdAt: now, updatedAt: now, seq: 0 };
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
            source: record?.source ?? "payload",
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
