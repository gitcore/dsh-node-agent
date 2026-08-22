var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
let ClusterService = (() => {
    let _classSuper = TypertRemoteService;
    let _instanceExtraInitializers = [];
    let _getStatus_decorators;
    let _getActiveTasks_decorators;
    let _getRecentTasks_decorators;
    let _getLogs_decorators;
    let _getMetrics_decorators;
    return class ClusterService extends _classSuper {
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _getStatus_decorators = [Remote];
            _getActiveTasks_decorators = [Remote];
            _getRecentTasks_decorators = [Remote];
            _getLogs_decorators = [Remote];
            _getMetrics_decorators = [Remote];
            __esDecorate(this, null, _getStatus_decorators, { kind: "method", name: "getStatus", static: false, private: false, access: { has: obj => "getStatus" in obj, get: obj => obj.getStatus }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getActiveTasks_decorators, { kind: "method", name: "getActiveTasks", static: false, private: false, access: { has: obj => "getActiveTasks" in obj, get: obj => obj.getActiveTasks }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getRecentTasks_decorators, { kind: "method", name: "getRecentTasks", static: false, private: false, access: { has: obj => "getRecentTasks" in obj, get: obj => obj.getRecentTasks }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getLogs_decorators, { kind: "method", name: "getLogs", static: false, private: false, access: { has: obj => "getLogs" in obj, get: obj => obj.getLogs }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getMetrics_decorators, { kind: "method", name: "getMetrics", static: false, private: false, access: { has: obj => "getMetrics" in obj, get: obj => obj.getMetrics }, metadata: _metadata }, null, _instanceExtraInitializers);
            if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        deps = __runInitializers(this, _instanceExtraInitializers);
        constructor(ctx, deps) {
            super(ctx, "clusterService");
            this.deps = deps;
        }
        getStatus() {
            const { hub, registry, config, counters, eventBuffer } = this.deps;
            const snapshot = hub.registeredSnapshot;
            const active = registry.activeCount();
            return {
                state: hub.state,
                connected: hub.isConnected,
                registered: hub.isReady,
                hubUrl: config.hubUrl,
                nodeId: config.nodeId,
                dshVersion: config.dshVersion,
                maxConcurrency: config.maxConcurrency,
                activeTasks: active,
                totalTasks: counters.processedTasks + counters.failedTasks + active,
                failedTasks: counters.failedTasks,
                connectedForMs: hub.connectedForMs,
                connectionId: snapshot?.connectionId ?? null,
                lastHeartbeatUtc: snapshot?.lastHeartbeatUtc ?? null,
                bufferSize: eventBuffer.size,
            };
        }
        getActiveTasks() {
            const { registry } = this.deps;
            const now = Date.now();
            return registry.listActive().map((record) => ({
                taskId: record.taskId,
                status: record.status,
                source: record.source,
                startedAt: record.startedAt,
                elapsedMs: now - record.startedAt,
                lastEventType: record.lastEventType,
            }));
        }
        getRecentTasks() {
            return this.deps.registry.recent().map((entry) => ({
                taskId: entry.taskId,
                source: entry.source,
                finishReason: entry.finishReason,
                startedAt: entry.startedAt,
                finishedAt: entry.finishedAt,
                durationMs: entry.durationMs,
                lastEventType: entry.lastEventType,
                ...(entry.finalResponse ? { finalResponse: entry.finalResponse } : {}),
            }));
        }
        getLogs(level) {
            return this.deps.logBuffer.list(level);
        }
        getMetrics() {
            const { hub, counters, eventBuffer } = this.deps;
            return {
                connectedForMs: hub.connectedForMs,
                processedTasks: counters.processedTasks,
                failedTasks: counters.failedTasks,
                reportsSent: hub.eventMetrics.reportsSent,
                reportsFailed: hub.eventMetrics.reportsFailed,
                bufferSize: eventBuffer.size,
                droppedEvents: eventBuffer.droppedCount,
            };
        }
    };
})();
export { ClusterService };
