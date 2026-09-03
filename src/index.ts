/**
 * dsh-node-agent — Host half. Mounts the SignalR node connection to the
 * ClusterLinkHub, task intake/execution via ctx.agents.create, event relay,
 * and the clusterService remote face for the client UI.
 *
 * Error-isolation stance: apply() only wires effects; every async path is
 * caught and logged — the plugin must never throw into the Host.
 */
import type { Context } from "@deepseek-ai/cordis";
import { loadConfig, type ClusterLinkPayloadEnvelope } from "./protocol.js";
import { LogBuffer, createLogger } from "./services/log-buffer.js";
import { errorMessage, HubConnectionManager, type HubCallbacks } from "./connection/hub-connection.js";
import { ReconnectPolicy } from "./connection/reconnect-policy.js";
import { ContextRegistry } from "./task/context-registry.js";
import { TaskRegistry } from "./task/task-registry.js";
import { TaskIntake, type IntakeCounters } from "./task/task-intake.js";
import { EventRelay } from "./events/event-relay.js";
import { EventBuffer } from "./events/event-buffer.js";
import { ClusterService } from "./services/cluster-service.js";

export const name = "dsh-node-agent";

/** Required host services; agentDefaultModel and workspaceRegistry are optional (resolved via ctx.get). */
export const inject = ["agents", "sessions"];

export function apply(ctx: Context): void {
  const config = loadConfig();
  const logBuffer = new LogBuffer(config.logBufferSize);
  const log = createLogger(ctx, logBuffer, config.nodeId);
  const registry = new TaskRegistry();
  const contexts = new ContextRegistry(log);
  const counters: IntakeCounters = { processedTasks: 0, failedTasks: 0 };
  const eventBuffer = new EventBuffer(config.eventBufferSize);
  eventBuffer.setContextResolver((taskId) => registry.get(taskId)?.contextId ?? registry.knownContextOf(taskId));

  let intake: TaskIntake;

  const callbacks: HubCallbacks = {
    onStateChange: (state) => {
      log.info("connection", `state -> ${state}`);
      if (state === "connected") void eventBuffer.drain(hub, log);
    },
    onRegistered: () => {
      log.info("connection", "registered; draining buffered events");
      void eventBuffer.drain(hub, log);
    },
    onPayloadDispatched: (payload: ClusterLinkPayloadEnvelope) => intake.onPayloadDispatched(payload),
  };

  const hub = new HubConnectionManager(config, callbacks, log, new ReconnectPolicy());
  const relay = new EventRelay(ctx, contexts, (runtimeAgentId) => intake?.contextIdForRuntimeAgent(runtimeAgentId), registry, eventBuffer, log);
  intake = new TaskIntake(ctx, config, registry, contexts, hub, relay, log, counters);

  // Batching window: drain the relay queue on a fixed cadence; also the
  // offline-buffer retry loop when the hub is down.
  const flushTimer = setInterval(() => void eventBuffer.drain(hub, log), config.eventBatchMs);
  ctx.effect(() => () => clearInterval(flushTimer), "node-agent: flush timer");

  // Remote face for the client UI.
  new ClusterService(ctx, { hub, registry, logBuffer, eventBuffer, config, counters });

  // Connect (fire-and-forget; start() is internally error-isolated).
  void hub.start().catch((error) => log.error("connection", `start threw: ${errorMessage(error)}`));

  // Teardown: stop the connection, stop all running agents, clear state.
  ctx.effect(() => () => {
    log.info("connection", "plugin unloading: stopping connection and tasks");
    void hub.stop();
    void intake.disposeAll();
    relay.clear();
    eventBuffer.clear();
  });
}
