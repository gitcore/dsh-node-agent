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

export class ContextRegistry {
  private readonly contexts = new Map<string, ContextRecord>();
  private readonly byDshSession = new Map<string, string>();

  constructor(private readonly log: Logger) {}

  has(contextId: string): boolean {
    return this.contexts.has(contextId);
  }

  get(contextId: string): ContextRecord | undefined {
    return this.contexts.get(contextId);
  }

  /** Reverse lookup: which context owns this DSH session. */
  contextIdByDshSession(dshSessionId: string): string | undefined {
    return this.byDshSession.get(dshSessionId);
  }

  /** All context records (insertion order). */
  list(): ContextRecord[] {
    return [...this.contexts.values()];
  }

  /**
   * Provision a brand-new context record. The dshSessionId is empty until
   * {@link confirmSession} records the DSH-confirmed canonical value.
   */
  create(contextId: string, workspace?: { resolved: string | undefined; hint: string | undefined }): ContextRecord {
    if (this.contexts.has(contextId)) throw new Error(`context ${contextId} already exists`);
    const record: ContextRecord = {
      contextId,
      dshSessionId: "",
      activeTaskId: null,
      queuedTaskIds: [],
      ...(workspace?.resolved ? { workspace: workspace.resolved } : {}),
      ...(workspace?.hint ? { workspaceHint: workspace.hint } : {}),
    };
    this.contexts.set(contextId, record);
    return record;
  }

  /** Store the DSH-confirmed canonical session id and build the reverse index. */
  confirmSession(contextId: string, dshSessionId: string): void {
    const record = this.contexts.get(contextId);
    if (!record) throw new Error(`context ${contextId} does not exist`);
    if (record.dshSessionId && record.dshSessionId !== dshSessionId) throw new Error(`context ${contextId} already bound to another DSH session`);
    record.dshSessionId = dshSessionId;
    this.byDshSession.set(dshSessionId, contextId);
  }

  /** Remove a provisioned record that never got a confirmed session (creation failure rollback). */
  deleteIfUnconfirmed(contextId: string): void {
    const record = this.contexts.get(contextId);
    if (!record || record.dshSessionId) return;
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
