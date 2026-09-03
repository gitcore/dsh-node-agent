/** Why a task reached a terminal state. */
export type FinishReason = "completed" | "error" | "blocked" | "aborted";
export interface LinkInfo {
    displayName?: string | null;
    version?: string | null;
    content?: string | null;
}
export interface ClusterNodeRegistration {
    nodeId: string;
    nodeType: "dsh";
    link: LinkInfo;
}
export interface ClusterNodeSnapshot {
    nodeId: string;
    nodeType: string;
    link: LinkInfo;
    connectionId: string | null;
    registeredAtUtc: string;
    lastHeartbeatUtc: string | null;
    /** Sensitive: the configured node key echoed back. Never log, cache, or use it. */
    key: string | null;
}
/** Official A2A v1 `Message` model (from `@a2a-js/sdk`, wire-compatible with the hub's .NET A2A model). */
export type A2AMessage = import("@a2a-js/sdk").Message;
export interface DshA2APayload {
    workspace?: string;
    /** Reserved DSH payload field. Never used as A2A/Chat context or runtime recovery state. */
    sessionId?: string;
    a2a: Record<string, unknown>;
}
export interface ClusterLinkPayloadEnvelope {
    id: string;
    toNodeId: string;
    correlationId?: string | null;
    payloadType: string;
    payload: DshA2APayload;
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
export declare const DEFAULT_DSH_VERSION = "unknown";
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
    workspaceRoots?: string[];
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
    /**
     * Allowed workspace root directories (hub-api §8): path hints from the hub
     * are only honored when they resolve inside one of these roots. Empty list
     * means unrestricted (not recommended for exposed deployments).
     */
    workspaceRoots: string[];
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
    contextId: string;
    /** A2A task state (submitted/working/input-required/...). */
    status: string;
    source: string;
    startedAt: number;
    elapsedMs: number;
    lastEventType?: string;
}
export interface RecentTaskView {
    taskId: string;
    contextId: string;
    source: string;
    finishReason: string;
    startedAt: number;
    finishedAt: number;
    durationMs: number;
    lastEventType?: string;
    finalResponse?: string;
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
