import { HubConnectionBuilder, HttpTransportType, LogLevel } from "@microsoft/signalr";
const HUB_URL = "http://192.168.31.188:5080/cluster-link/hub";
const conn = new HubConnectionBuilder()
  .withUrl(HUB_URL, { accessTokenFactory: () => "dev-probe-token", transport: HttpTransportType.WebSockets, skipNegotiation: true })
  .configureLogging(LogLevel.None).build();
await conn.start();
const NAMES = ["ReportTaskAccepted","TaskAccept","TaskAck","AckTask","AcceptTask","OnTaskAccepted",
  "ReportTaskRejected","RejectTask","OnTaskRejected","ReportTaskEvent","TaskEventReport","EmitTaskEvent",
  "ReportTaskCompleted","TaskDone","TaskFinished","OnTaskCompleted","NotifyTaskCompleted",
  "ReportHeartbeat","NodeHeartbeat","Register","NodeRegister","RegisterClusterNode","RegisterNodeAsync","heartbeatAsync","registerNodeAsync"];
for (const name of NAMES) {
  try { await conn.invoke(name, {}); console.log(`EXISTS-OK     ${name}`); }
  catch (e) {
    const msg = e?.message ?? String(e);
    if (!msg.includes("Method does not exist")) console.log(`EXISTS-ERROR  ${name}  ${msg.slice(0,60)}`);
  }
}
console.log("scan done (only EXISTS lines printed)");
await conn.stop(); process.exit(0);
