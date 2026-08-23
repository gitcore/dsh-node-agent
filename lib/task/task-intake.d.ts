import type { Context } from "@deepseek-ai/cordis";
import { type ClusterA2AMessageEnvelope, type ClusterTaskDispatch, type PluginConfig } from "../protocol.js";
import { type HubConnectionManager } from "../connection/hub-connection.js";
import type { TaskRegistry } from "./task-registry.js";
import type { EventRelay } from "../events/event-relay.js";
import type { Logger } from "../services/log-buffer.js";
export interface IntakeCounters {
    processedTasks: number;
    failedTasks: number;
}
export declare class TaskIntake {
    private readonly ctx;
    private readonly config;
    private readonly registry;
    private readonly hub;
    private readonly relay;
    private readonly log;
    private readonly counters;
    private readonly selection;
    constructor(ctx: Context, config: PluginConfig, registry: TaskRegistry, hub: HubConnectionManager, relay: EventRelay, log: Logger, counters: IntakeCounters);
    onTaskDispatched(payload: ClusterTaskDispatch): void;
    onA2AMessage(envelope: ClusterA2AMessageEnvelope): void;
    private accept;
    /** Report one task event with the record's A2A contextId echoed. */
    private report;
    private reportWith;
    /**
     * Serialize turns per conversation: concurrent dispatches into one context
     * run their followups strictly in order instead of interleaving on the
     * shared agent/session.
     */
    private readonly sessionQueues;
    private enqueueRun;
    private runTurn;
    /** Dispose oldest idle agents beyond the cap (their sessions age out). */
    private enforceIdleCap;
}
