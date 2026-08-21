/**
 * Reconnect schedule for the SignalR connection: fixed base delays with
 * jitter for the initial-connect retry loop; the delay array doubles as the
 * `withAutomaticReconnect` schedule for established-connection drops.
 */
export declare class ReconnectPolicy {
    private readonly delays;
    constructor(delays?: number[]);
    /** Schedule handed to `withAutomaticReconnect` (established-drop retries). */
    get schedule(): number[];
    /** Jittered delay for attempt `n` (0-based), used by the manual retry loop. */
    nextDelay(attempt: number): number;
}
