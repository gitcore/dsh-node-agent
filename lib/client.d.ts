import type { ClientContext } from "@deepseek-ai/dsh-client-runtime/client";
import type { ActiveTaskView, ClusterStatusView, MetricsView } from "./protocol.js";
import type { LogEntry } from "./services/log-buffer.js";
declare module "@deepseek-ai/dsh-typert-protocol" {
    interface TypertRemoteNamespaceMap {
        clusterService: {
            getStatus(): Promise<ClusterStatusView>;
            getActiveTasks(): Promise<ActiveTaskView[]>;
            getLogs(level?: string): Promise<LogEntry[]>;
            getMetrics(): Promise<MetricsView>;
        };
    }
}
export declare const name = "dsh-sunset-agent";
export declare function apply(ctx: ClientContext): void;
