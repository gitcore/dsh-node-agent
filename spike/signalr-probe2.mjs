/**
 * Probe round 2: discover the hub's real method surface and RegisterNode
 * payload contract. Tries a battery of candidate method names and payload
 * variants, distinguishing "Method does not exist" (name absent) from
 * "error on the server" (name exists, body threw). Also tests connecting
 * without a token.
 */
import { HubConnectionBuilder, HttpTransportType, LogLevel } from "@microsoft/signalr";

const HUB_URL = process.argv[2] ?? "http://192.168.31.188:5080/cluster-link/hub";
const TOKEN = process.argv[3] ?? "dev-probe-token";

function build(token) {
  return new HubConnectionBuilder()
    .withUrl(HUB_URL, {
      accessTokenFactory: () => token,
      transport: HttpTransportType.WebSockets,
      skipNegotiation: true,
    })
    .configureLogging(LogLevel.None)
    .build();
}

async function tryInvoke(connection, name, ...args) {
  const t0 = Date.now();
  try {
    const result = await connection.invoke(name, ...args);
    return { name, verdict: "OK", result: JSON.stringify(result)?.slice(0, 200), ms: Date.now() - t0 };
  } catch (error) {
    const msg = error?.message ?? String(error);
    const verdict = msg.includes("Method does not exist") ? "ABSENT" : "EXISTS-BUT-ERROR";
    return { name, verdict, detail: msg, ms: Date.now() - t0 };
  }
}

const CANDIDATES = [
  "RegisterNode", "registerNode", "register", "Register", "nodeRegister",
  "RegisterAgent", "JoinCluster", "Connect", "Handshake", "Hello",
  "NodeJoin", "registerAgent", "Heartbeat", "heartbeat", "Ping", "Status",
];

const PAYLOADS = {
  full: { nodeId: "node-probe-1", dshVersion: "0.1.0-rc.7", capabilities: ["web-ui"], maxConcurrency: 4 },
  minimal: { nodeId: "node-probe-1" },
  snake: { node_id: "node-probe-1", dsh_version: "0.1.0-rc.7", max_concurrency: 4 },
};

async function main() {
  // 1) name scan with the full payload
  const conn = build(TOKEN);
  await conn.start();
  console.log("== method-name scan (payload: full) ==");
  const seen = [];
  for (const name of CANDIDATES) {
    const r = await tryInvoke(conn, name, PAYLOADS.full);
    seen.push(r);
    console.log(`  ${r.verdict.padEnd(16)} ${name.padEnd(18)} ${r.ms}ms ${r.detail?.slice(0, 90) ?? ""} ${r.result ?? ""}`);
    if (r.verdict === "OK") break;
  }
  // 2) payload variants on the confirmed name
  const liveName = seen.find((r) => r.verdict === "OK")?.name ?? "RegisterNode";
  console.log(`\n== payload variants on '${liveName}' =="`);
  for (const [label, payload] of Object.entries(PAYLOADS)) {
    const r = await tryInvoke(conn, liveName, payload);
    console.log(`  ${r.verdict.padEnd(16)} payload=${label.padEnd(8)} ${r.ms}ms ${r.detail?.slice(0, 90) ?? ""} ${r.result ?? ""}`);
  }
  // 3) invoke with zero args
  const r0 = await tryInvoke(conn, liveName);
  console.log(`\n  zero-args: ${r0.verdict} ${r0.detail?.slice(0, 90) ?? ""}`);

  await conn.stop();

  // 4) connect without a token
  console.log("\n== connect with EMPTY token ==");
  const conn2 = build("");
  try {
    await conn2.start();
    console.log("  CONNECTED without token");
    const r = await tryInvoke(conn2, "RegisterNode", PAYLOADS.full);
    console.log(`  RegisterNode: ${r.verdict} ${r.detail?.slice(0, 90) ?? ""}`);
    await conn2.stop();
  } catch (error) {
    console.log("  CONNECT FAILED without token:", error?.message ?? String(error));
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
