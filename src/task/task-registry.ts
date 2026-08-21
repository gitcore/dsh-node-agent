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

export class TaskRegistry {
  private tasks = new Map<string, TaskRecord>();
  private handles = new Map<string, AgentHandle>();

  begin(taskId: string, source: TaskSource): TaskRecord {
    const record: TaskRecord = { taskId, status: "starting", source, startedAt: Date.now(), seq: 0 };
    this.tasks.set(taskId, record);
    return record;
  }

  get(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  has(taskId: string): boolean {
    return this.tasks.has(taskId);
  }

  attachHandle(taskId: string, handle: AgentHandle): void {
    this.handles.set(taskId, handle);
  }

  getHandle(taskId: string): AgentHandle | undefined {
    return this.handles.get(taskId);
  }

  setRunning(taskId: string): void {
    const record = this.tasks.get(taskId);
    if (record) record.status = "running";
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

  finish(taskId: string, finishReason: FinishReason): TaskRecord | undefined {
    const record = this.tasks.get(taskId);
    if (!record) return undefined;
    record.status = finishReason === "completed" ? "completed" : "failed";
    record.finishReason = finishReason;
    record.finishedAt = Date.now();
    return record;
  }

  /** Tasks still occupying a concurrency slot. */
  activeCount(): number {
    let count = 0;
    for (const record of this.tasks.values()) {
      if (record.status === "starting" || record.status === "running") count++;
    }
    return count;
  }

  list(): TaskRecord[] {
    return [...this.tasks.values()];
  }

  listActive(): TaskRecord[] {
    return this.list().filter((r) => r.status === "starting" || r.status === "running");
  }

  delete(taskId: string): void {
    this.tasks.delete(taskId);
    this.handles.delete(taskId);
  }

  /** Stop and dispose every live handle (plugin unload). */
  async disposeAll(): Promise<void> {
    const handles = [...this.handles.values()];
    this.handles.clear();
    for (const handle of handles) {
      try {
        handle.agent.cancel({ kind: "disposed" });
      } catch {
        /* ignore */
      }
      try {
        await handle.dispose();
      } catch {
        /* ignore */
      }
    }
  }
}
