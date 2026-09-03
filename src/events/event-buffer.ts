/**
 * Ordered relay queue: batching window + offline retention in one bounded
 * queue. The relay pushes {taskId, event} here; a timer (or the
 * post-registration hook) drains it locally. A2A task state is reported by
 * TaskIntake through the v2 DSH payload channel; relay diagnostics stay local.
 */
import type { RelayEvent } from "../protocol.js";
import type { HubConnectionManager } from "../connection/hub-connection.js";
import type { Logger } from "../services/log-buffer.js";

export interface QueuedEvent {
  taskId: string;
  /** A2A conversation context, echoed in the progress report. */
  contextId?: string;
  event: RelayEvent;
}

export class EventBuffer {
  private queue: QueuedEvent[] = [];
  private dropped = 0;

  constructor(private readonly capacity: number) {}

  push(item: QueuedEvent): void {
    this.queue.push(item);
    if (this.queue.length > this.capacity) {
      this.queue.shift();
      this.dropped++;
    }
  }

  get size(): number {
    return this.queue.length;
  }

  get droppedCount(): number {
    return this.dropped;
  }

  /**
   * Relay diagnostics are not an A2A task-status schema, so they are never
   * sent through ClusterLink v2. Draining clears the local queue.
   */
  async drain(hub: HubConnectionManager, log: Logger): Promise<number> {
    if (this.queue.length === 0 || !hub.isReady) return 0;
    const flushed = this.queue.length;
    this.queue = [];
    return flushed;
  }

  clear(): void {
    this.queue = [];
  }

  private contextOf(taskId: string): string | undefined {
    return this.contextResolver?.(taskId);
  }

  /** Optional hook so the drain can echo the record's A2A contextId. */
  setContextResolver(resolve: (taskId: string) => string | undefined): void {
    this.contextResolver = resolve;
  }

  private contextResolver: ((taskId: string) => string | undefined) | undefined;
}
