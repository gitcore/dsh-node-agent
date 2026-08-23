/**
 * Real ClusterLinkHub contract types, event whitelist, and plugin
 * configuration. Pure module: no Node-only or cordis imports, so the client
 * half can type-import from here without dragging host code.
 */
import { readFileSync } from "node:fs";

/** Task-event kinds the node reports via `reportTaskEvent` (caller convention). */
export const TASK_EVENT_KINDS = {
  STARTED: "started",
  PROGRESS: "progress",
  COMPLETED: "completed",
  FAILED: "failed",
} as const;
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
  /** A2A conversation context; interpreted by the node, echoed in task events. */
  contextId?: string | null;
  prompt: string;
  metadata?: Record<string, unknown> | null;
}

export interface ClusterTaskEvent {
  taskId: string;
  /** A2A conversation context; echoed from the dispatch once known. */
  contextId?: string | null;
  kind: string;
  message?: string | null;
  data?: Record<string, unknown> | null;
  timestampUtc?: string;
}

/** Official A2A v1 `Message` model (from `@a2a-js/sdk`, wire-compatible with the hub's .NET A2A model). */
export type A2AMessage = import("@a2a-js/sdk").Message;

export interface ClusterA2AMessage {
  toNodeId: string;
  correlationId?: string | null;
  message: A2AMessage;
}

export interface ClusterA2AMessageEnvelope {
  /** ClusterLink delivery id for dedupe/audit — NOT the A2A messageId. */
  messageId: string;
  fromNodeId: string;
  toNodeId: string;
  correlationId: string | null;
  message: A2AMessage;
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

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PluginConfig {
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
    workspaceRoots: parseRoots(env.SUNSET_WORKSPACE_ROOTS),
    dshVersion: env.SUNSET_DSH_VERSION ?? DEFAULT_DSH_VERSION,
  };
  // When the process env lacks the required node identity (externally managed
  // production instance), fall back to the config file so the plugin still
  // loads without touching the host's environment.
  if (fromEnv.nodeToken && fromEnv.nodeId) return fromEnv;
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
    workspaceRoots: file.workspaceRoots ?? fromEnv.workspaceRoots,
    dshVersion: file.dshVersion ?? fromEnv.dshVersion,
  };
}

/** Parse a PATH-style (":") separated root list; empty entries are dropped. */
function parseRoots(value: string | undefined): string[] {
  return (value ?? "").split(":").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

/** Read and validate the fallback config file; missing/malformed → defaults. */
export function readConfigFile(path: string): PluginConfigFile {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    const pickString = (key: string): string | undefined => (typeof record[key] === "string" && record[key] !== "" ? (record[key] as string) : undefined);
    const pickInt = (key: string): number | undefined => (typeof record[key] === "number" && Number.isFinite(record[key] as number) && (record[key] as number) > 0 ? (record[key] as number) : undefined);
    const pickRoots = (): string[] | undefined => {
      const raw = record["workspaceRoots"];
      if (!Array.isArray(raw)) return undefined;
      const roots = raw.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim());
      return roots.length > 0 ? roots : undefined;
    };
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
      workspaceRoots: pickRoots(),
      dshVersion: pickString("dshVersion"),
    };
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------------ */
/* Remote view types served to the client UI via clusterService.      */
/* ------------------------------------------------------------------ */

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
