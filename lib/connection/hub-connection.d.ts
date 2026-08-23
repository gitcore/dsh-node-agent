import type { ClusterA2AMessage, ClusterA2AMessageEnvelope, ClusterNodeSnapshot, ClusterTaskDispatch, ClusterTaskEvent, PluginConfig } from "../protocol.js";
import { ReconnectPolicy } from "./reconnect-policy.js";
import type { Logger } from "../services/log-buffer.js";
export type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting" | "misconfigured";
export interface HubCallbacks {
    onStateChange(state: ConnectionState): void;
    /** Fired right after a successful (re-)registration — the drain hook for the event buffer. */
    onRegistered(): void;
    onTaskDispatched(payload: ClusterTaskDispatch): void;
    onA2AMessage(message: ClusterA2AMessageEnvelope): void;
    onTaskEventReceived(event: ClusterTaskEvent): void;
}
export interface HubEventMetrics {
    reportsSent: number;
    reportsFailed: number;
}
export declare function errorMessage(error: unknown): string;
export declare class HubConnectionManager {
    private readonly config;
    private readonly callbacks;
    private readonly log;
    private readonly policy;
    private connection;
    private _state;
    private registered;
    private connectedAt;
    private stopped;
    private heartbeatTimer;
    private retryTimer;
    private retryAttempt;
    private snapshot;
    private readonly metrics;
    constructor(config: PluginConfig, callbacks: HubCallbacks, log: Logger, policy?: ReconnectPolicy);
    get state(): ConnectionState;
    /** Connected AND registered: the only state in which hub calls succeed. */
    get isReady(): boolean;
    get isConnected(): boolean;
    get registeredSnapshot(): ClusterNodeSnapshot | undefined;
    get connectedForMs(): number;
    get eventMetrics(): HubEventMetrics;
    start(): Promise<void>;
    /** Manual-connect entrypoint: idempotent, safe while auto-retry is pending. */
    requestConnect(): ConnectionState;
    private starting;
    private runStart;
    private scheduleRetry;
    private register;
    private startHeartbeat;
    private heartbeat;
    /** Report one task event; returns false when the hub is not ready (caller buffers). */
    reportTaskEvent(event: ClusterTaskEvent): Promise<boolean>;
    sendA2AMessage(message: ClusterA2AMessage): Promise<ClusterA2AMessageEnvelope | undefined>;
    stop(): Promise<void>;
    private setState;
    private clearHeartbeat;
    private safe;
}
