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
export declare class LogBuffer {
    private readonly size;
    private entries;
    constructor(size: number);
    push(entry: LogEntry): void;
    list(level?: string): LogEntry[];
    get length(): number;
}
export interface Logger {
    info(scope: string, message: string, taskId?: string): void;
    warn(scope: string, message: string, taskId?: string): void;
    error(scope: string, message: string, taskId?: string): void;
}
/** Build a logger writing to both the Cordis logger and the ring buffer. */
export declare function createLogger(ctx: Context, buffer: LogBuffer, nodeId: string): Logger;
