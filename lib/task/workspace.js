/** Resolve a workspace hint; returns undefined when no workspace applies. */
export async function resolveWorkspace(ctx, hint, log) {
    if (typeof hint !== "string" || hint.trim().length === 0)
        return undefined;
    const value = hint.trim();
    const registry = ctx.get("workspaceRegistry");
    if (!registry)
        return undefined;
    try {
        let workspace = registry.get(value);
        if (!workspace)
            workspace = registry.list().find((w) => w.title === value);
        if (!workspace) {
            try {
                workspace = await registry.resolveByPath(value);
            }
            catch {
                /* hint is not a resolvable path */
            }
        }
        if (!workspace) {
            // The dispatcher named a directory the node doesn't own yet — register it
            // (durable, reusable; create() reuses an existing record for the path).
            try {
                workspace = await registry.create(value);
                log.info("intake", `created workspace for ${value}`);
            }
            catch (error) {
                log.warn("intake", `workspace hint ${JSON.stringify(value)} is neither id/title nor a usable path: ${error instanceof Error ? error.message : String(error)}`);
                return undefined;
            }
        }
        const target = workspace;
        return {
            path: target.path,
            attach: (sessionId) => target.attachSession(sessionId),
        };
    }
    catch {
        return undefined;
    }
}
