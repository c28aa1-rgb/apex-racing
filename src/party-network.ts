import { PARTY_MAX_IN_FLIGHT, PARTY_POSE_INTERVAL_MS } from '../shared/party-network';
export const POSE_INTERVAL_MS = PARTY_POSE_INTERVAL_MS;
export function percentiles(values: number[]) {
  if (!values.length) return { p50: null, p95: null };
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: sorted[Math.floor((sorted.length - 1) * .5)], p95: sorted[Math.ceil((sorted.length - 1) * .95)] };
}
export function recordSample(values: number[], value: number) {
  values.push(value);
  if (values.length > 120) values.shift();
}

/** A bounded send cadence: replies never schedule the next pose or queue an old one. */
export class PartyUpdates<T> {
  sent = 0; received = 0; skipped = 0; failed = 0; inFlight = 0; peakInFlight = 0;
  private nextAt = 0;
  private lastSent?: number;
  private stopped = false;
  private rtts: number[] = [];
  private intervals: number[] = [];
  constructor(private options: {
    ready: () => boolean;
    send: () => Promise<T>;
    receive: (result: T, sentAt: number, receivedAt: number) => void;
    error: (cause: unknown) => void;
  }) {}
  tick(now = performance.now()) {
    if (this.stopped || now < this.nextAt) return;
    const ready = this.options.ready();
    const interval = ready ? POSE_INTERVAL_MS : 500;
    // Keep the timer's phase: resetting from each receipt of a timer tick skips slots on small clock variations.
    this.nextAt = now - this.nextAt >= interval ? now + interval : this.nextAt + interval;
    if (this.inFlight >= (ready ? PARTY_MAX_IN_FLIGHT : 1)) { this.skipped++; return; }
    if (this.lastSent !== undefined && ready) recordSample(this.intervals, now - this.lastSent);
    this.lastSent = now;
    this.sent++; this.inFlight++; this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    const send = async () => {
      try {
        const result = await this.options.send(), receivedAt = performance.now();
        if (this.stopped) return;
        this.received++; recordSample(this.rtts, Math.max(0, receivedAt - now));
        this.options.receive(result, now, receivedAt);
      } catch (cause) { if (!this.stopped) { this.failed++; this.nextAt = Math.max(this.nextAt, performance.now() + 500); this.options.error(cause); } }
      finally { this.inFlight--; }
    };
    void send();
  }
  stop() { this.stopped = true; }
  diagnostics() {
    return { sent: this.sent, received: this.received, skipped: this.skipped, failed: this.failed,
      inFlight: this.inFlight, peakInFlight: this.peakInFlight, rttMs: percentiles(this.rtts), sendIntervalMs: percentiles(this.intervals) };
  }
}
