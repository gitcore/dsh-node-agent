/** A2A message type the coordinator uses to dispatch a task to a node. */
export declare const TASK_REQUEST_TYPE: "task.request";
/** Task-event kinds the node reports via `reportTaskEvent` (caller convention). */
export declare const TASK_EVENT_KINDS: {
    readonly STARTED: "started";
    readonly PROGRESS: "progress";
    readonly COMPLETED: "completed";
    readonly FAILED: "failed";
};
export type TaskEventKind = (typeof TASK_EVENT_KINDS)[keyof typeof TASK_EVENT_KINDS];
/** Why a task reached a terminal state. */
export type FinishReason = "completed" | "error" | "blocked" | "aborted";
export interface LinkInfo {
    protocol: "dsh" | "index";
    displayName?: string | null;
    version?: string | null;
    content?: string | null;
}
export interface ClusterNodeRegistration {
    nodeId: string;
    link: LinkInfo;
}
export interface ClusterNodeSnapshot {
    nodeId: string;
    link: LinkInfo;
    connectionId: string | null;
    registeredAtUtc: string;
    lastHeartbeatUtc: string | null;
    /** Sensitive: the configured node key echoed back. Never log, cache, or use it. */
    key: string | null;
}
export interface ClusterTaskDispatch {
    taskId: string;
    prompt: string;
    metadata?: Record<string, unknown> | null;
}
export interface ClusterTaskEvent {
    taskId: string;
    kind: string;
    message?: string | null;
    data?: Record<string, unknown> | null;
    timestampUtc?: string;
}
export interface ClusterA2AMessage {
    toNodeId: string;
    type: string;
    correlationId?: string | null;
    payload?: Record<string, unknown> | null;
}
export interface ClusterA2AMessageEnvelope {
    messageId: string;
    fromNodeId: string;
    toNodeId: string;
    type: string;
    correlationId: string | null;
    payload: Record<string, unknown> | null;
    timestampUtc: string;
}
/** One relayed session event with its per-task monotonic forward seq. */
export interface RelayEvent {
    seq: number;
    type: string;
    ts: number;
    payload: unknown;
}
/**
 * session/event types forwarded to the hub as `progress` events. Everything
 * else (assistant/chunk token stream, user/message prompt text, ...) stays
 * local.
 */
export declare const EVENT_WHITELIST: Set<string>;
export declare const DEFAULT_HUB_URL = "http://localhost:5080/cluster-link/hub";
export declare const DEFAULT_DSH_VERSION = "0.1.0-rc.8";
/**
 * Fallback config file location when the process env carries no SUNSET_*
 * values (e.g. an externally managed production instance whose env cannot be
 * changed): `$DSH_HOME/dsh-node-agent.json`, or the path in SUNSET_CONFIG_FILE.
 */
export declare const DEFAULT_CONFIG_FILE = "/data/dsh-home/dsh-node-agent.json";
/** JSON shape of the fallback config file (same fields as the env vars). */
export interface PluginConfigFile {
    hubUrl?: string;
    nodeToken?: string;
    nodeId?: string;
    maxConcurrency?: number;
    heartbeatIntervalMs?: number;
    eventBatchMs?: number;
    eventBufferSize?: number;
    logBufferSize?: number;
    workspace?: string;
    dshVersion?: string;
}
/** Resolved plugin configuration (SUNSET_* env vars, see requirements-v3 §4). */
export interface PluginConfig {
    hubUrl: string;
    /** Node key (Bearer token). Never log. */
    nodeToken: string;
    /** Admin-configured positive-integer node id, as string. */
    nodeId: string;
    maxConcurrency: number;
    heartbeatIntervalMs: number;
    eventBatchMs: number;
    eventBufferSize: number;
    logBufferSize: number;
    workspace: string;
    dshVersion: string;
}
export declare function loadConfig(env?: NodeJS.ProcessEnv): PluginConfig;
/** Read and validate the fallback config file; missing/malformed → defaults. */
export declare function readConfigFile(path: string): PluginConfigFile;
export interface ClusterStatusView {
    state: string;
    connected: boolean;
    registered: boolean;
    hubUrl: string;
    nodeId: string;
    dshVersion: string;
    maxConcurrency: number;
    activeTasks: number;
    totalTasks: number;
    failedTasks: number;
    connectedForMs: number;
    connectionId: string | null;
    lastHeartbeatUtc: string | null;
    bufferSize: number;
}
export interface ActiveTaskView {
    taskId: string;
    status: string;
    source: string;
    startedAt: number;
    elapsedMs: number;
    lastEventType?: string;
}
export interface RecentTaskView {
    taskId: string;
    source: string;
    finishReason: string;
    startedAt: number;
    finishedAt: number;
    durationMs: number;
    lastEventType?: string;
}
export interface MetricsView {
    connectedForMs: number;
    processedTasks: number;
    failedTasks: number;
    reportsSent: number;
    reportsFailed: number;
    bufferSize: number;
    droppedEvents: number;
}
