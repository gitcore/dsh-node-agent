/**
 * Raw SignalR JSON-protocol probe: manual WebSocket + handshake + invocation,
 * so the server's REAL error text (masked by the official client) is visible,
 * and the auth path (access_token query param vs Authorization header) is
 * fully controlled.
 *
 * Usage: node spike/signalr-raw.mjs [nodeId] [token] [mode]
 *   mode: query (access_token in URL) | header (Authorization Bearer via SSE-ish? no - header test uses fetch negotiate)
 */
const HUB_URL = "192.168.31.188:5080/cluster-link/hub";
const NODE_ID = process.argv[2] ?? "1";
const TOKEN = process.argv[3] ?? "738af663c42746ca82ff7e6b26d3c62e";
const MODE = process.argv[4] ?? "query";

const RS = "\x1e"; // SignalR record separator

function frame(obj) {
  return JSON.stringify(obj) + RS;
}

async function rawWs(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = (e) => reject(new Error(`ws error: ${e.message ?? "unknown"}`));
  });
  const pending = new Map();
  let id = 0;
  ws.onmessage = (ev) => {
    for (const text of String(ev.data).split(RS)) {
      if (!text.trim()) continue;
      const msg = JSON.parse(text);
      if (msg.type === 6) {
        console.log(`  handshake: ${JSON.stringify(msg)}`);
        return;
      }
      if (msg.type === 1 && msg.invocationId && pending.has(msg.invocationId)) {
        const { resolve, reject } = pending.get(msg.invocationId);
        pending.delete(msg.invocationId);
        if (msg.error) reject(new Error(`server error: ${msg.error}${msg.errorData ? " | data: " + JSON.stringify(msg.errorData) : ""}`));
        else resolve(msg.result);
      }
    }
  };
  const invoke = (target, args, timeoutMs = 5000) =>
    new Promise((resolve, reject) => {
      const invocationId = String(++id);
      pending.set(invocationId, { resolve, reject });
      ws.send(frame({ type: 1, target, arguments: args, invocationId }));
      setTimeout(() => {
        if (pending.delete(invocationId)) reject(new Error(`timeout invoking ${target}`));
      }, timeoutMs);
    });
  return { ws, invoke };
}

async function main() {
  const wsUrl = MODE === "query"
    ? `ws://${HUB_URL}?access_token=${TOKEN}`
    : `ws://${HUB_URL}`;
  console.log(`[raw] connecting ${wsUrl} (mode=${MODE})`);
  const { ws, invoke } = await rawWs(wsUrl);
  console.log("[raw] sending handshake");
  ws.send(frame({ protocol: "json", version: 1 }));

  // Give the handshake a beat, then register.
  await new Promise((r) => setTimeout(r, 300));
  console.log(`[raw] invoking registerNode nodeId=${NODE_ID} protocol=dsh`);
  try {
    const result = await invoke("registerNode", [{ nodeId: NODE_ID, link: { protocol: "dsh", version: "0.1.0-rc.7" } }]);
    console.log("[raw] registerNode OK ->", JSON.stringify(result));
  } catch (e) {
    console.log("[raw] registerNode FAILED ->", e.message);
  }
  ws.close();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
