import assert from "node:assert/strict";
import test from "node:test";

import { ContextRegistry } from "../lib/task/context-registry.js";
import { EventRelay } from "../lib/events/event-relay.js";
import { TaskIntake } from "../lib/task/task-intake.js";
import { TaskRegistry } from "../lib/task/task-registry.js";
import { EventBuffer } from "../lib/events/event-buffer.js";

const log = { info() {}, warn() {}, error() {}, debug() {} };

function envelope({ id = "cluster-dispatch-1", text = "hello", contextId, taskId, workspace, sessionId } = {}) {
  return {
    id,
    toNodeId: "1",
    correlationId: null,
    payloadType: "dsh.a2a.message",
    payload: {
      ...(workspace ? { workspace } : {}),
      ...(sessionId ? { sessionId } : {}),
      a2a: {
        role: "ROLE_USER",
        messageId: `message-${id}`,
        parts: [{ text }],
        ...(contextId ? { contextId } : {}),
        ...(taskId ? { taskId } : {}),
      },
    },
    timestampUtc: new Date().toISOString(),
  };
}

function createHarness({ finishReason = "completed", replyText = "DSH reply", createError, maxConcurrency = 4 } = {}) {
  const reports = [];
  const work = { createCalls: 0, followupCalls: 0 };
  const logs = { info: [], warn: [], error: [] };
  const harnessLog = {
    info(_area, message) { logs.info.push(message); },
    warn(_area, message) { logs.warn.push(message); },
    error(_area, message) { logs.error.push(message); },
    debug() {},
  };
  const handle = {
    agent: {
      session: { id: "dsh-private-session", seq: 0, events: [] },
      followup() {
        work.followupCalls += 1;
        const session = this.session;
        session.seq += 1;
        session.events.push({ seq: session.seq, type: "turn/start", time: Date.now(), data: {} });
        session.seq += 1;
        session.events.push({ seq: session.seq, type: "assistant/message", time: Date.now(), data: { message: { content: [{ type: "text", text: replyText }] } } });
        session.seq += 1;
        session.events.push({ seq: session.seq, type: "turn/end", time: Date.now(), data: { reason: { kind: finishReason } } });
      },
      async whenIdle() {},
      cancel() {},
    },
    dispose: async () => {},
  };
  const ctx = {
    get() { return undefined; },
    on() {},
    agents: {
      async create() {
        work.createCalls += 1;
        if (createError) throw createError;
        return handle;
      },
    },
    sessions: { flush: async () => {} },
  };
  const registry = new TaskRegistry();
  const contexts = new ContextRegistry(harnessLog);
  let intake;
  const relay = new EventRelay(
    ctx,
    contexts,
    (runtimeAgentId) => intake?.contextIdForRuntimeAgent(runtimeAgentId),
    registry,
    new EventBuffer(10),
    harnessLog,
  );
  intake = new TaskIntake(
    ctx,
    { maxConcurrency, workspaceRoots: [], workspace: "/tmp" },
    registry,
    contexts,
    { reportPayload: async (payload) => { reports.push(payload); return true; } },
    relay,
    harnessLog,
    { processedTasks: 0, failedTasks: 0 },
  );
  return { intake, reports, registry, contexts, work, logs };
}

async function waitFor(predicate) {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), "timed out");
}

function assertTerminalFailure(report, messagePattern, expectedContextId) {
  assert.equal(report.payload.a2a.status.state, "TASK_STATE_FAILED");
  assert.ok(report.payload.a2a.taskId, "failure has an opaque A2A taskId");
  assert.ok(report.payload.a2a.contextId, "official A2A wire requires a non-empty contextId");
  if (expectedContextId) assert.equal(report.payload.a2a.contextId, expectedContextId);
  assert.equal("sessionId" in report.payload, false, "untrusted DSH sessionId must be omitted");
  assert.ok(report.payload.a2a.status.message.messageId, "failure has a legal A2A messageId");
  assert.match(report.payload.a2a.status.message.parts[0].text, messagePattern);
}

test("v2 DSH input produces correlated A2A status payloads and ignores reserved sessionId", async () => {
  const h = createHarness();
  h.intake.onPayloadDispatched(envelope({ id: "cluster-dispatch-42", sessionId: "prior-dsh-session" }));
  await waitFor(() => h.reports.some((item) => item.payloadType === "dsh.a2a.task-status-update" && item.payload.a2a.status?.state === "TASK_STATE_COMPLETED"));

  const completed = h.reports.find((item) => item.payload.a2a.status?.state === "TASK_STATE_COMPLETED");
  assert.equal(completed.toNodeId, "server");
  assert.equal(completed.correlationId, "cluster-dispatch-42");
  assert.notEqual(completed.id, completed.correlationId);
  assert.equal("sessionId" in completed.payload, false, "DSH does not assign meaning to the reserved sessionId");
  assert.ok(completed.payload.a2a.taskId);
  assert.notEqual(completed.payload.a2a.taskId, completed.correlationId);
  assert.ok(completed.payload.a2a.status.message.messageId);
  assert.match(completed.payload.a2a.status.message.parts[0].text, /DSH reply/);
});

