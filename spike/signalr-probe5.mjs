import { HubConnectionBuilder, HttpTransportType, LogLevel } from "@microsoft/signalr";
const HUB_URL = "http://192.168.31.188:5080/cluster-link/hub";
const conn = new HubConnectionBuilder()
  .withUrl(HUB_URL, { accessTokenFactory: () => "dev-probe-token", transport: HttpTransportType.WebSockets, skipNegotiation: true })
  .configureLogging(LogLevel.None).build();
await conn.start();
console.log("== accepted/rejected/completed/status variants ==");
const NAMES = ["NotifyTaskAccepted","AcceptedTaskReport","AcceptTaskReport","AcknowledgeTask","TaskStatus","UpdateTaskStatus","ReportTask","ReportTaskStatus","TaskUpdate","NotifyTaskRejected","NotifyTaskCompleted","TaskEventReport2","ReportEvents","ReportTaskEvents","EmitEvents","PushEvents","TaskReport"];
for (const name of NAMES) {
  try { await conn.invoke(name, {}); console.log(`EXISTS-OK     ${name}`); }
  catch (e) {
    const msg = e?.message ?? String(e);
    if (!msg.includes("Method does not exist")) console.log(`EXISTS-ERROR  ${name}`);
  }
}
console.log("== ReportTaskEvent payload behavior ==");
const payloads = {
  docShape: { taskId: "t1", seq: 1, events: [{ type: "turn/start", ts: Date.now(), payload: {} }] },
  minimal:   { taskId: "t1" },
  zero:      undefined,
  array:     [{ type: "x", ts: Date.now(), payload: {} }],
};
for (const [label, p] of Object.entries(payloads)) {
  try {
    const args = p === undefined ? [] : [p];
    const r = await conn.invoke("ReportTaskEvent", ...args);
    console.log(`  ${label.padEnd(9)} OK -> ${JSON.stringify(r)?.slice(0,120)}`);
  } catch (e) {
    console.log(`  ${label.padEnd(9)} ERROR ${(e?.message ?? String(e)).slice(0,70)}`);
  }
}
await conn.stop(); process.exit(0);
