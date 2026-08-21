const HUB = "192.168.31.188:5080/cluster-link/hub";
const NODE_ID = process.argv[2] ?? "1";
const TOKEN = process.argv[3] ?? "738af663c42746ca82ff7e6b26d3c62e";
const RS = "\x1e";
const url = `ws://${HUB}?access_token=${TOKEN}`;
console.log("opening", url);
const ws = new WebSocket(url);
ws.onopen = () => {
  console.log("OPEN, sending handshake");
  ws.send(JSON.stringify({ protocol: "json", version: 1 }) + RS);
};
ws.onmessage = (ev) => {
  console.log("MSG typeof=", typeof ev.data, "len=", String(ev.data).length);
  console.log("MSG raw=", JSON.stringify(String(ev.data)));
  for (const t of String(ev.data).split(RS)) {
    if (!t.trim()) continue;
    console.log("  parsed:", t);
  }
};
ws.onerror = (e) => console.log("ERROR", e.message ?? e);
ws.onclose = (e) => { console.log("CLOSE code=", e.code, "reason=", e.reason); process.exit(0); };
setTimeout(() => { console.log("TIMEOUT, closing"); ws.close(); }, 6000);