test("exact duplicate outer dispatch executes once while active and replays the identical terminal return", async () => {
  const h = createHarness();
  const request = envelope({ id: "dispatch-idempotent", text: "run once" });

  h.intake.onPayloadDispatched(request);
  h.intake.onPayloadDispatched(structuredClone(request));
  h.intake.onPayloadDispatched(envelope({ id: "dispatch-idempotent", text: "conflicting while active" }));
  await waitFor(() => h.reports.some((item) =>
    item.correlationId === "dispatch-idempotent" &&
    item.payload.a2a.status?.state === "TASK_STATE_COMPLETED"));

  const original = structuredClone(h.reports.find((item) =>
    item.correlationId === "dispatch-idempotent" &&
    item.payload.a2a.status?.state === "TASK_STATE_COMPLETED"));
  assert.equal(h.work.createCalls, 1);
  assert.equal(h.work.followupCalls, 1);
  assert.equal(h.reports.filter((item) =>
    item.correlationId === "dispatch-idempotent" &&
    item.payload.a2a.status?.state === "TASK_STATE_COMPLETED").length, 1);

  const reportCount = h.reports.length;
  h.intake.onPayloadDispatched(structuredClone(request));
  await waitFor(() => h.reports.length === reportCount + 1);

  assert.deepEqual(h.reports.at(-1), original);
  assert.equal(h.work.createCalls, 1);
  assert.equal(h.work.followupCalls, 1);
  assert.ok(h.logs.info.some((message) => message.includes("duplicate active outer dispatch")));
  assert.ok(h.logs.info.some((message) => message.includes("replaying the recorded terminal return")));
  assert.ok(h.logs.error.some((message) => message.includes("correlation conflict rejected")));
});

test("same outer correlation with changed payload, context, or workspace is rejected while reserved sessionId is ignored", async () => {
  const h = createHarness();
  const request = envelope({ id: "dispatch-conflict", text: "authoritative" });
  h.intake.onPayloadDispatched(request);
  await waitFor(() => h.reports.some((item) =>
    item.correlationId === "dispatch-conflict" &&
    item.payload.a2a.status?.state === "TASK_STATE_COMPLETED"));
  const terminal = h.reports.find((item) =>
    item.correlationId === "dispatch-conflict" &&
    item.payload.a2a.status?.state === "TASK_STATE_COMPLETED");
  const reportCount = h.reports.length;

  h.intake.onPayloadDispatched(envelope({ id: "dispatch-conflict", text: "changed" }));
  h.intake.onPayloadDispatched(envelope({ id: "dispatch-conflict", text: "authoritative", contextId: terminal.payload.a2a.contextId }));
  h.intake.onPayloadDispatched(envelope({ id: "dispatch-conflict", text: "authoritative", sessionId: "different-session" }));
  h.intake.onPayloadDispatched(envelope({ id: "dispatch-conflict", text: "authoritative", workspace: "/different/workspace" }));

  await waitFor(() => h.reports.length === reportCount + 1);
  assert.deepEqual(h.reports.at(-1), terminal, "a reserved sessionId variant replays the authoritative terminal result");
  assert.equal(h.work.createCalls, 1);
  assert.equal(h.work.followupCalls, 1);
  assert.equal(
    h.logs.error.filter((message) => message.includes("correlation conflict rejected")).length,
    3,
    JSON.stringify(h.logs.error),
  );
});

test("outer dispatch ledger is bounded without evicting active work", () => {
  const registry = new TaskRegistry(20, 1000, 2);
  assert.deepEqual(registry.claimDispatch("dispatch-a", "request-a"), { kind: "accepted" });
  assert.deepEqual(registry.claimDispatch("dispatch-b", "request-b"), { kind: "accepted" });
  assert.deepEqual(registry.claimDispatch("dispatch-c", "request-c"), { kind: "capacity-exhausted" });

  registry.completeDispatch("dispatch-a", {
    id: "return-a",
    toNodeId: "server",
    correlationId: "dispatch-a",
    payloadType: "dsh.a2a.task-status-update",
    payload: { a2a: { taskId: "task-a", contextId: "context-a", status: { state: "TASK_STATE_FAILED" } } },
    timestampUtc: "2026-09-01T00:00:00.000Z",
  });
  assert.deepEqual(registry.claimDispatch("dispatch-c", "request-c"), { kind: "accepted" });
  assert.deepEqual(registry.claimDispatch("dispatch-a", "request-a"), { kind: "capacity-exhausted" });
});

