/**
 * Deterministic fixtures for the frozen A2A context/session mapping
 * (dsh-a2a-context-session-mapping.md step 7). Runs against the compiled lib/
 * with mocked cordis/dsh boundaries — no real DSH runtime needed.
 *
 * Run: npm test   (node --test tests/)
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ContextRegistry } from "../lib/task/context-registry.js";
import { EventRelay } from "../lib/events/event-relay.js";
import { TaskIntake } from "../lib/task/task-intake.js";
import { TaskRegistry } from "../lib/task/task-registry.js";
import { EventBuffer } from "../lib/events/event-buffer.js";

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };

function makeHandle(sessionId, opts = {}) {
  const texts = [...(opts.texts ?? [])];
  const reasons = [...(opts.reasons ?? ["completed"])];
  let busy = false;
  let release = null;
  const handle = {
    sessionId,
    prompts: [],
    agent: {
      session: { id: sessionId, seq: 0, events: [] },
      cancel() {},
      followup(msg) {
        handle.prompts.push(msg);
        const s = handle.agent.session;
        s.seq += 1;
        s.events.push({ seq: s.seq, type: "turn/start", time: Date.now(), data: {} });
        s.seq += 1;
        const text = texts.length > 0 ? texts.shift() : `reply-${handle.prompts.length}`;
        s.events.push({ seq: s.seq, type: "assistant/message", time: Date.now(), data: { message: { content: [{ type: "text", text }] } } });
        s.seq += 1;
        const reason = reasons.length > 1 ? reasons.shift() : reasons[0];
        s.events.push({ seq: s.seq, type: "turn/end", time: Date.now(), data: { reason: { kind: reason } } });
        busy = true;
      },
      async whenIdle() {
        if (!busy) return;
        await new Promise((resolve) => {
          release = resolve;
        });
      },
    },
    dispose: async () => {},
  };
  handle.settle = () => {
    const r = release;
    release = null;
    r?.();
  };
  // A real agent finishes its turn autonomously; emulate by releasing the
  // idle gate right after followup (next macrotask so callers can observe
  // the working state in between).
  const originalFollowup = handle.agent.followup.bind(handle.agent);
  handle.agent.followup = (msg) => {
    originalFollowup(msg);
    setTimeout(() => {
      busy = false;
      handle.settle();
    }, 0);
  };
  return handle;
}

function makeHarness({ registryMock, reasonPlan } = {}) {
  const listeners = {};
  const createdSessions = [];
  const taskEvents = [];
  const handles = {};
  const plan = [...(reasonPlan ?? [])];
  const ctx = {
    on(event, fn) {
      (listeners[event] ??= []).push(fn);
    },
    get(key) {
      if (key === "workspaceRegistry") return registryMock;
      return undefined;
    },
    agents: {
      async create(options) {
        const id = options.sessionId;
        createdSessions.push(id);
        const reasons = plan.length > 0 ? plan.shift() : ["completed"];
        if (!handles[id]) handles[id] = makeHandle(id, { reasons });
        return handles[id];
      },
    },
    sessions: { flush: async () => {} },
  };
  const hub = {
    reportTaskEvent: async (event) => {
      taskEvents.push(event);
      return true;
    },
  };
  const config = { maxConcurrency: 4, workspaceRoots: [], workspace: "/tmp/default-ws" };
  const registry = new TaskRegistry();
  const contexts = new ContextRegistry(quietLog);
  const buffer = new EventBuffer(1000);
  const relay = new EventRelay(ctx, contexts, registry, buffer, quietLog);
  const counters = { processedTasks: 0, failedTasks: 0 };
  const intake = new TaskIntake(ctx, config, registry, contexts, hub, relay, quietLog, counters);
  const fire = (event, ...args) => (listeners[event] ?? []).forEach((fn) => fn(...args));
  return { ctx, hub, intake, registry, contexts, buffer, relay, createdSessions, taskEvents, counters, fire };
}

function a2aEnvelope({ text, taskId, contextId, workspace }) {
  const metadata = workspace ? { workspace } : {};
  return {
    messageId: `delivery-${Math.random().toString(16).slice(2)}`,
    fromNodeId: "9",
    toNodeId: "1",
    correlationId: null,
    timestampUtc: new Date().toISOString(),
    message: {
      role: "ROLE_USER",
      parts: [{ text }],
      messageId: `msg-${Math.random().toString(16).slice(2)}`,
      ...(taskId ? { taskId } : {}),
      ...(contextId ? { contextId } : {}),
      metadata,
    },
  };
}

async function waitFor(condition, label, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(condition(), `timeout waiting for ${label}`);
}

export { makeHarness };

test("first message creates server-owned context+taskId; dshSessionId is opaque (never derived)", async () => {
  const h = makeHarness();
  h.intake.onA2AMessage(a2aEnvelope({ text: "hello" }));
  await waitFor(() => h.taskEvents.some((e) => e.kind === "started"), "started");

  const started = h.taskEvents.find((e) => e.kind === "started");
  const contextId = started.contextId;
  const taskId = started.taskId;
  assert.ok(contextId && taskId, "both ids are generated and echoed");
  const record = h.contexts.get(contextId);
  assert.ok(record, "context record exists");
  assert.notEqual(record.dshSessionId, "", "canonical dshSessionId confirmed");
  assert.notEqual(record.dshSessionId, contextId, "dshSessionId != contextId");
  assert.equal(h.createdSessions.length, 1);
  assert.notEqual(h.createdSessions[0], contextId, "creation seed never derives from an A2A id");
  assert.notEqual(h.createdSessions[0], taskId, "creation seed never derives from an A2A id");

  // status-update carries the official wire shape
  const statusUpdate = h.taskEvents.filter((e) => e.kind === "a2a.status-update");
  assert.ok(statusUpdate.length >= 2, "working + completed updates emitted");
  assert.equal(statusUpdate[0].data.contextId, contextId);
  assert.equal(statusUpdate[0].data.taskId, taskId);

  await waitFor(() => h.counters.processedTasks === 1, "completed");
});

test("same context + no taskId starts a NEW task on the SAME dsh session", async () => {
  const h = makeHarness();
  h.intake.onA2AMessage(a2aEnvelope({ text: "first" }));
  await waitFor(() => h.counters.processedTasks === 1, "first done");
  const first = h.taskEvents.find((e) => e.kind === "started");
  const createsAfterFirst = h.createdSessions.length;

  h.intake.onA2AMessage(a2aEnvelope({ text: "second", contextId: first.contextId }));
  await waitFor(() => h.taskEvents.filter((e) => e.kind === "started").length === 2, "second started");
  const second = h.taskEvents.filter((e) => e.kind === "started")[1];
  assert.notEqual(second.taskId, first.taskId, "new server-generated taskId");
  assert.equal(second.contextId, first.contextId, "same conversation context");
  await waitFor(() => h.counters.processedTasks === 2, "second done");
  assert.equal(h.createdSessions.length, createsAfterFirst, "no new dsh session for the same context");
  assert.equal(h.contexts.get(first.contextId).activeTaskId, null, "active cleared after terminal");
});

test("unknown taskId -> task-not-found rejection with zero side effects", async () => {
  const h = makeHarness();
  h.intake.onA2AMessage(a2aEnvelope({ text: "hi", taskId: "does-not-exist" }));
  await waitFor(() => h.taskEvents.length > 0, "rejection");
  const failed = h.taskEvents.find((e) => e.kind === "failed");
  assert.match(failed.message, /task not found/);
  assert.equal(h.createdSessions.length, 0, "no session created");
  assert.equal(h.registry.list().length, 0, "no task record created");
});

test("unknown contextId -> explicit rejection, no substitute generation", async () => {
  const h = makeHarness();
  h.intake.onA2AMessage(a2aEnvelope({ text: "hi", contextId: "client-invented-context" }));
  await waitFor(() => h.taskEvents.length > 0, "rejection");
  const failed = h.taskEvents.find((e) => e.kind === "failed");
  assert.match(failed.message, /unknown contextId/);
  assert.equal(failed.contextId, "client-invented-context", "rejected with the provided id, not a replacement");
  assert.equal(h.createdSessions.length, 0, "no session created");
  assert.equal([...h.contexts.list()].length, 0, "no context record created");
});

test("mismatched contextId/taskId -> rejection with zero side effects", async () => {
  const h = makeHarness();
  h.intake.onA2AMessage(a2aEnvelope({ text: "seed" }));
  await waitFor(() => h.counters.processedTasks === 1, "seed done");
  const first = h.taskEvents.find((e) => e.kind === "started");
  const otherContext = "another-context";

  h.intake.onA2AMessage(a2aEnvelope({ text: "conflict", taskId: first.taskId, contextId: otherContext }));
  await waitFor(() => h.taskEvents.some((e) => e.kind === "failed" && e.taskId === first.taskId), "mismatch rejection");
  const failed = h.taskEvents.find((e) => e.kind === "failed" && e.taskId === first.taskId);
  assert.match(failed.message, /does not match/);
  assert.equal(h.createdSessions.length, 1, "no extra session");
  assert.equal(h.counters.processedTasks, 1, "no extra completed task");
});

test("two tasks in one context serialize; both run on ONE dsh session", async () => {
  const h = makeHarness();
  h.intake.onA2AMessage(a2aEnvelope({ text: "task-one" }));
  await waitFor(() => h.counters.processedTasks === 1, "first done");
  const first = h.taskEvents.find((e) => e.kind === "started");

  h.intake.onA2AMessage(a2aEnvelope({ text: "task-two", contextId: first.contextId }));
  await waitFor(() => h.taskEvents.filter((e) => e.kind === "started").length === 2, "second started");
  await waitFor(() => h.counters.processedTasks === 2, "second done");

  // Both turns used ONE dsh session; the second task got its own taskId.
  assert.equal(h.createdSessions.length, 1);
});

test("relay drops events for node-owned sessions without an active task", async () => {
  const h = makeHarness();
  h.intake.onA2AMessage(a2aEnvelope({ text: "hello" }));
  await waitFor(() => h.counters.processedTasks === 1, "done");
  const first = h.taskEvents.find((e) => e.kind === "started");
  const record = h.contexts.get(first.contextId);
  const before = h.buffer.size;

  h.fire("session/event", { id: record.dshSessionId }, { type: "tool/call", time: Date.now(), data: { name: "x" } });
  assert.equal(h.buffer.size, before, "dropped: no active task");

  h.fire("session/event", { id: "some-other-user-session" }, { type: "tool/call", time: Date.now(), data: { name: "y" } });
  assert.equal(h.buffer.size, before, "foreign sessions ignored entirely");
});

test("input-required holds the queue until the same taskId continues it", async () => {
  const wsRoot = mkdtempSync(join(tmpdir(), "a2a-fixtures-"));
  try {
    // First conversation turn ends blocked; every later turn completes.
    const h = makeHarness({
      reasonPlan: [["blocked", "completed"]],
      registryMock: {
        get: () => undefined,
        list: () => [],
        resolveByPath: async () => undefined,
        create: async (path) => ({ path, attachSession: async () => {} }),
      },
    });

    h.intake.onA2AMessage(a2aEnvelope({ text: "need input", workspace: join(wsRoot, "ws-a") }));
    await waitFor(() => h.registry.listActive().some((t) => t.state === "input-required"), "input-required held");
    const first = h.taskEvents.find((e) => e.kind === "started");
    assert.equal(h.contexts.get(first.contextId).activeTaskId, first.taskId, "still the active task");

    // A new task in the same context queues BEHIND the input-required hold.
    h.intake.onA2AMessage(a2aEnvelope({ text: "queued behind", contextId: first.contextId }));
    await waitFor(() => h.contexts.get(first.contextId).queuedTaskIds.length === 1, "queued");
    assert.equal(h.contexts.get(first.contextId).activeTaskId, first.taskId, "queue does not bypass input-required");

    // Continue the SAME taskId: back to working, completes; queue advances.
    h.intake.onA2AMessage(a2aEnvelope({ text: "here is the input", taskId: first.taskId, contextId: first.contextId }));
    await waitFor(() => !h.registry.listActive().some((t) => t.taskId === first.taskId), "held task settled");
    await waitFor(() => h.contexts.get(first.contextId).activeTaskId !== first.taskId && h.counters.processedTasks === 2, "queue advanced and finished");
    assert.equal(h.createdSessions.length, 1, "still one dsh session");

    // Workspace conflict: same context, different workspace hint -> rejected.
    h.intake.onA2AMessage(a2aEnvelope({ text: "conflict", contextId: first.contextId, workspace: join(wsRoot, "ws-b") }));
    await waitFor(() => h.taskEvents.some((e) => e.kind === "failed" && /workspace conflict/.test(e.message ?? "")), "workspace conflict rejected");
  } finally {
    await rm(wsRoot, { recursive: true, force: true });
  }
});
