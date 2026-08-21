import { HubConnectionBuilder, HttpTransportType, LogLevel } from "@microsoft/signalr";
const HUB_URL = "http://192.168.31.188:5080/cluster-link/hub";
const conn = new HubConnectionBuilder()
  .withUrl(HUB_URL, { accessTokenFactory: () => "dev-probe-token", transport: HttpTransportType.WebSockets, skipNegotiation: true })
  .configureLogging(LogLevel.None).build();
await conn.start();
const NAMES = ["TaskAccepted","TaskRejected","TaskEvent","TaskCompleted","DispatchTask","CancelTask","UnregisterNode","DeregisterNode","NodeDisconnect","TaskResult"];
for (const name of NAMES) {
  try {
    await conn.invoke(name, { probe: true });
    console.log(`EXISTS-OK     ${name}`);
  } catch (e) {
    const msg = e?.message ?? String(e);
    console.log(`${msg.includes("Method does not exist") ? "ABSENT       " : "EXISTS-ERROR "} ${name}  ${msg.slice(0,80)}`);
  }
}
await conn.stop();
process.exit(0);
