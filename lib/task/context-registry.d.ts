/**
 * Context registry owns the A2A contextId plus the per-context FIFO queue and
 * active task pointer. Runtime SignalR/DSH handles are deliberately excluded:
 * they are process-local transport resources and have no Chat conversation
 * identity or persistence meaning.
 */
import type { Logger } from "../services/log-buffer.js";
export interface ContextRecord {
    /** Primary key: server-owned A2A conversation id. */
    contextId: string;
    /** Resolved stable workspace value; immutable after creation. */
    workspace?: string;
    /** Raw workspace hint as first provided; immutable after creation (conflict detection). */
    workspaceHint?: string;
    /** The task currently using this context's transient runtime agent, if any. */
    activeTaskId: string | null;
    /** FIFO of submitted taskIds waiting for the active task to reach a terminal state. */
    queuedTaskIds: string[];
}
export declare class ContextRegistry {
    private readonly log;
    private readonly contexts;
    constructor(log: Logger);
    has(contextId: string): boolean;
    get(contextId: string): ContextRecord | undefined;
    /** All context records (insertion order). */
    list(): ContextRecord[];
    /**
     * Provision a brand-new A2A context record.
     */
    create(contextId: string, workspace?: {
        resolved: string | undefined;
        hint: string | undefined;
    }): ContextRecord;
    /** Recreate the persisted A2A context after a node restart. */
    restore(contextId: string, workspace?: {
        resolved: string | undefined;
        hint: string | undefined;
    }): ContextRecord;
    /** Remove an unstarted context after runtime-handle creation failed. */
    delete(contextId: string): void;
    enqueueTask(contextId: string, taskId: string): void;
    dequeueHead(contextId: string): string | undefined;
    setActiveTask(contextId: string, taskId: string | null): void;
    private require;
}
