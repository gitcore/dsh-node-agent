/**
 * Real ClusterLinkHub contract types, event whitelist, and plugin
 * configuration. Pure module: no Node-only or cordis imports, so the client
 * half can type-import from here without dragging host code.
 */
import { readFileSync } from "node:fs";
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
/**
 * Fallback config file location when the process env carries no SUNSET_*
 * values (e.g. an externally managed production instance whose env cannot be
 * changed): `$DSH_HOME/dsh-node-agent.json`, or the path in SUNSET_CONFIG_FILE.
 */
export const DEFAULT_CONFIG_FILE = "/data/dsh-home/dsh-node-agent.json";
function positiveInt(value, fallback) {
    if (!value)
        return fallback;
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}
export function loadConfig(env = process.env) {
    const fromEnv = {
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
    // When the process env lacks the required node identity (externally managed
    // production instance), fall back to the config file so the plugin still
    // loads without touching the host's environment.
    if (fromEnv.nodeToken && fromEnv.nodeId)
        return fromEnv;
    const file = readConfigFile(env.SUNSET_CONFIG_FILE ?? DEFAULT_CONFIG_FILE);
    return {
        ...fromEnv,
        hubUrl: file.hubUrl ?? fromEnv.hubUrl,
        nodeToken: file.nodeToken ?? fromEnv.nodeToken,
        nodeId: file.nodeId ?? fromEnv.nodeId,
        maxConcurrency: file.maxConcurrency ?? fromEnv.maxConcurrency,
        heartbeatIntervalMs: file.heartbeatIntervalMs ?? fromEnv.heartbeatIntervalMs,
        eventBatchMs: file.eventBatchMs ?? fromEnv.eventBatchMs,
        eventBufferSize: file.eventBufferSize ?? fromEnv.eventBufferSize,
        logBufferSize: file.logBufferSize ?? fromEnv.logBufferSize,
        workspace: file.workspace ?? fromEnv.workspace,
        dshVersion: file.dshVersion ?? fromEnv.dshVersion,
    };
}
/** Read and validate the fallback config file; missing/malformed → defaults. */
export function readConfigFile(path) {
    try {
        const raw = readFileSync(path, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
            return {};
        const record = parsed;
        const pickString = (key) => (typeof record[key] === "string" && record[key] !== "" ? record[key] : undefined);
        const pickInt = (key) => (typeof record[key] === "number" && Number.isFinite(record[key]) && record[key] > 0 ? record[key] : undefined);
        return {
            hubUrl: pickString("hubUrl"),
            nodeToken: pickString("nodeToken"),
            nodeId: pickString("nodeId"),
            maxConcurrency: pickInt("maxConcurrency"),
            heartbeatIntervalMs: pickInt("heartbeatIntervalMs"),
            eventBatchMs: pickInt("eventBatchMs"),
            eventBufferSize: pickInt("eventBufferSize"),
            logBufferSize: pickInt("logBufferSize"),
            workspace: pickString("workspace"),
            dshVersion: pickString("dshVersion"),
        };
    }
    catch {
        return {};
    }
}
