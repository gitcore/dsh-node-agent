/** Walk the event log from `firstSeq`; collect the last assistant text and turn-end reason. */
export function summarizeOutcome(events, firstSeq) {
    let inTurn = false;
    let text = "";
    let reasonKind;
    let errorCode;
    let errorMessage;
    for (const event of events) {
        if (event.seq < firstSeq)
            continue;
        if (event.type === "turn/start") {
            inTurn = true;
            continue;
        }
        if (!inTurn)
            continue;
        if (event.type === "assistant/message") {
            const content = (event.data.message?.content ?? []);
            const joined = content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
            if (joined !== "")
                text = joined;
        }
        if (event.type === "turn/end") {
            reasonKind = event.data.reason.kind;
            if (event.data.reason.kind === "error") {
                const failure = event.data.reason.error;
                errorCode = typeof failure?.code === "string" ? failure.code : undefined;
                errorMessage = typeof failure?.message === "string" ? failure.message : undefined;
            }
        }
    }
    const finishReason = reasonKind === "completed" ? "completed"
        : reasonKind === "error" ? "error"
            : reasonKind === "blocked" ? "blocked"
                : "aborted";
    return { text, finishReason, errorCode, errorMessage };
}
