import { Message } from "@a2a-js/sdk";

const raw = {
  role: "ROLE_USER",
  parts: [{ text: "hello" }],
  messageId: "msg-01",
  contextId: "ctx-01",
  metadata: { workspace: "/root/test" },
};
const m = Message.fromJSON(raw);
const part = m.parts[0]?.content;
console.log("role:", m.role);
console.log("text:", part && part.$case === "text" ? part.value : "MISSING");
console.log("context:", m.contextId, "| workspace:", m.metadata?.workspace);
