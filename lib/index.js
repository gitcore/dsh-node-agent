import { loadConfig } from "./protocol.js";
import { LogBuffer, createLogger } from "./services/log-buffer.js";
import { errorMessage, HubConnectionManager } from "./connection/hub-connection.js";
import { ReconnectPolicy } from "./connection/reconnect-policy.js";
import { TaskRegistry } from "./task/task-registry.js";
import { TaskIntake } from "./task/task-intake.js";
import { EventRelay } from "./events/event-relay.js";
import { EventBuffer } from "./events/event-buffer.js";
import { ClusterService } from "./services/cluster-service.js";
export const name = "dsh-node-agent";
/** Required host services; agentDefaultModel is optional (resolved via ctx.get). */
export const inject = ["agents", "sessions"];
export function apply(ctx) {
    const config = loadConfig();
    const logBuffer = new LogBuffer(config.logBufferSize);
    const log = createLogger(ctx, logBuffer, config.nodeId);
    const registry = new TaskRegistry();
    const counters = { processedTasks: 0, failedTasks: 0 };
    const eventBuffer = new EventBuffer(config.eventBufferSize);
    let intake;
    const callbacks = {
        onStateChange: (state) => {
            log.info("connection", `state -> ${state}`);
            if (state === "connected")
                void eventBuffer.drain(hub, log);
        },
        onRegistered: () => {
            log.info("connection", "registered; draining buffered events");
            void eventBuffer.drain(hub, log);
        },
        onTaskDispatched: (payload) => intake.onTaskDispatched(payload),
        onA2AMessage: (message) => intake.onA2AMessage(message),
        onTaskEventReceived: (event) => {
            // Hub-wide broadcast: only events for tasks this node owns matter.
            if (registry.has(event.taskId)) {
                log.info("events", `echo ${event.taskId} kind=${event.kind}`, event.taskId);
            }
        },
    };
    const hub = new HubConnectionManager(config, callbacks, log, new ReconnectPolicy());
    const relay = new EventRelay(ctx, registry, eventBuffer, log);
    intake = new TaskIntake(ctx, config, registry, hub, relay, log, counters);
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
        void registry.disposeAll();
        relay.clear();
        eventBuffer.clear();
    });
}
