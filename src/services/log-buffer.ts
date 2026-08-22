/**
 * In-memory log ring buffer (queried by the client UI) plus a small logger
 * that mirrors every entry to the Cordis logger for the console.
 */
import type { Context } from "@deepseek-ai/cordis";

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  ts: number;
  level: LogLevel;
  scope: string;
  message: string;
  taskId?: string;
}

/** Bounded ring buffer of log entries, newest last. */
export class LogBuffer {
  private entries: LogEntry[] = [];

  constructor(private readonly size: number) {}

  push(entry: LogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.size) this.entries.splice(0, this.entries.length - this.size);
  }

  list(level?: string): LogEntry[] {
    return level === undefined || level === "all" ? [...this.entries] : this.entries.filter((e) => e.level === level);
  }

  get length(): number {
    return this.entries.length;
  }
}

export interface Logger {
  info(scope: string, message: string, taskId?: string): void;
  warn(scope: string, message: string, taskId?: string): void;
  error(scope: string, message: string, taskId?: string): void;
}

/** Build a logger writing to both the Cordis logger and the ring buffer. */
export function createLogger(ctx: Context, buffer: LogBuffer, nodeId: string): Logger {
  // Cordis uses ctx.root.logger("scope") factory style; sandbox context gates
  // framework internals like .root, so we defensively probe for a working
  // logger and fall back to the global console.
  let cordisLog: ((tag: string) => void) | null = null;
  try {
    // NOTE: ctx.root.logger("scope") returns an object with info/warn/error.
    // Any property access off the sandbox ctx that isn't whitelisted throws,
    // so probe through ctx.get() (which is always available).
    const root = (ctx as unknown as { get: (k: string) => unknown }).get("root") as
      | { logger?: (scope: string) => { info: (s: string) => void; warn: (s: string) => void; error: (s: string) => void } }
      | undefined;
    if (typeof root?.logger === "function") {
      const l = root.logger(`node-agent:${nodeId}`);
      cordisLog = (tag: string) => l.info?.(tag);
    }
  } catch {
    /* sandbox denied access, ignore */
  }

  const emit = (level: LogLevel, scope: string, message: string, taskId?: string): void => {
    buffer.push({ ts: Date.now(), level, scope, message, ...(taskId ? { taskId } : {}) });
    const tag = `[node-agent:${nodeId}${taskId ? `:${taskId}` : ""}] ${scope}: ${message}`;
    try {
      if (level === "error") cordisLog?.(`[ERROR] ${tag}`) ?? console.error(tag);
      else if (level === "warn") cordisLog?.(`[WARN ] ${tag}`) ?? console.warn(tag);
      else cordisLog?.(`[INFO ] ${tag}`) ?? console.info(tag);
    } catch {
      /* any logging failure must not break the plugin */
    }
  };
  return {
    info: (scope, message, taskId?) => emit("info", scope, message, taskId),
    warn: (scope, message, taskId?) => emit("warn", scope, message, taskId),
    error: (scope, message, taskId?) => emit("error", scope, message, taskId),
  };
}
