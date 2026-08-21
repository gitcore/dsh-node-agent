/**
 * Task completion detection: aggregate the final assistant text and map the
 * last `turn/end` reason to the plugin's FinishReason vocabulary.
 */
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { FinishReason } from "../protocol.js";

export interface TaskOutcome {
  text: string;
  finishReason: FinishReason;
  errorCode?: string;
  errorMessage?: string;
}

/** Walk the event log from `firstSeq`; collect the last assistant text and turn-end reason. */
export function summarizeOutcome(events: readonly SessionEvent[], firstSeq: number): TaskOutcome {
  let inTurn = false;
  let text = "";
  let reasonKind: string | undefined;
  let errorCode: string | undefined;
  let errorMessage: string | undefined;

  for (const event of events) {
    if (event.seq < firstSeq) continue;
    if (event.type === "turn/start") {
      inTurn = true;
      continue;
    }
    if (!inTurn) continue;
    if (event.type === "assistant/message") {
      const content = (event.data.message?.content ?? []) as ReadonlyArray<{ type?: string; text?: string }>;
      const joined = content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      if (joined !== "") text = joined;
    }
    if (event.type === "turn/end") {
      reasonKind = event.data.reason.kind;
      if (event.data.reason.kind === "error") {
        const failure = event.data.reason.error as { code?: unknown; message?: unknown };
        errorCode = typeof failure?.code === "string" ? failure.code : undefined;
        errorMessage = typeof failure?.message === "string" ? failure.message : undefined;
      }
    }
  }

  const finishReason: FinishReason =
    reasonKind === "completed" ? "completed"
      : reasonKind === "error" ? "error"
        : reasonKind === "blocked" ? "blocked"
          : "aborted";
  return { text, finishReason, errorCode, errorMessage };
}
