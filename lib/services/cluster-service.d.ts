/**
 * clusterService: the TypertRemoteService the client UI polls. Registered as
 * a Cordis service named `clusterService`; the api-gateway discovers the
 * @Remote methods at runtime (SRC mode) — no generated Typert code needed.
 */
import type { Context } from "@deepseek-ai/cordis";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import type { ActiveTaskView, ClusterStatusView, MetricsView, PluginConfig, RecentTaskView } from "../protocol.js";
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
export declare class ClusterService extends TypertRemoteService {
    private readonly deps;
    constructor(ctx: Context, deps: ClusterServiceDeps);
    getStatus(): ClusterStatusView;
    getActiveTasks(): ActiveTaskView[];
    getRecentTasks(): RecentTaskView[];
    getLogs(level?: string): LogEntry[];
    getMetrics(): MetricsView;
    /** Manual connect: idempotent; safe to call while auto-retry is pending. */
    connectToHub(): {
        state: string;
    };
}
