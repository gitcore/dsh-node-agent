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
    /** A2A conversation context (= session key); echoed in every reported task event. */
    contextId: string;
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
    private readonly contextMemoryCapacity;
    private tasks;
    /** Live agent handles keyed by session key (= A2A contextId). */
    private handles;
    /** taskId → contextId for every accepted task (survives deletion; bounded). */
    private contexts;
    private readonly history;
    constructor(historyCapacity?: number, contextMemoryCapacity?: number);
    begin(taskId: string, source: TaskSource, contextId: string): TaskRecord;
    /** Last known contextId of a task — including finished/deleted ones (bounded memory). */
    knownContextOf(taskId: string): string | undefined;
    get(taskId: string): TaskRecord | undefined;
    has(taskId: string): boolean;
    attachHandle(taskId: string, handle: AgentHandle): void;
    getHandleBySession(sessionKey: string): AgentHandle | undefined;
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
     * Dispose idle agent handles beyond `keep`, oldest first (handles whose
     * context has no active task = completed). Disposing removes their sessions
     * from the live store, so old task conversations age out of the sidebar in
     * bounded numbers. Returns the disposed session keys.
     */
    disposeIdleBeyond(keep: number): Promise<string[]>;
    /** Stop and dispose every live handle (plugin unload). */
    disposeAll(): Promise<void>;
}
