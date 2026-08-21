/**
 * SignalR connection manager for the ClusterLinkHub: connect (WebSockets +
 * skipNegotiation), register the node, heartbeat, report task events, send
 * A2A messages, and re-register on automatic reconnect. Every async path is
 * error-isolated; the node key never touches logs.
 */
import { HubConnectionBuilder, HubConnectionState, HttpTransportType, LogLevel } from "@microsoft/signalr";
import { ReconnectPolicy } from "./reconnect-policy.js";
export function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
export class HubConnectionManager {
    config;
    callbacks;
    log;
    policy;
    connection;
    _state = "disconnected";
    registered = false;
    connectedAt = 0;
    stopped = false;
    heartbeatTimer;
    retryTimer;
    retryAttempt = 0;
    snapshot;
    metrics = { reportsSent: 0, reportsFailed: 0 };
    constructor(config, callbacks, log, policy = new ReconnectPolicy()) {
        this.config = config;
        this.callbacks = callbacks;
        this.log = log;
        this.policy = policy;
    }
    get state() {
        return this._state;
    }
    /** Connected AND registered: the only state in which hub calls succeed. */
    get isReady() {
        return this._state === "connected" && this.registered;
    }
    get isConnected() {
        return this._state === "connected";
    }
    get registeredSnapshot() {
        return this.snapshot;
    }
    get connectedForMs() {
        return this.isConnected && this.connectedAt > 0 ? Date.now() - this.connectedAt : 0;
    }
    get eventMetrics() {
        return { ...this.metrics };
    }
    async start() {
        if (this.stopped)
            return;
        if (!this.config.nodeId || !this.config.nodeToken) {
            this.setState("misconfigured");
            this.log.error("connection", "missing SUNSET_NODE_ID or SUNSET_NODE_TOKEN; plugin stays offline");
            return;
        }
        const connection = new HubConnectionBuilder()
            .withUrl(this.config.hubUrl, {
            accessTokenFactory: () => this.config.nodeToken,
            transport: HttpTransportType.WebSockets,
            skipNegotiation: true,
        })
            .configureLogging(LogLevel.None)
            .withAutomaticReconnect(this.policy.schedule)
            .build();
        this.connection = connection;
        connection.onreconnecting((error) => {
            this.setState("reconnecting");
            this.log.warn("connection", `reconnecting: ${error?.message ?? "unknown"}`);
        });
        connection.onreconnected(async (connectionId) => {
            this.setState("connected");
            this.log.info("connection", `reconnected (${connectionId}); re-registering`);
            await this.register();
        });
        connection.onclose((error) => {
            this.registered = false;
            this.snapshot = undefined;
            this.setState("disconnected");
            this.log.warn("connection", `closed: ${error?.message ?? "clean"}`);
        });
        connection.on("taskDispatched", (payload) => this.safe("onTaskDispatched", () => this.callbacks.onTaskDispatched(payload)));
        connection.on("taskEventReceived", (event) => this.safe("onTaskEventReceived", () => this.callbacks.onTaskEventReceived(event)));
        connection.on("a2aMessageReceived", (message) => this.safe("onA2AMessage", () => this.callbacks.onA2AMessage(message)));
        this.setState("connecting");
        try {
            await connection.start();
            if (this.stopped)
                return;
            this.connectedAt = Date.now();
            this.retryAttempt = 0;
            this.setState("connected");
            this.log.info("connection", "connected");
            await this.register();
            this.startHeartbeat();
        }
        catch (error) {
            // Automatic reconnect only covers drops after an established connection;
            // a failed initial connect needs a manual retry loop.
            this.log.warn("connection", `initial connect failed: ${errorMessage(error)}; retrying`);
            this.scheduleRetry();
        }
    }
    scheduleRetry() {
        if (this.stopped || this.retryTimer)
            return;
        const delay = this.policy.nextDelay(this.retryAttempt++);
        this.retryTimer = setTimeout(() => {
            this.retryTimer = undefined;
            this.setState("reconnecting");
            void this.start();
        }, delay);
    }
    async register() {
        const connection = this.connection;
        if (!connection || connection.state !== HubConnectionState.Connected) {
            this.registered = false;
            return;
        }
        try {
            const snapshot = await connection.invoke("registerNode", {
                nodeId: this.config.nodeId,
                link: { protocol: "dsh", version: this.config.dshVersion },
            });
            this.snapshot = snapshot;
            this.registered = true;
            // Never log snapshot.key (the node secret).
            this.log.info("connection", `registerNode ok: nodeId=${snapshot.nodeId} displayName=${snapshot.link?.displayName ?? ""} connectionId=${snapshot.connectionId}`);
            this.callbacks.onRegistered();
        }
        catch (error) {
            this.registered = false;
            this.log.error("connection", `registerNode failed: ${errorMessage(error)}`);
        }
    }
    startHeartbeat() {
        this.clearHeartbeat();
        this.heartbeatTimer = setInterval(() => void this.heartbeat(), this.config.heartbeatIntervalMs);
    }
    async heartbeat() {
        if (!this.isReady)
            return;
        try {
            this.snapshot = await this.connection.invoke("heartbeat");
        }
        catch (error) {
            this.log.warn("connection", `heartbeat failed: ${errorMessage(error)}`);
        }
    }
    /** Report one task event; returns false when the hub is not ready (caller buffers). */
    async reportTaskEvent(event) {
        if (!this.isReady) {
            this.metrics.reportsFailed++;
            return false;
        }
        try {
            await this.connection.invoke("reportTaskEvent", event);
            this.metrics.reportsSent++;
            return true;
        }
        catch (error) {
            this.metrics.reportsFailed++;
            this.log.warn("events", `reportTaskEvent(${event.taskId}, ${event.kind}) failed: ${errorMessage(error)}`, event.taskId);
            return false;
        }
    }
    async sendA2AMessage(message) {
        if (!this.isReady)
            return undefined;
        try {
            return await this.connection.invoke("sendA2AMessage", message);
        }
        catch (error) {
            this.log.warn("connection", `sendA2AMessage failed: ${errorMessage(error)}`);
            return undefined;
        }
    }
    async stop() {
        this.stopped = true;
        this.clearHeartbeat();
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = undefined;
        }
        const connection = this.connection;
        this.connection = undefined;
        this.registered = false;
        if (connection) {
            try {
                await connection.stop();
            }
            catch {
                /* teardown: ignore */
            }
        }
        this.setState("disconnected");
    }
    setState(state) {
        if (this._state === state)
            return;
        this._state = state;
        this.safe("onStateChange", () => this.callbacks.onStateChange(state));
    }
    clearHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
    }
    safe(label, fn) {
        try {
            fn();
        }
        catch (error) {
            this.log.error("connection", `${label} threw: ${errorMessage(error)}`);
        }
    }
}
