import type { InjectFace, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type { ActiveTaskView, ClusterStatusView, MetricsView } from "./protocol.js";
import type { LogEntry } from "./services/log-buffer.js";
export interface ClusterPanelFace {
    getStatus(): Promise<ClusterStatusView>;
    getActiveTasks(): Promise<ActiveTaskView[]>;
    getLogs(level?: string): Promise<LogEntry[]>;
    getMetrics(): Promise<MetricsView>;
}
export type ClusterPanelProps = PropsRuntime<"sidebar.footer.action"> & InjectFace<ClusterPanelFace>;
export declare function ClusterPanel({ wide, getStatus, getActiveTasks, getLogs, getMetrics }: ClusterPanelProps): React.JSX.Element | null;
