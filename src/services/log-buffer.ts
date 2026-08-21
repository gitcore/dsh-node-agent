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
  const emit = (level: LogLevel, scope: string, message: string, taskId?: string): void => {
    // taskId omitted when absent: the gateway's JSON-safety check rejects
    // undefined property values.
    buffer.push({ ts: Date.now(), level, scope, message, ...(taskId ? { taskId } : {}) });
    const tag = `[node-agent:${nodeId}${taskId ? `:${taskId}` : ""}] ${scope}: ${message}`;
    if (level === "error") ctx.logger.error(tag);
    else if (level === "warn") ctx.logger.warn(tag);
    else ctx.logger.info(tag);
  };
  return {
    info: (scope, message, taskId?) => emit("info", scope, message, taskId),
    warn: (scope, message, taskId?) => emit("warn", scope, message, taskId),
    error: (scope, message, taskId?) => emit("error", scope, message, taskId),
  };
}
