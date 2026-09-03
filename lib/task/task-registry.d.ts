/**
 * Task registry: owns taskId -> contextId + the A2A task lifecycle record
 * (dsh-a2a-context-session-mapping.md "Required registry shape"). A task
 * record never holds a session id; session identity belongs to the context.
 */
import type { ClusterLinkPayloadEnvelope } from "../protocol.js";
/** A2A v1 task states (spec §4.1.3 vocabulary used by the mapping doc). */
export declare const TASK_STATES: readonly ["submitted", "working", "completed", "failed", "canceled", "input-required", "rejected", "auth-required"];
export type TaskState = (typeof TASK_STATES)[number];
export declare function isTerminalState(state: TaskState): boolean;
export type TaskSource = "payload";
/** Result reference recorded when a task reaches a terminal state. */
export interface TaskResult {
    finishReason: string;
    finalResponse?: string;
    errorCode?: string;
    errorMessage?: string;
}
export interface TaskRecord {
    taskId: string;
    /** Original ClusterLink outer dispatch ID used for every return correlation. */
    correlationId: string;
    /** Required reference key into the context registry. */
    contextId: string;
    source: TaskSource;
    state: TaskState;
    createdAt: number;
    updatedAt: number;
    lastEventType?: string;
    lastEventAt?: number;
    result?: TaskResult;
    /** Last assigned per-task forward seq (progress event ordering). */
    seq: number;
}
/** Bounded terminal history entry for the cluster panel. */
export interface TaskHistoryEntry {
    taskId: string;
    contextId: string;
    source: TaskSource;
    state: TaskState;
    startedAt: number;
    finishedAt: number;
    durationMs: number;
    lastEventType?: string;
    finalResponse?: string;
}
export type DispatchClaim = {
    kind: "accepted";
} | {
    kind: "duplicate-active";
    taskId?: string;
    contextId?: string;
} | {
    kind: "duplicate-terminal";
    terminalEnvelope: ClusterLinkPayloadEnvelope;
} | {
    kind: "conflict";
} | {
    kind: "capacity-exhausted";
};
export declare class TaskRegistry {
    private readonly historyCapacity;
    private readonly contextMemoryCapacity;
    private readonly dispatchLedgerCapacity;
    private tasks;
    private readonly history;
    /**
     * taskId -> contextId for every accepted task, surviving deletion so a
     * later message can infer the context of a finished task (bounded).
     */
    private contexts;
    /**
     * Process-local, bounded idempotency ledger for server-owned outer dispatch
     * IDs. It deliberately is not reconstructed from A2A/context/session IDs and
     * is not durable across a node process restart.
     */
    private readonly dispatches;
    constructor(historyCapacity?: number, contextMemoryCapacity?: number, dispatchLedgerCapacity?: number);
    /**
     * Claim one outer dispatch before any context/session/task side effect.
     * Exact active duplicates are ignored; exact terminal duplicates replay the
     * original terminal wire envelope. Reusing an ID for different request data
     * is a protocol conflict and never executes.
     */
    claimDispatch(correlationId: string, requestSignature: string): DispatchClaim;
    /** Attach generated A2A identity to an already claimed outer dispatch. */
    bindDispatch(correlationId: string, taskId: string, contextId: string): void;
    /**
     * Persist the exact terminal wire return before attempting SignalR delivery.
     * A later exact duplicate therefore retries the same task/context/session,
     * body, message ID, outer envelope ID, and timestamp.
     */
    completeDispatch(correlationId: string, terminalEnvelope: ClusterLinkPayloadEnvelope): void;
    /** Create a task record in the initial `submitted` state. */
    begin(taskId: string, contextId: string, source: TaskSource, correlationId: string): TaskRecord;
    get(taskId: string): TaskRecord | undefined;
    has(taskId: string): boolean;
    /** Last known contextId of a task — including terminal/deleted ones (bounded memory). */
    knownContextOf(taskId: string): string | undefined;
    /**
     * Advance a task's state exactly once along legal edges. Terminal states are
     * immutable; only `input-required` may return to `working` (via a follow-up
     * message on the same taskId).
     */
    transition(taskId: string, to: TaskState): TaskRecord | undefined;
    /** Attach the terminal result reference; the caller performs the state transition first. */
    setResult(taskId: string, result: TaskResult): void;
    touch(taskId: string, eventType: string): void;
    nextSeq(taskId: string): number;
    /** Tasks still occupying a concurrency slot (non-terminal states). */
    activeCount(): number;
    list(): TaskRecord[];
    listActive(): TaskRecord[];
    /**
     * Remove the live task record only. The conversation (context) and its
     * session stay untouched; the bounded context map keeps taskId -> contextId
     * so later messages can still resolve the finished task's context.
     */
    delete(taskId: string): void;
    /** Recent finished tasks, newest first (bounded). */
    recent(): TaskHistoryEntry[];
    /** Record a terminal outcome into the bounded history. */
    archive(taskId: string, state: TaskState, finalResponse?: string): void;
}
