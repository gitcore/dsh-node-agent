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
export declare class TaskRegistry {
    private tasks;
    private handles;
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
    delete(taskId: string): void;
    /** Stop and dispose every live handle (plugin unload). */
    disposeAll(): Promise<void>;
}
