/**
 * Real ClusterLinkHub contract types, event whitelist, and plugin
 * configuration. Pure module: no Node-only or cordis imports, so the client
 * half can type-import from here without dragging host code.
 */
/** A2A message type the coordinator uses to dispatch a task to a node. */
export const TASK_REQUEST_TYPE = "task.request";
/** Task-event kinds the node reports via `reportTaskEvent` (caller convention). */
export const TASK_EVENT_KINDS = {
    STARTED: "started",
    PROGRESS: "progress",
    COMPLETED: "completed",
    FAILED: "failed",
};
/**
 * session/event types forwarded to the hub as `progress` events. Everything
 * else (assistant/chunk token stream, user/message prompt text, ...) stays
 * local.
 */
export const EVENT_WHITELIST = new Set([
    "turn/start",
    "turn/end",
    "step/start",
    "step/end",
    "tool/call",
    "tool/result",
    "agent/status",
    "subagent/start",
    "subagent/end",
]);
export const DEFAULT_HUB_URL = "http://localhost:5080/cluster-link/hub";
export const DEFAULT_DSH_VERSION = "0.1.0-rc.8";
function positiveInt(value, fallback) {
    if (!value)
        return fallback;
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}
export function loadConfig(env = process.env) {
    return {
        hubUrl: env.SUNSET_HUB_URL ?? DEFAULT_HUB_URL,
        nodeToken: env.SUNSET_NODE_TOKEN ?? "",
        nodeId: env.SUNSET_NODE_ID ?? "",
        maxConcurrency: positiveInt(env.SUNSET_MAX_CONCURRENCY, 4),
        heartbeatIntervalMs: positiveInt(env.SUNSET_HEARTBEAT_INTERVAL_MS, 30_000),
        eventBatchMs: positiveInt(env.SUNSET_EVENT_BATCH_MS, 100),
        eventBufferSize: positiveInt(env.SUNSET_EVENT_BUFFER_SIZE, 1000),
        logBufferSize: positiveInt(env.SUNSET_LOG_BUFFER_SIZE, 500),
        workspace: env.SUNSET_WORKSPACE ?? process.cwd(),
        dshVersion: env.SUNSET_DSH_VERSION ?? DEFAULT_DSH_VERSION,
    };
}
