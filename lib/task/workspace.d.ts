import type { Context } from "@deepseek-ai/cordis";
import type { PluginConfig } from "../protocol.js";
import type { Logger } from "../services/log-buffer.js";
export interface WorkspaceTarget {
    /** Canonical directory path to use as the session cwd. */
    path: string;
    /** Attach the session to the workspace's candidate account. */
    attach(sessionId: string): Promise<void>;
}
/**
 * Resolve a workspace hint; returns undefined when no workspace applies.
 * Path hints are only honored inside the configured workspace roots
 * (cluster-link-hub-api §8); id/title lookups are unaffected.
 */
export declare function resolveWorkspace(ctx: Context, config: PluginConfig, hint: unknown, log: Logger): Promise<WorkspaceTarget | undefined>;
