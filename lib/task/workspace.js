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
import { mkdir } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
/** True when `path` resolves inside (or equals) one of the allowed roots. */
function withinRoots(path, roots) {
    return roots.some((root) => {
        const rel = relative(resolve(root), resolve(path));
        return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    });
}
/**
 * Resolve a workspace hint; returns undefined when no workspace applies.
 * Path hints are only honored inside the configured workspace roots
 * (cluster-link-hub-api §8); id/title lookups are unaffected.
 */
export async function resolveWorkspace(ctx, config, hint, log) {
    if (typeof hint !== "string" || hint.trim().length === 0)
        return undefined;
    const value = hint.trim();
    const registry = ctx.get("workspaceRegistry");
    if (!registry)
        return undefined;
    const pathAllowed = config.workspaceRoots.length === 0 || withinRoots(value, config.workspaceRoots);
    try {
        let workspace = registry.get(value);
        if (!workspace)
            workspace = registry.list().find((w) => w.title === value);
        if (!workspace && isAbsolute(value) && pathAllowed) {
            try {
                workspace = await registry.resolveByPath(value);
            }
            catch {
                /* hint is not a resolvable path */
            }
        }
        if (!workspace) {
            if (!isAbsolute(value))
                return undefined;
            if (!pathAllowed) {
                log.warn("intake", `workspace hint ${JSON.stringify(value)} is outside the allowed workspace roots (${JSON.stringify(config.workspaceRoots)}); using the default workspace`);
                return undefined;
            }
            // The dispatcher named a directory the node doesn't own yet — create it
            // on disk (mkdir -p) and register it (durable, reusable; create() reuses
            // an existing record for the path). Without a real directory the session
            // cwd cannot be validated and attach always fails.
            try {
                await mkdir(value, { recursive: true });
                // Title as the directory name (e.g. "test"), not the full path.
                workspace = await registry.create(value, basename(value));
                log.info("intake", `created workspace for ${value}`);
            }
            catch (error) {
                log.warn("intake", `workspace hint ${JSON.stringify(value)} is neither id/title nor a usable path: ${error instanceof Error ? error.message : String(error)}`);
                return undefined;
            }
        }
        const target = workspace;
        // Enforce the root restriction on the resolved workspace too, so a
        // pre-registered record can't smuggle in a path outside the sandbox.
        if (config.workspaceRoots.length > 0 && !withinRoots(target.path, config.workspaceRoots)) {
            log.warn("intake", `workspace ${JSON.stringify(target.title)} path ${JSON.stringify(target.path)} is outside the allowed workspace roots; using the default workspace`);
            return undefined;
        }
        // Membership requires the session cwd to resolve on disk; make sure the
        // registered path is a real directory before handing it out.
        await mkdir(target.path, { recursive: true });
        return {
            path: target.path,
            attach: (sessionId) => target.attachSession(sessionId),
        };
    }
    catch {
        return undefined;
    }
}
