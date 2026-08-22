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
