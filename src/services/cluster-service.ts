/**
 * clusterService: the TypertRemoteService the client UI polls. Registered as
 * a Cordis service named `clusterService`; the api-gateway discovers the
 * @Remote methods at runtime (SRC mode) — no generated Typert code needed.
 */
import type { Context } from "@deepseek-ai/cordis";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import type { ActiveTaskView, ClusterStatusView, MetricsView, PluginConfig } from "../protocol.js";
import type { HubConnectionManager } from "../connection/hub-connection.js";
import type { TaskRegistry } from "../task/task-registry.js";
import type { IntakeCounters } from "../task/task-intake.js";
import type { EventBuffer } from "../events/event-buffer.js";
import type { LogBuffer, LogEntry } from "./log-buffer.js";

export interface ClusterServiceDeps {
  hub: HubConnectionManager;
  registry: TaskRegistry;
  logBuffer: LogBuffer;
  eventBuffer: EventBuffer;
  config: PluginConfig;
  counters: IntakeCounters;
}

export class ClusterService extends TypertRemoteService {
  constructor(
    ctx: Context,
    private readonly deps: ClusterServiceDeps,
  ) {
    super(ctx, "clusterService");
  }

  @Remote
  getStatus(): ClusterStatusView {
    const { hub, registry, config, counters, eventBuffer } = this.deps;
    const snapshot = hub.registeredSnapshot;
    const active = registry.activeCount();
    return {
      state: hub.state,
      connected: hub.isConnected,
      registered: hub.isReady,
      hubUrl: config.hubUrl,
      nodeId: config.nodeId,
      dshVersion: config.dshVersion,
      maxConcurrency: config.maxConcurrency,
      activeTasks: active,
      totalTasks: counters.processedTasks + counters.failedTasks + active,
      failedTasks: counters.failedTasks,
      connectedForMs: hub.connectedForMs,
      connectionId: snapshot?.connectionId ?? null,
      lastHeartbeatUtc: snapshot?.lastHeartbeatUtc ?? null,
      bufferSize: eventBuffer.size,
    };
  }

  @Remote
  getActiveTasks(): ActiveTaskView[] {
    const { registry } = this.deps;
    const now = Date.now();
    return registry.listActive().map((record) => ({
      taskId: record.taskId,
      status: record.status,
      source: record.source,
      startedAt: record.startedAt,
      elapsedMs: now - record.startedAt,
      lastEventType: record.lastEventType,
    }));
  }

  @Remote
  getLogs(level?: string): LogEntry[] {
    return this.deps.logBuffer.list(level);
  }

  @Remote
  getMetrics(): MetricsView {
    const { hub, counters, eventBuffer } = this.deps;
    return {
      connectedForMs: hub.connectedForMs,
      processedTasks: counters.processedTasks,
      failedTasks: counters.failedTasks,
      reportsSent: hub.eventMetrics.reportsSent,
      reportsFailed: hub.eventMetrics.reportsFailed,
      bufferSize: eventBuffer.size,
      droppedEvents: eventBuffer.droppedCount,
    };
  }
}
