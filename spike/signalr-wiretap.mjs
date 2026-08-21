/**
 * Wiretap probe: run the OFFICIAL @microsoft/signalr client but patch the
 * global WebSocket to log the exact URL, outgoing frames, and incoming
 * frames — to learn what the hub's handshake actually expects.
 */
import { HubConnectionBuilder, HttpTransportType, LogLevel } from "@microsoft/signalr";

const HUB_URL = "http://192.168.31.188:5080/cluster-link/hub";
const TOKEN = "738af663c42746ca82ff7e6b26d3c62e";
const RS = "\x1e";

const RealWS = globalThis.WebSocket;
globalThis.WebSocket = class extends RealWS {
  constructor(url, protocols) {
    console.log(`[wire] WS URL: ${url}`);
    super(url, protocols);
    const origSend = this.send.bind(this);
    this.send = (data) => {
      const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
      console.log(`[wire] SEND ${JSON.stringify(text.split(RS).filter(Boolean).join(" | "))}`);
      return origSend(data);
    };
    this.addEventListener("message", (ev) => {
      const text = typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8");
      console.log(`[wire] RECV ${JSON.stringify(text.split(RS).filter(Boolean).join(" | "))}`);
    });
  }
};

const connection = new HubConnectionBuilder()
  .withUrl(HUB_URL, {
    accessTokenFactory: () => TOKEN,
    transport: HttpTransportType.WebSockets,
    skipNegotiation: true,
  })
  .configureLogging(LogLevel.None)
  .build();

connection.on("taskDispatched", (p) => console.log("PUSH taskDispatched", JSON.stringify(p)));
connection.on("taskEventReceived", (p) => console.log("PUSH taskEventReceived", JSON.stringify(p)));

await connection.start();
console.log("[wire] CONNECTED, invoking registerNode nodeId=1");
try {
  const snap = await connection.invoke("registerNode", { nodeId: "1", link: { protocol: "dsh", version: "0.1.0-rc.7" } });
  console.log("[wire] registerNode OK ->", JSON.stringify(snap).slice(0, 300));
} catch (e) {
  console.log("[wire] registerNode FAILED ->", e.message);
}
await connection.stop();
process.exit(0);
