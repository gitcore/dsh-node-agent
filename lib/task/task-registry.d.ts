/** A2A v1 task states (spec §4.1.3 vocabulary used by the mapping doc). */
export declare const TASK_STATES: readonly ["submitted", "working", "completed", "failed", "canceled", "input-required", "rejected", "auth-required"];
export type TaskState = (typeof TASK_STATES)[number];
export declare function isTerminalState(state: TaskState): boolean;
export type TaskSource = "taskDispatched" | "a2a";
/** Result reference recorded when a task reaches a terminal state. */
export interface TaskResult {
    finishReason: string;
    finalResponse?: string;
    errorCode?: string;
    errorMessage?: string;
}
export interface TaskRecord {
    taskId: string;
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
export declare class TaskRegistry {
    private readonly historyCapacity;
    private readonly contextMemoryCapacity;
    private tasks;
    private readonly history;
    /**
     * taskId -> contextId for every accepted task, surviving deletion so a
     * later message can infer the context of a finished task (bounded).
     */
    private contexts;
    constructor(historyCapacity?: number, contextMemoryCapacity?: number);
    /** Create a task record in the initial `submitted` state. */
    begin(taskId: string, contextId: string, source: TaskSource): TaskRecord;
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
