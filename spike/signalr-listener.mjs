/**
 * Resident listener probe: registers node 1 and stays connected, logging every
 * hub push (taskDispatched / taskEventReceived / a2aMessageReceived) to stdout
 * AND to a log file. On taskDispatched it auto-reports started -> completed so
 * the admin side can observe the full lifecycle over the real wire.
 *
 * Usage: node spike/signalr-listener.mjs <logFile>
 */
import { HubConnectionBuilder, HttpTransportType, LogLevel } from "@microsoft/signalr";
import { appendFileSync } from "node:fs";

const HUB_URL = "http://192.168.31.188:5080/cluster-link/hub";
const NODE_ID = "1";
const TOKEN = "738af663c42746ca82ff7e6b26d3c62e";
const LOG_FILE = process.argv[2] ?? "spike/listener.log";

const line = (s) => `[${new Date().toISOString()}] ${s}`;
const log = (s) => { const l = line(s); console.log(l); try { appendFileSync(LOG_FILE, l + "\n"); } catch {} };

const connection = new HubConnectionBuilder()
  .withUrl(HUB_URL, {
    accessTokenFactory: () => TOKEN,
    transport: HttpTransportType.WebSockets,
    skipNegotiation: true,
  })
  .configureLogging(LogLevel.Warning)
  .withAutomaticReconnect([0, 1000, 5000, 15000])
  .build();

connection.onreconnecting((e) => log(`onreconnecting: ${e?.message ?? ""}`));
connection.onreconnected(async (id) => {
  log(`onreconnected (${id}), re-registering...`);
  try {
    await connection.invoke("registerNode", { nodeId: NODE_ID, link: { protocol: "dsh", version: "0.1.0-rc.7" } });
    log("re-registerNode OK after reconnect");
  } catch (e) { log(`re-registerNode FAILED: ${e?.message ?? String(e)}`); }
});
connection.onclose((e) => log(`onclose: ${e?.message ?? "clean"}`));

connection.on("taskDispatched", async (payload) => {
  log(`PUSH taskDispatched: ${JSON.stringify(payload)}`);
  const taskId = payload?.taskId ?? "unknown";
  try {
    await connection.invoke("reportTaskEvent", {
      taskId, kind: "started",
      message: "probe listener accepted the task",
      data: { receivedBy: "signalr-listener-probe" },
      timestampUtc: new Date().toISOString(),
    });
    log(`responded reportTaskEvent(started) for ${taskId}`);
    // Simulate a short execution, then complete.
    setTimeout(async () => {
      try {
        await connection.invoke("reportTaskEvent", {
          taskId, kind: "completed",
          message: "probe listener finished (echo demo)",
          data: { result: "demo result from listener probe", promptLength: payload?.prompt?.length ?? 0 },
          timestampUtc: new Date().toISOString(),
        });
        log(`responded reportTaskEvent(completed) for ${taskId}`);
      } catch (e) { log(`reportTaskEvent(completed) FAILED: ${e?.message ?? String(e)}`); }
    }, 2000);
  } catch (e) { log(`reportTaskEvent(started) FAILED: ${e?.message ?? String(e)}`); }
});

connection.on("taskEventReceived", (payload) => {
  log(`PUSH taskEventReceived: ${JSON.stringify(payload)}`);
});
connection.on("a2aMessageReceived", (payload) => {
  log(`PUSH a2aMessageReceived: ${JSON.stringify(payload)}`);
});

async function main() {
  log(`listener starting: ${HUB_URL} nodeId=${NODE_ID} log=${LOG_FILE}`);
  await connection.start();
  log("CONNECTED");
  const snap = await connection.invoke("registerNode", { nodeId: NODE_ID, link: { protocol: "dsh", version: "0.1.0-rc.7" } });
  log(`registerNode OK: nodeId=${snap.nodeId} displayName=${snap.link?.displayName} connectionId=${snap.connectionId}`);
  log("READY — admin may dispatch tasks now; Ctrl-C to stop");

  const heartbeat = async () => {
    try { await connection.invoke("heartbeat"); log("heartbeat ok"); }
    catch (e) { log(`heartbeat FAILED: ${e?.message ?? String(e)}`); }
  };
  setInterval(heartbeat, 30000);
  heartbeat();
}

main().catch((e) => { log(`FATAL: ${e?.message ?? String(e)}`); process.exit(1); });
