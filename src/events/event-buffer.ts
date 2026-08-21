/**
 * Ordered relay queue: batching window + offline retention in one bounded
 * queue. The relay pushes {taskId, event} here; a timer (or the
 * post-registration hook) drains it into `reportTaskEvent` batches grouped by
 * task. Items whose send fails stay at the head until the hub is ready again.
 */
import { TASK_EVENT_KINDS, type RelayEvent } from "../protocol.js";
import type { HubConnectionManager } from "../connection/hub-connection.js";
import type { Logger } from "../services/log-buffer.js";

export interface QueuedEvent {
  taskId: string;
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
   * Send everything the hub accepts, one `reportTaskEvent` (kind=progress)
   * per task. Returns the number of tasks flushed; failed tasks keep their
   * events queued for the next drain.
   */
  async drain(hub: HubConnectionManager, log: Logger): Promise<number> {
    if (this.queue.length === 0 || !hub.isReady) return 0;
    const byTask = new Map<string, RelayEvent[]>();
    for (const item of this.queue) {
      const list = byTask.get(item.taskId);
      if (list) list.push(item.event);
      else byTask.set(item.taskId, [item.event]);
    }
    const flushed = new Set<string>();
    for (const [taskId, events] of byTask) {
      const last = events[events.length - 1];
      const ok = await hub.reportTaskEvent({
        taskId,
        kind: TASK_EVENT_KINDS.PROGRESS,
        data: { seq: last?.seq ?? 0, events },
        timestampUtc: new Date().toISOString(),
      });
      if (ok) flushed.add(taskId);
      else log.warn("events", `progress batch for ${taskId} not delivered (${events.length} events kept)`, taskId);
    }
    if (flushed.size > 0) {
      this.queue = this.queue.filter((item) => !flushed.has(item.taskId));
    }
    return flushed.size;
  }

  clear(): void {
    this.queue = [];
  }
}