test("max concurrency before context creation returns replayable terminal failure", async () => {
  const h = createHarness({ maxConcurrency: 1 });
  h.registry.begin("busy-task", "busy-context", "payload", "busy-dispatch");
  const request = envelope({ id: "dispatch-at-capacity" });

  h.intake.onPayloadDispatched(request);
  await waitFor(() => h.reports.some((item) => item.correlationId === "dispatch-at-capacity"));
  const failed = h.reports.find((item) => item.correlationId === "dispatch-at-capacity");
  assertTerminalFailure(failed, /max concurrency reached/);
  assert.equal(h.work.createCalls, 0);

  const original = structuredClone(failed);
  const reportCount = h.reports.length;
  h.intake.onPayloadDispatched(structuredClone(request));
  await waitFor(() => h.reports.length === reportCount + 1);
  assert.deepEqual(h.reports.at(-1), original);
});

test("transient runtime-agent creation failure rolls back provisional context and returns replayable terminal failure", async () => {
  const h = createHarness({ createError: new Error("DSH unavailable") });
  const request = envelope({ id: "dispatch-create-failed", sessionId: "ignored-reserved-value" });

  h.intake.onPayloadDispatched(request);
  await waitFor(() => h.reports.some((item) => item.correlationId === "dispatch-create-failed"));
  const failed = h.reports.find((item) => item.correlationId === "dispatch-create-failed");
  assertTerminalFailure(failed, /runtime handle create failed: DSH unavailable/);
  assert.equal(h.contexts.list().length, 0, "the provisional context is rolled back");
  assert.equal(h.work.createCalls, 1);
  assert.equal(h.work.followupCalls, 0);

  const original = structuredClone(failed);
  const reportCount = h.reports.length;
  h.intake.onPayloadDispatched(structuredClone(request));
  await waitFor(() => h.reports.length === reportCount + 1);
  assert.deepEqual(h.reports.at(-1), original);
  assert.equal(h.work.createCalls, 1);
});

test("unexpected accept exception seals the claimed dispatch as terminal failure", async () => {
  const h = createHarness();
  h.registry.activeCount = () => { throw new Error("unexpected registry failure"); };
  const request = envelope({ id: "dispatch-accept-crash" });

  h.intake.onPayloadDispatched(request);
  await waitFor(() => h.reports.some((item) => item.correlationId === "dispatch-accept-crash"));
  const failed = h.reports.find((item) => item.correlationId === "dispatch-accept-crash");
  assertTerminalFailure(failed, /payload accept failed: unexpected registry failure/);

  const original = structuredClone(failed);
  const reportCount = h.reports.length;
  h.intake.onPayloadDispatched(structuredClone(request));
  await waitFor(() => h.reports.length === reportCount + 1);
  assert.deepEqual(h.reports.at(-1), original);
});

test("v2 continuation retains the A2A context and uses a new A2A task ID", async () => {
  const h = createHarness();
  h.intake.onPayloadDispatched(envelope({ id: "dispatch-one" }));
  await waitFor(() => h.reports.some((item) => item.correlationId === "dispatch-one" && item.payload.a2a.status?.state === "TASK_STATE_COMPLETED"));
  const first = h.reports.find((item) => item.correlationId === "dispatch-one" && item.payload.a2a.status?.state === "TASK_STATE_COMPLETED");

  h.intake.onPayloadDispatched(envelope({ id: "dispatch-two", contextId: first.payload.a2a.contextId, sessionId: "ignored-reserved-value" }));
  await waitFor(() => h.reports.some((item) => item.correlationId === "dispatch-two" && item.payload.a2a.status?.state === "TASK_STATE_COMPLETED"));
  const second = h.reports.find((item) => item.correlationId === "dispatch-two" && item.payload.a2a.status?.state === "TASK_STATE_COMPLETED");

  assert.equal(second.payload.a2a.contextId, first.payload.a2a.contextId);
  assert.notEqual(second.payload.a2a.taskId, first.payload.a2a.taskId);
  assert.equal("sessionId" in second.payload, false);
});

test("non-DSH payload type is rejected before task creation", () => {
  const h = createHarness();
  h.intake.onPayloadDispatched({ ...envelope(), payloadType: "other.message" });
  assert.equal(h.registry.list().length, 0);
  assert.equal(h.reports.length, 0);
});

