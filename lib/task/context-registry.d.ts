/**
 * Context registry: owns the contextId -> opaque dshSessionId association plus
 * the per-context FIFO queue and active task pointer (dsh-a2a-context-session-
 * mapping.md "Required registry shape").
 *
 * The dshSessionId is confirmed by the DSH protocol create/restore flow — it
 * is never derived from a taskId, contextId, or message id.
 */
import type { Logger } from "../services/log-buffer.js";
export interface ContextRecord {
    /** Primary key: server-owned A2A conversation id. */
    contextId: string;
    /**
     * Opaque canonical session id confirmed by the DSH protocol. Empty string
     * only while a brand-new context is being provisioned (pre-confirm).
     */
    dshSessionId: string;
    /** Resolved stable workspace value; immutable after creation. */
    workspace?: string;
    /** Raw workspace hint as first provided; immutable after creation (conflict detection). */
    workspaceHint?: string;
    /** The task currently writing to the DSH session, if any. */
    activeTaskId: string | null;
    /** FIFO of submitted taskIds waiting for the active task to reach a terminal state. */
    queuedTaskIds: string[];
}
export declare class ContextRegistry {
    private readonly log;
    private readonly contexts;
    private readonly byDshSession;
    constructor(log: Logger);
    has(contextId: string): boolean;
    get(contextId: string): ContextRecord | undefined;
    /** Reverse lookup: which context owns this DSH session. */
    contextIdByDshSession(dshSessionId: string): string | undefined;
    /** All context records (insertion order). */
    list(): ContextRecord[];
    /**
     * Provision a brand-new context record. The dshSessionId is empty until
     * {@link confirmSession} records the DSH-confirmed canonical value.
     */
    create(contextId: string, workspace?: {
        resolved: string | undefined;
        hint: string | undefined;
    }): ContextRecord;
    /** Store the DSH-confirmed canonical session id and build the reverse index. */
    confirmSession(contextId: string, dshSessionId: string): void;
    /** Remove a provisioned record that never got a confirmed session (creation failure rollback). */
    deleteIfUnconfirmed(contextId: string): void;
    enqueueTask(contextId: string, taskId: string): void;
    dequeueHead(contextId: string): string | undefined;
    setActiveTask(contextId: string, taskId: string | null): void;
    private require;
}
