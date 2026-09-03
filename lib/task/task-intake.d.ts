import type { Context } from "@deepseek-ai/cordis";
import type { ClusterLinkPayloadEnvelope, PluginConfig } from "../protocol.js";
import { type HubConnectionManager } from "../connection/hub-connection.js";
import { ContextRegistry } from "./context-registry.js";
import { type TaskRegistry } from "./task-registry.js";
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
    private readonly contexts;
    private readonly hub;
    private readonly relay;
    private readonly log;
    private readonly counters;
    private readonly selection;
    /** Live agent handles keyed by A2A contextId. */
    private readonly handles;
    /** Runtime agent ids are callback-routing details only; never persisted. */
    private readonly contextByRuntimeAgentId;
    /** Per-context turn FIFO: prompts into one conversation never interleave. */
    private readonly sessionQueues;
    /** Next prompt per queued task (the context FIFO only carries task ids). */
    private readonly pendingTurns;
    constructor(ctx: Context, config: PluginConfig, registry: TaskRegistry, contexts: ContextRegistry, hub: HubConnectionManager, relay: EventRelay, log: Logger, counters: IntakeCounters);
    onPayloadDispatched(envelope: ClusterLinkPayloadEnvelope): void;
    private accept;
    /** First contact (or a context-less dispatch): create context + task. */
    private startNewContextTask;
    /** Shared tail: register the task record, announce it, and queue its turn. */
    private beginAndQueue;
    /** Workspace binding checks against an existing context. */
    private checkBindingConflicts;
    /** Start the next queued turn unless a task is still active in the context. */
    private pump;
    private enqueueRun;
    private executeTurn;
    private settle;
    /** Announce an A2A state transition as an official TaskStatusUpdateEvent. */
    private emitStatus;
    private acquireSessionHandle;
    /** Used only by EventRelay for transient local callback attribution. */
    contextIdForRuntimeAgent(runtimeAgentId: string): string | undefined;
    /** Report one task event with the record's A2A contextId echoed. */
    private report;
    private reportWith;
    /** Dispose idle conversation handles beyond the cap, oldest first. */
    private enforceIdleCap;
    /** Stop and dispose every live conversation handle (plugin unload). */
    disposeAll(): Promise<void>;
}
