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

export class ContextRegistry {
  private readonly contexts = new Map<string, ContextRecord>();

  constructor(private readonly log: Logger) {}

  has(contextId: string): boolean {
    return this.contexts.has(contextId);
  }

  get(contextId: string): ContextRecord | undefined {
    return this.contexts.get(contextId);
  }

  /** All context records (insertion order). */
  list(): ContextRecord[] {
    return [...this.contexts.values()];
  }

  /**
   * Provision a brand-new A2A context record.
   */
  create(contextId: string, workspace?: { resolved: string | undefined; hint: string | undefined }): ContextRecord {
    if (this.contexts.has(contextId)) throw new Error(`context ${contextId} already exists`);
    const record: ContextRecord = {
      contextId,
      activeTaskId: null,
      queuedTaskIds: [],
      ...(workspace?.resolved ? { workspace: workspace.resolved } : {}),
      ...(workspace?.hint ? { workspaceHint: workspace.hint } : {}),
    };
    this.contexts.set(contextId, record);
    return record;
  }

  /** Recreate the persisted A2A context after a node restart. */
  restore(
    contextId: string,
    workspace?: { resolved: string | undefined; hint: string | undefined },
  ): ContextRecord {
    const normalizedContextId = contextId.trim();
    if (!normalizedContextId) throw new Error("contextId is required");

    const existing = this.contexts.get(normalizedContextId);
    if (existing) return existing;
    const record: ContextRecord = {
      contextId: normalizedContextId,
      activeTaskId: null,
      queuedTaskIds: [],
      ...(workspace?.resolved ? { workspace: workspace.resolved } : {}),
      ...(workspace?.hint ? { workspaceHint: workspace.hint } : {}),
    };
    this.contexts.set(normalizedContextId, record);
    this.log.info("intake", `restored A2A context ${normalizedContextId}`);
    return record;
  }

  /** Remove an unstarted context after runtime-handle creation failed. */
  delete(contextId: string): void {
    const record = this.contexts.get(contextId);
    if (!record) return;
    if (record.activeTaskId || record.queuedTaskIds.length > 0) {
      throw new Error(`context ${contextId} cannot be removed while work is active`);
    }
    this.contexts.delete(contextId);
  }

  enqueueTask(contextId: string, taskId: string): void {
    const record = this.require(contextId);
    record.queuedTaskIds.push(taskId);
  }

  dequeueHead(contextId: string): string | undefined {
    const record = this.require(contextId);
    return record.queuedTaskIds.shift();
  }

  setActiveTask(contextId: string, taskId: string | null): void {
    this.require(contextId).activeTaskId = taskId;
  }

  private require(contextId: string): ContextRecord {
    const record = this.contexts.get(contextId);
    if (!record) throw new Error(`context ${contextId} does not exist`);
    return record;
  }
}
