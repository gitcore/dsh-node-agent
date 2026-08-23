/**
 * Task registry: owns taskId -> contextId + the A2A task lifecycle record
 * (dsh-a2a-context-session-mapping.md "Required registry shape"). A task
 * record never holds a session id; session identity belongs to the context.
 */
import type { AgentHandle } from "@deepseek-ai/dsh-agent";

/** A2A v1 task states (spec §4.1.3 vocabulary used by the mapping doc). */
export const TASK_STATES = ["submitted", "working", "completed", "failed", "canceled", "input-required", "rejected", "auth-required"] as const;
export type TaskState = (typeof TASK_STATES)[number];

const TERMINAL_STATES = new Set<TaskState>(["completed", "failed", "canceled", "rejected"]);

export function isTerminalState(state: TaskState): boolean {
  return TERMINAL_STATES.has(state);
}

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

export class TaskRegistry {
  private tasks = new Map<string, TaskRecord>();
  private readonly history: TaskHistoryEntry[] = [];
  /**
   * taskId -> contextId for every accepted task, surviving deletion so a
   * later message can infer the context of a finished task (bounded).
   */
  private contexts = new Map<string, string>();

  constructor(
    private readonly historyCapacity = 20,
    private readonly contextMemoryCapacity = 1000,
  ) {}

  /** Create a task record in the initial `submitted` state. */
  begin(taskId: string, contextId: string, source: TaskSource): TaskRecord {
    if (this.tasks.has(taskId)) throw new Error(`task ${taskId} already exists`);
    const now = Date.now();
    const record: TaskRecord = { taskId, contextId, source, state: "submitted", createdAt: now, updatedAt: now, seq: 0 };
    this.tasks.set(taskId, record);
    this.contexts.set(taskId, contextId);
    while (this.contexts.size > this.contextMemoryCapacity) {
      const oldest = this.contexts.keys().next().value;
      if (oldest === undefined) break;
      this.contexts.delete(oldest);
    }
    return record;
  }

  get(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  has(taskId: string): boolean {
    return this.tasks.has(taskId);
  }

  /** Last known contextId of a task — including terminal/deleted ones (bounded memory). */
  knownContextOf(taskId: string): string | undefined {
    return this.tasks.get(taskId)?.contextId ?? this.contexts.get(taskId);
  }

  /**
   * Advance a task's state exactly once along legal edges. Terminal states are
   * immutable; only `input-required` may return to `working` (via a follow-up
   * message on the same taskId).
   */
  transition(taskId: string, to: TaskState): TaskRecord | undefined {
    const record = this.tasks.get(taskId);
    if (!record) return undefined;
    if (record.state === to) return record;
    if (isTerminalState(record.state)) throw new Error(`task ${taskId} is terminal (${record.state}); cannot transition to ${to}`);
    if (to === "working" && record.state !== "submitted" && record.state !== "input-required") throw new Error(`task ${taskId}: illegal transition ${record.state} -> working`);
    record.state = to;
    record.updatedAt = Date.now();
    return record;
  }

  /** Attach the terminal result reference; the caller performs the state transition first. */
  setResult(taskId: string, result: TaskResult): void {
    const record = this.tasks.get(taskId);
    if (!record) return;
    record.result = result;
    record.updatedAt = Date.now();
  }

  touch(taskId: string, eventType: string): void {
    const record = this.tasks.get(taskId);
    if (record) {
      record.lastEventType = eventType;
      record.lastEventAt = Date.now();
    }
  }

  nextSeq(taskId: string): number {
    const record = this.tasks.get(taskId);
    if (!record) return 0;
    return ++record.seq;
  }

  /** Tasks still occupying a concurrency slot (non-terminal states). */
  activeCount(): number {
    let count = 0;
    for (const record of this.tasks.values()) {
      if (!isTerminalState(record.state)) count++;
    }
    return count;
  }

  list(): TaskRecord[] {
    return [...this.tasks.values()];
  }

  listActive(): TaskRecord[] {
    return this.list().filter((record) => !isTerminalState(record.state));
  }

  /**
   * Remove the live task record only. The conversation (context) and its
   * session stay untouched; the bounded context map keeps taskId -> contextId
   * so later messages can still resolve the finished task's context.
   */
  delete(taskId: string): void {
    this.tasks.delete(taskId);
  }

  /** Recent finished tasks, newest first (bounded). */
  recent(): TaskHistoryEntry[] {
    return [...this.history];
  }

  /** Record a terminal outcome into the bounded history. */
  archive(taskId: string, state: TaskState, finalResponse?: string): void {
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
    if (this.history.length > this.historyCapacity) this.history.length = this.historyCapacity;
  }
}
