/**
 * Workspace resolution for dispatched tasks: a task can name the workspace
 * its session should live in (so the web-ui sidebar groups it under that
 * workspace instead of "未分组"). The hint may be a workspace id, a display
 * title, or a directory path.
 *
 * Membership is two-sided (dsh-workspace): the session header's canonical cwd
 * must equal the workspace path, AND the session must be attached to the
 * workspace's candidate account. This module resolves the hint to a target
 * (cwd path + attach callback) and the intake applies both.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Logger } from "../services/log-buffer.js";
export interface WorkspaceTarget {
    /** Canonical directory path to use as the session cwd. */
    path: string;
    /** Attach the session to the workspace's candidate account. */
    attach(sessionId: string): Promise<void>;
}
/** Resolve a workspace hint; returns undefined when no workspace applies. */
export declare function resolveWorkspace(ctx: Context, hint: unknown, log: Logger): Promise<WorkspaceTarget | undefined>;
