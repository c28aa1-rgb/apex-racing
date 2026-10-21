import { Quaternion } from 'three';
import type { PartyPose } from '../shared/party';
import type { Vec3, Quat } from '../shared/tracks';
import { percentiles, recordSample } from './party-network';
import { PARTY_POSE_INTERVAL_MS } from '../shared/party-network';

type Sample = { t: number; p: Vec3; q: Quat; v?: Vec3 };
const speed = (v?: Vec3) => v ? Math.hypot(v.x, v.y, v.z) : 0;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
/** Longest a pose is carried forward by its velocity when placing a car where it is now (covers delivery age plus a missed packet). */
const PRESENT_AHEAD_MS = 250;
/** Seconds to ease the drawn car onto a new estimate (position, rotation), so a fresh packet never snaps it. */
const PRESENT_EASE = .08, PRESENT_TURN_EASE = .06;

export class RemoteMotion {
  private samples: Sample[] = [];
  private sequence = -1;
  private clock?: number;
  private lastFrame?: number;
  private lastReceipt?: number;
  private interval = PARTY_POSE_INTERVAL_MS;
  private delay = 100;
  private age = 0; private jitter = 0;
  private ages: number[] = [];
  private gaps: number[] = [];
  private received = 0; private missing = 0; private stale = 0; private resets = 0;
  private interpolated = 0; private extrapolated = 0; private held = 0;
  private qa = new Quaternion(); private qb = new Quaternion();
  private shown?: { p: Vec3; q: Quaternion; at: number };
  constructor(private metersPerUnit = 1) {}
  add(pose: PartyPose, receivedAt: number) {
    if (pose.sequence <= this.sequence) { this.stale++; return false; }
    if (this.sequence >= 0) this.missing += Math.max(0, pose.sequence - this.sequence - 1);
    this.sequence = pose.sequence;
    const t = pose.t ?? receivedAt, last = this.samples.at(-1);
    if (last && t <= last.t) { this.stale++; return false; }
    if (last) {
      const dt = (t - last.t) / 1000;
      const distance = Math.hypot(pose.p.x - last.p.x, pose.p.y - last.p.y, pose.p.z - last.p.z) * this.metersPerUnit;
      const previous = this.samples.at(-2);
      const inferred = previous ? Math.hypot(last.p.x - previous.p.x, last.p.y - previous.p.y, last.p.z - previous.p.z) / ((last.t - previous.t) / 1000) : 0;
      const velocity = Math.max(speed(pose.v), speed(last.v), inferred) * this.metersPerUnit;
      // A long pause or implausible motion starts a new curve; a missed packet at racing speed does not.
      if (dt > 1 || distance > Math.max(15, velocity * dt * 1.5 + 5)) {
        this.samples = []; this.clock = undefined; this.lastFrame = undefined; this.shown = undefined; this.resets++;
      } else this.interval += (Math.min(500, t - last.t) - this.interval) * .2;
    }
    if (this.lastReceipt !== undefined) recordSample(this.gaps, Math.max(0, receivedAt - this.lastReceipt));
    this.lastReceipt = receivedAt; this.received++;
    const age = Math.max(0, receivedAt - t);
    recordSample(this.ages, age);
    if (this.received === 1) this.age = age;
    this.jitter += (Math.abs(age - this.age) - this.jitter) * .1;
    this.age += (age - this.age) * .1;
    // Cover typical transit variation; brief gaps use bounded prediction instead of keeping old spikes buffered.
    const wanted = clamp(this.age + this.jitter * 2 + this.interval / 2 + 5, 50, 250);
    this.delay = wanted > this.delay ? wanted : this.delay + (wanted - this.delay) * .15;
    this.samples.push({ t, p: pose.p, q: pose.q, v: pose.v });
    if (this.samples.length > 32) this.samples.shift();
    return true;
  }
  sample(now: number): Sample | undefined {
    const samples = this.samples;
    if (!samples.length) return;
    if (samples.length === 1) { this.held++; return samples[0]; }
    const target = now - this.delay, step = this.lastFrame === undefined ? 0 : Math.max(0, now - this.lastFrame);
    this.lastFrame = now;
    if (this.clock === undefined || Math.abs(target - this.clock) > 1000) this.clock = target;
    else { this.clock += step; this.clock += step * clamp((target - this.clock) / 250, -.5, .1); }
    const t = this.clock, i = samples.findIndex(sample => sample.t > t);
    if (i === 0) { this.held++; return samples[0]; }
    if (i < 0) {
      const a = samples.at(-2)!, b = samples.at(-1)!, span = Math.max(1, b.t - a.t), elapsed = Math.max(0, t - b.t);
      if (elapsed > 100) this.held++; else this.extrapolated++;
      const seconds = Math.min(100, elapsed) / 1000;
      const v = b.v ?? { x: (b.p.x - a.p.x) * 1000 / span, y: (b.p.y - a.p.y) * 1000 / span, z: (b.p.z - a.p.z) * 1000 / span };
      const q = this.qa.copy(a.q).slerp(this.qb.copy(b.q), 1 + Math.min(seconds * 1000 / span, 1));
      return { t: b.t + seconds * 1000, p: { x: b.p.x + v.x * seconds, y: b.p.y + v.y * seconds, z: b.p.z + v.z * seconds }, q: { x: q.x, y: q.y, z: q.z, w: q.w } };
    }
    this.interpolated++;
    const p0 = samples[Math.max(0, i - 2)], p1 = samples[i - 1], p2 = samples[i], p3 = samples[Math.min(samples.length - 1, i + 1)];
    const span = Math.max(1, p2.t - p1.t), u = clamp((t - p1.t) / span, 0, 1), u2 = u * u, u3 = u2 * u;
    const tangent = (point: Sample, a: Sample, b: Sample, axis: keyof Vec3) => point.v ? point.v[axis] * span / 1000 : (b.p[axis] - a.p[axis]) / Math.max(1, b.t - a.t) * span;
    const axis = (key: keyof Vec3) => (2 * u3 - 3 * u2 + 1) * p1.p[key] + (u3 - 2 * u2 + u) * tangent(p1, p0, p2, key)
      + (-2 * u3 + 3 * u2) * p2.p[key] + (u3 - u2) * tangent(p2, p1, p3, key);
    const q = this.qa.copy(p1.q).slerp(this.qb.copy(p2.q), u);
    return { t, p: { x: axis('x'), y: axis('y'), z: axis('z') }, q: { x: q.x, y: q.y, z: q.z, w: q.w } };
  }
  /**
   * Where the car is now, not where it was a buffer ago: the newest pose carried forward by its velocity (at most
   * PRESENT_AHEAD_MS), then eased toward each new estimate. Party races draw and collide with this, so two drivers touch
   * at the same moment on both screens; sample() draws ~100 ms in the past and would put a car metres behind itself at speed.
   */
  present(now: number): { p: Vec3; q: Quat; v: Vec3 } | undefined {
    const b = this.samples.at(-1); if (!b) return;
    const a = this.samples.at(-2), span = a ? Math.max(1, b.t - a.t) : 1;
    const v = b.v ?? (a ? { x: (b.p.x - a.p.x) * 1000 / span, y: (b.p.y - a.p.y) * 1000 / span, z: (b.p.z - a.p.z) * 1000 / span } : { x: 0, y: 0, z: 0 });
    const ahead = clamp(now - b.t, 0, PRESENT_AHEAD_MS) / 1000;
    const p = { x: b.p.x + v.x * ahead, y: b.p.y + v.y * ahead, z: b.p.z + v.z * ahead };
    // Carry the turn between the last two poses forward too.
    const q = a ? this.qa.copy(a.q).slerp(this.qb.copy(b.q), 1 + Math.min(ahead * 1000 / span, 2)) : this.qa.copy(b.q);
    const shown = this.shown, dt = shown ? clamp((now - shown.at) / 1000, 0, .1) : 0;
    if (shown) { shown.p.x += v.x * dt; shown.p.y += v.y * dt; shown.p.z += v.z * dt; }
    if (!shown || Math.hypot(p.x - shown.p.x, p.y - shown.p.y, p.z - shown.p.z) * this.metersPerUnit > 8) this.shown = { p, q: q.clone(), at: now };
    else {
      const k = 1 - Math.exp(-dt / PRESENT_EASE);
      shown.p.x += (p.x - shown.p.x) * k; shown.p.y += (p.y - shown.p.y) * k; shown.p.z += (p.z - shown.p.z) * k;
      shown.q.slerp(q, 1 - Math.exp(-dt / PRESENT_TURN_EASE)); shown.at = now;
    }
    const drawn = this.shown!;
    return { p: { ...drawn.p }, q: { x: drawn.q.x, y: drawn.q.y, z: drawn.q.z, w: drawn.q.w }, v };
  }
  diagnostics(now: number) {
    return { received: this.received, missingSequences: this.missing, stale: this.stale, resets: this.resets,
      bufferMs: this.delay, intervalMs: this.interval, deliveryAgeMs: percentiles(this.ages), arrivalGapMs: percentiles(this.gaps),
      latestPoseAgeMs: this.samples.length ? now - this.samples.at(-1)!.t : null,
      playbackAgeMs: this.samples.length ? now - Math.max(this.samples[0].t, Math.min(this.clock ?? this.samples.at(-1)!.t, this.samples.at(-1)!.t + 100)) : null,
      interpolatedFrames: this.interpolated, extrapolatedFrames: this.extrapolated, heldFrames: this.held };
  }
}
