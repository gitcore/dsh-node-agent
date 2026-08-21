/**
 * dsh-node-agent — Host half. Mounts the SignalR node connection to the
 * ClusterLinkHub, task intake/execution via ctx.agents.create, event relay,
 * and the clusterService remote face for the client UI.
 *
 * Error-isolation stance: apply() only wires effects; every async path is
 * caught and logged — the plugin must never throw into the Host.
 */
import type { Context } from "@deepseek-ai/cordis";
export declare const name = "dsh-node-agent";
/** Required host services; agentDefaultModel is optional (resolved via ctx.get). */
export declare const inject: string[];
export declare function apply(ctx: Context): void;
