/**
 * SignalR connectivity probe for the sunset AgentHub spike (spike item 6).
 *
 * Connects as a cluster node with skipNegotiation + WebSockets (the planned
 * transport), registers a fake node, sends a heartbeat, and listens for
 * DispatchTask / CancelTask pushes. Prints every state transition and server
 * error so the protocol contract can be verified against the real hub.
 *
 * Usage: node spike/signalr-probe.mjs [hubUrl] [token] [seconds]
 */
import {
  HubConnectionBuilder,
  HttpTransportType,
  LogLevel,
} from "@microsoft/signalr";

const HUB_URL = process.argv[2] ?? "http://192.168.31.188:5080/cluster-link/hub";
const TOKEN = process.argv[3] ?? "dev-probe-token";
const SECONDS = Number(process.argv[4] ?? 12);

const NODE_ID = `node-probe-${process.pid}`;

const connection = new HubConnectionBuilder()
  .withUrl(HUB_URL, {
    accessTokenFactory: () => TOKEN,
    transport: HttpTransportType.WebSockets,
    skipNegotiation: true,
  })
  .configureLogging(LogLevel.Information)
  .build();

const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

connection.onreconnecting((error) => {
  console.log(`[${stamp()}] onreconnecting:`, error?.message ?? String(error));
});
connection.onreconnected((id) => {
  console.log(`[${stamp()}] onreconnected: connectionId=${id}`);
});
connection.onclose((error) => {
  console.log(`[${stamp()}] onclose:`, error?.message ?? "clean close");
});

// Hub -> node pushes per the protocol contract.
connection.on("DispatchTask", (payload) => {
  console.log(`[${stamp()}] RECV DispatchTask:`, JSON.stringify(payload));
});
connection.on("CancelTask", (payload) => {
  console.log(`[${stamp()}] RECV CancelTask:`, JSON.stringify(payload));
});
// Also echo any other inbound invocation name for contract discovery.
connection.onreceive?.(); // no-op guard

async function main() {
  try {
    console.log(`[${stamp()}] connecting to ${HUB_URL} (skipNegotiation+WebSockets, token=${TOKEN})`);
    await connection.start();
    console.log(`[${stamp()}] CONNECTED state=${connection.state} connectionId=${connection.connectionId}`);

    const register = { nodeId: NODE_ID, dshVersion: "0.1.0-rc.7", capabilities: ["web-ui"], maxConcurrency: 4 };
    try {
      const result = await connection.invoke("RegisterNode", register);
      console.log(`[${stamp()}] invoke RegisterNode ->`, JSON.stringify(result));
    } catch (error) {
      console.log(`[${stamp()}] invoke RegisterNode FAILED:`, error?.message ?? String(error));
    }

    // Send a heartbeat (fire and forget) to observe server tolerance.
    try {
      await connection.send("Heartbeat", { activeTasks: 0, ts: Date.now() });
      console.log(`[${stamp()}] send Heartbeat ok`);
    } catch (error) {
      console.log(`[${stamp()}] send Heartbeat FAILED:`, error?.message ?? String(error));
    }

    // Try an unknown method to learn the hub's error vocabulary.
    try {
      await connection.invoke("DefinitelyNotAMethod", {});
      console.log(`[${stamp()}] invoke unknown method unexpectedly succeeded`);
    } catch (error) {
      console.log(`[${stamp()}] invoke unknown method ->`, error?.message ?? String(error));
    }

    console.log(`[${stamp()}] listening for pushes for ${SECONDS}s ...`);
    await new Promise((resolve) => setTimeout(resolve, SECONDS * 1000));
  } catch (error) {
    console.log(`[${stamp()}] START FAILED:`, error?.message ?? String(error));
    console.log(error);
  } finally {
    try {
      await connection.stop();
      console.log(`[${stamp()}] stopped cleanly`);
    } catch (error) {
      console.log(`[${stamp()}] stop error:`, error?.message ?? String(error));
    }
    process.exit(0);
  }
}

main();
