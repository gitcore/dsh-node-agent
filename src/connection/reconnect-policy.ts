/**
 * Reconnect schedule for the SignalR connection: fixed base delays with
 * jitter for the initial-connect retry loop; the delay array doubles as the
 * `withAutomaticReconnect` schedule for established-connection drops.
 */
export class ReconnectPolicy {
  constructor(private readonly delays: number[] = [0, 1_000, 5_000, 15_000, 30_000]) {}

  /** Schedule handed to `withAutomaticReconnect` (established-drop retries). */
  get schedule(): number[] {
    return this.delays;
  }

  /** Jittered delay for attempt `n` (0-based), used by the manual retry loop. */
  nextDelay(attempt: number): number {
    const base = this.delays[Math.min(attempt, this.delays.length - 1)] ?? this.delays[this.delays.length - 1] ?? 5_000;
    const jittered = base * 0.8 + Math.random() * base * 0.4;
    return Math.round(jittered);
  }
}
