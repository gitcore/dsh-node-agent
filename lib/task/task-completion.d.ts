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
export declare function summarizeOutcome(events: readonly SessionEvent[], firstSeq: number): TaskOutcome;