test("context registry restore is idempotent by A2A context only", () => {
  const h = createHarness();
  const first = h.contexts.restore("context-a");
  assert.equal(h.contexts.restore("context-a"), first);
  h.contexts.restore("context-b");
  assert.equal(h.contexts.get("context-b")?.contextId, "context-b");
});

test("node restart restores persisted A2A context and creates a transient runtime agent", async () => {
  const h = createHarness();
  h.intake.onPayloadDispatched(envelope({
    id: "dispatch-after-restart",
    contextId: "persisted-context",
    sessionId: "reserved-value-is-ignored",
  }));

  await waitFor(() => h.reports.some((item) =>
    item.correlationId === "dispatch-after-restart" &&
    item.payload.a2a.status?.state === "TASK_STATE_COMPLETED"));
  const completed = h.reports.find((item) =>
    item.correlationId === "dispatch-after-restart" &&
    item.payload.a2a.status?.state === "TASK_STATE_COMPLETED");

  assert.equal(completed.payload.a2a.contextId, "persisted-context");
  assert.equal("sessionId" in completed.payload, false);
  assert.equal(h.contexts.get("persisted-context")?.contextId, "persisted-context");
  assert.equal(h.work.createCalls, 1, "the node creates a new transient runtime agent");
});

test("node accepts a persisted context without a runtime session", async () => {
  const h = createHarness();
  const request = envelope({
    id: "dispatch-restored-context",
    contextId: "missing-context",
  });
  h.intake.onPayloadDispatched(request);

  await waitFor(() => h.reports.some((item) => item.correlationId === "dispatch-restored-context" && item.payload.a2a.status?.state === "TASK_STATE_COMPLETED"));
  const completed = h.reports.find((item) => item.correlationId === "dispatch-restored-context");
  assert.equal(completed.payload.a2a.contextId, "missing-context");
  assert.equal(h.contexts.get("missing-context")?.contextId, "missing-context");
  assert.equal(h.registry.list().length, 0);
});

test("payload input-required is surfaced as terminal failure and releases the context queue", async () => {
  const h = createHarness({ finishReason: "blocked" });
  h.intake.onPayloadDispatched(envelope({ id: "dispatch-blocked" }));
  await waitFor(() => h.reports.some((item) =>
    item.correlationId === "dispatch-blocked" &&
    item.payload.a2a.status?.state === "TASK_STATE_FAILED"));

  const failed = h.reports.find((item) =>
    item.correlationId === "dispatch-blocked" &&
    item.payload.a2a.status?.state === "TASK_STATE_FAILED");
  assert.match(failed.payload.a2a.status.message.parts[0].text, /do not support resuming a held task/);
  assert.equal(h.registry.list().length, 0);
  const context = h.contexts.get(failed.payload.a2a.contextId);
  assert.equal(context.activeTaskId, null);
  assert.deepEqual(context.queuedTaskIds, []);

  h.intake.onPayloadDispatched(envelope({
    id: "dispatch-after-blocked",
    contextId: failed.payload.a2a.contextId,
    sessionId: "ignored-reserved-value",
  }));
  await waitFor(() => h.reports.some((item) =>
    item.correlationId === "dispatch-after-blocked" &&
    item.payload.a2a.status?.state === "TASK_STATE_FAILED"));
  assert.equal(h.work.followupCalls, 2, "the released context accepts the next ChatPush message");
});

test("reserved sessionId does not alter an existing A2A context", async () => {
  const h = createHarness();
  h.intake.onPayloadDispatched(envelope({ id: "dispatch-trusted-seed" }));
  await waitFor(() => h.reports.some((item) =>
    item.correlationId === "dispatch-trusted-seed" &&
    item.payload.a2a.status?.state === "TASK_STATE_COMPLETED"));
  const seed = h.reports.find((item) =>
    item.correlationId === "dispatch-trusted-seed" &&
    item.payload.a2a.status?.state === "TASK_STATE_COMPLETED");

  h.intake.onPayloadDispatched(envelope({
    id: "dispatch-trusted-followup",
    contextId: seed.payload.a2a.contextId,
    sessionId: "wrong-session",
  }));
  await waitFor(() => h.reports.some((item) => item.correlationId === "dispatch-trusted-followup" && item.payload.a2a.status?.state === "TASK_STATE_COMPLETED"));
  const completed = h.reports.find((item) => item.correlationId === "dispatch-trusted-followup");
  assert.equal(completed.payload.a2a.contextId, seed.payload.a2a.contextId);
  assert.equal("sessionId" in completed.payload, false);
  assert.equal(h.work.createCalls, 1);
  assert.equal(h.work.followupCalls, 2);
});
