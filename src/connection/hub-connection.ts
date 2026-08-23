/**
 * SignalR connection manager for the ClusterLinkHub: connect (WebSockets +
 * skipNegotiation), register the node, heartbeat, report task events, send
 * A2A messages, and re-register on automatic reconnect. Every async path is
 * error-isolated; the node key never touches logs.
 */
import { HubConnection, HubConnectionBuilder, HubConnectionState, HttpTransportType, LogLevel } from "@microsoft/signalr";
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

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class HubConnectionManager {
  private connection: HubConnection | undefined;
  private _state: ConnectionState = "disconnected";
  private registered = false;
  private connectedAt = 0;
  private stopped = false;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private retryAttempt = 0;
  private snapshot: ClusterNodeSnapshot | undefined;
  private readonly metrics: HubEventMetrics = { reportsSent: 0, reportsFailed: 0 };

  constructor(
    private readonly config: PluginConfig,
    private readonly callbacks: HubCallbacks,
    private readonly log: Logger,
    private readonly policy: ReconnectPolicy = new ReconnectPolicy(),
  ) {}

  get state(): ConnectionState {
    return this._state;
  }

  /** Connected AND registered: the only state in which hub calls succeed. */
  get isReady(): boolean {
    return this._state === "connected" && this.registered;
  }

  get isConnected(): boolean {
    return this._state === "connected";
  }

  get registeredSnapshot(): ClusterNodeSnapshot | undefined {
    return this.snapshot;
  }

  get connectedForMs(): number {
    return this.isConnected && this.connectedAt > 0 ? Date.now() - this.connectedAt : 0;
  }

  get eventMetrics(): HubEventMetrics {
    return { ...this.metrics };
  }

  async start(): Promise<void> {
    if (this.stopped) return;
    if (this.starting) return this.starting;
    this.starting = this.runStart().finally(() => {
      this.starting = undefined;
    });
    await this.starting;
  }

  /** Manual-connect entrypoint: idempotent, safe while auto-retry is pending. */
  requestConnect(): ConnectionState {
    if (this.stopped || this.isConnected || this.starting) return this._state;
    void this.start().catch(() => {
      /* runStart logs internally */
    });
    return this._state;
  }

  private starting: Promise<void> | undefined;

  private async runStart(): Promise<void> {
    // A manual connect cancels any pending backoff retry and skips when a
    // connection is already being established or established.
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    if (this.isConnected) return;
    if (this.connection && this.connection.state !== HubConnectionState.Disconnected) return;
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
    connection.onreconnected(async () => {
      this.setState("connected");
      this.log.info("connection", "reconnected; re-registering");
      await this.register();
    });
    connection.onclose((error) => {
      this.registered = false;
      this.snapshot = undefined;
      this.setState("disconnected");
      this.log.warn("connection", `closed: ${error?.message ?? "clean"}`);
    });
    connection.on("taskDispatched", (payload: ClusterTaskDispatch) => this.safe("onTaskDispatched", () => this.callbacks.onTaskDispatched(payload)));
    connection.on("taskEventReceived", (event: ClusterTaskEvent) => this.safe("onTaskEventReceived", () => this.callbacks.onTaskEventReceived(event)));
    connection.on("a2aMessageReceived", (message: ClusterA2AMessageEnvelope) => this.safe("onA2AMessage", () => this.callbacks.onA2AMessage(message)));

    this.setState("connecting");
    try {
      await connection.start();
      if (this.stopped) return;
      this.connectedAt = Date.now();
      this.retryAttempt = 0;
      this.setState("connected");
      this.log.info("connection", "connected");
      await this.register();
      this.startHeartbeat();
    } catch (error) {
      // Automatic reconnect only covers drops after an established connection;
      // a failed initial connect needs a manual retry loop.
      this.log.warn("connection", `initial connect failed: ${errorMessage(error)}; retrying`);
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    const delay = this.policy.nextDelay(this.retryAttempt++);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.setState("reconnecting");
      void this.start();
    }, delay);
  }

  private async register(): Promise<void> {
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
    } catch (error) {
      this.registered = false;
      this.log.error("connection", `registerNode failed: ${errorMessage(error)}`);
    }
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), this.config.heartbeatIntervalMs);
  }

  private async heartbeat(): Promise<void> {
    if (!this.isReady) return;
    try {
      this.snapshot = await this.connection!.invoke("heartbeat");
    } catch (error) {
      this.log.warn("connection", `heartbeat failed: ${errorMessage(error)}`);
    }
  }

  /** Report one task event; returns false when the hub is not ready (caller buffers). */
  async reportTaskEvent(event: ClusterTaskEvent): Promise<boolean> {
    if (!this.isReady) {
      this.metrics.reportsFailed++;
      return false;
    }
    try {
      await this.connection!.invoke("reportTaskEvent", event);
      this.metrics.reportsSent++;
      return true;
    } catch (error) {
      this.metrics.reportsFailed++;
      this.log.warn("events", `reportTaskEvent(${event.taskId}, ${event.kind}) failed: ${errorMessage(error)}`, event.taskId);
      return false;
    }
  }

  async sendA2AMessage(message: ClusterA2AMessage): Promise<ClusterA2AMessageEnvelope | undefined> {
    if (!this.isReady) return undefined;
    try {
      return await this.connection!.invoke("sendA2AMessage", message);
    } catch (error) {
      this.log.warn("connection", `sendA2AMessage failed: ${errorMessage(error)}`);
      return undefined;
    }
  }

  async stop(): Promise<void> {
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
      } catch {
        /* teardown: ignore */
      }
    }
    this.setState("disconnected");
  }

  private setState(state: ConnectionState): void {
    if (this._state === state) return;
    this._state = state;
    this.safe("onStateChange", () => this.callbacks.onStateChange(state));
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private safe(label: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.log.error("connection", `${label} threw: ${errorMessage(error)}`);
    }
  }
}
