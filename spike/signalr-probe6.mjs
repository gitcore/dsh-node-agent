/**
 * Probe round 6: register against the REAL ClusterLinkHub contract with the
 * real node key. camelCase method names (case-sensitive), nodeId as a
 * positive-integer string, link.protocol = 'dsh'.
 *
 * Usage: node spike/signalr-probe6.mjs [nodeId] [token] [seconds]
 */
import { HubConnectionBuilder, HttpTransportType, LogLevel } from "@microsoft/signalr";

const HUB_URL = process.argv[2] ?? "http://192.168.31.188:5080/cluster-link/hub";
const NODE_ID = process.argv[3] ?? "1";
const TOKEN = process.argv[4] ?? "738af663c42746ca82ff7e6b26d3c62e";
const SECONDS = Number(process.argv[5] ?? 10);

const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

const connection = new HubConnectionBuilder()
  .withUrl(HUB_URL, {
    accessTokenFactory: () => TOKEN,
    transport: HttpTransportType.WebSockets,
    skipNegotiation: true,
  })
  .configureLogging(LogLevel.Warning)
  .build();

connection.onreconnecting((e) => console.log(`[${stamp()}] onreconnecting:`, e?.message));
connection.onreconnected((id) => console.log(`[${stamp()}] onreconnected:`, id));
connection.onclose((e) => console.log(`[${stamp()}] onclose:`, e?.message ?? "clean"));

connection.on("taskDispatched", (payload) => {
  console.log(`[${stamp()}] PUSH taskDispatched:`, JSON.stringify(payload));
});
connection.on("taskEventReceived", (payload) => {
  console.log(`[${stamp()}] PUSH taskEventReceived:`, JSON.stringify(payload));
});
connection.on("a2aMessageReceived", (payload) => {
  console.log(`[${stamp()}] PUSH a2aMessageReceived:`, JSON.stringify(payload));
});

async function main() {
  console.log(`[${stamp()}] connecting (nodeId=${NODE_ID}, token=${TOKEN.slice(0, 6)}...)`);
  await connection.start();
  console.log(`[${stamp()}] CONNECTED`);

  const reg = { nodeId: NODE_ID, link: { protocol: "dsh", version: "0.1.0-rc.7" } };
  try {
    const snap = await connection.invoke("registerNode", reg);
    console.log(`[${stamp()}] registerNode OK ->`, JSON.stringify(snap).slice(0, 400));
  } catch (error) {
    console.log(`[${stamp()}] registerNode FAILED:`, error?.message ?? String(error));
  }

  try {
    const snap = await connection.invoke("heartbeat");
    console.log(`[${stamp()}] heartbeat OK ->`, JSON.stringify(snap).slice(0, 200));
  } catch (error) {
    console.log(`[${stamp()}] heartbeat FAILED:`, error?.message ?? String(error));
  }

  const ev = { taskId: "probe-task-1", kind: "started", message: "spike probe started", data: { spike: true }, timestampUtc: new Date().toISOString() };
  try {
    await connection.invoke("reportTaskEvent", ev);
    console.log(`[${stamp()}] reportTaskEvent(started) OK`);
  } catch (error) {
    console.log(`[${stamp()}] reportTaskEvent FAILED:`, error?.message ?? String(error));
  }

  await new Promise((r) => setTimeout(r, 1500));

  const done = { taskId: "probe-task-1", kind: "completed", message: "spike probe done", data: { result: "ok" }, timestampUtc: new Date().toISOString() };
  try {
    await connection.invoke("reportTaskEvent", done);
    console.log(`[${stamp()}] reportTaskEvent(completed) OK`);
  } catch (error) {
    console.log(`[${stamp()}] reportTaskEvent(completed) FAILED:`, error?.message ?? String(error));
  }

  console.log(`[${stamp()}] listening ${SECONDS}s for pushes ...`);
  await new Promise((r) => setTimeout(r, SECONDS * 1000));

  await connection.stop();
  console.log(`[${stamp()}] stopped`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
