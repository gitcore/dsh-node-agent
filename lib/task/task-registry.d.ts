/**
 * Task registry: task-session mapping (sessionId == taskId), status, per-task
 * forward seq, and live AgentHandle ownership for teardown.
 */
import type { AgentHandle } from "@deepseek-ai/dsh-agent";
import type { FinishReason } from "../protocol.js";
export type TaskStatus = "starting" | "running" | "completed" | "failed";
export type TaskSource = "taskDispatched" | "a2a";
export interface TaskRecord {
    taskId: string;
    status: TaskStatus;
    source: TaskSource;
    startedAt: number;
    finishedAt?: number;
    lastEventType?: string;
    lastEventAt?: number;
    finishReason?: FinishReason;
    /** Last assigned per-task forward seq. */
    seq: number;
}
/** Bounded terminal history entry — survives registry deletion so the panel
 * can show recently finished tasks without catching them mid-run. */
export interface TaskHistoryEntry {
    taskId: string;
    source: TaskSource;
    finishReason: FinishReason;
    startedAt: number;
    finishedAt: number;
    durationMs: number;
    lastEventType?: string;
    /** Final assistant response text (from the turn/end outcome). */
    finalResponse?: string;
}
export declare class TaskRegistry {
    private readonly historyCapacity;
    private tasks;
    private handles;
    private readonly history;
    constructor(historyCapacity?: number);
    begin(taskId: string, source: TaskSource): TaskRecord;
    get(taskId: string): TaskRecord | undefined;
    has(taskId: string): boolean;
    attachHandle(taskId: string, handle: AgentHandle): void;
    getHandle(taskId: string): AgentHandle | undefined;
    setRunning(taskId: string): void;
    touch(taskId: string, eventType: string): void;
    nextSeq(taskId: string): number;
    finish(taskId: string, finishReason: FinishReason): TaskRecord | undefined;
    /** Tasks still occupying a concurrency slot. */
    activeCount(): number;
    list(): TaskRecord[];
    listActive(): TaskRecord[];
    /**
     * Remove the task record only. The AgentHandle is intentionally KEPT: the
     * agent's session must stay live after completion so the web-ui sidebar
     * keeps the conversation and the user can open it to read the result.
     * Idle handles are capped by {@link disposeIdleBeyond}.
     */
    delete(taskId: string): void;
    /** Recent finished tasks, newest first (bounded). */
    recent(): TaskHistoryEntry[];
    /** Record a terminal outcome into the bounded history. */
    archive(taskId: string, finishReason: FinishReason, source: TaskSource, finalResponse?: string): void;
    /**
     * Dispose idle agent handles beyond `keep`, oldest first (handles whose task
     * record is gone = completed). Disposing removes their sessions from the
     * live store, so old task conversations age out of the sidebar in bounded
     * numbers. Returns the disposed taskIds.
     */
    disposeIdleBeyond(keep: number): Promise<string[]>;
    /** Stop and dispose every live handle (plugin unload). */
    disposeAll(): Promise<void>;
}
