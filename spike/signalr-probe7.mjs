import { HubConnectionBuilder, HttpTransportType, LogLevel } from "@microsoft/signalr";
const HUB_URL = "http://192.168.31.188:5080/cluster-link/hub";
const TOKEN = "738af663c42746ca82ff7e6b26d3c62e";
const conn = new HubConnectionBuilder()
  .withUrl(HUB_URL, { accessTokenFactory: () => TOKEN, transport: HttpTransportType.WebSockets, skipNegotiation: true })
  .configureLogging(LogLevel.Warning).build();
conn.on("taskDispatched", (p) => console.log("PUSH taskDispatched:", JSON.stringify(p)));
conn.on("taskEventReceived", (p) => console.log("PUSH taskEventReceived:", JSON.stringify(p)));
conn.on("a2aMessageReceived", (p) => console.log("PUSH a2aMessageReceived:", JSON.stringify(p)));
await conn.start();
console.log("registerNode...");
await conn.invoke("registerNode", { nodeId: "1", link: { protocol: "dsh", version: "0.1.0-rc.7" } });
console.log("registered. sendA2AMessage to self (nodeId=1)...");
try {
  const env = await conn.invoke("sendA2AMessage", { toNodeId: "1", type: "task.request", correlationId: "probe-a2a-1", payload: { prompt: "hello from probe" } });
  console.log("sendA2AMessage OK ->", JSON.stringify(env));
} catch (e) {
  console.log("sendA2AMessage FAILED ->", e.message);
}
await new Promise((r) => setTimeout(r, 3000));
await conn.stop();
process.exit(0);
