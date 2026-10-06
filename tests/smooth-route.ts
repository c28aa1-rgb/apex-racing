// Shared by the smooth-track gates: tests/smooth-audit.ts (Node) and tests/smooth-visual-audit.mjs
// (browser, loaded through Vite as /tests/smooth-route.ts). Both drive the SAME lap with the SAME driver:
//   buildRoute    the saved drive trace (track.mapPath) or, without one, the authored track.segments
//   speedProfile  curvature-limited racing speeds with braking zones, per car
//   RouteDriver   pure pursuit (as tests/bump-audit.ts) steering on yaw rate, keyboard inputs only
//   visibleFloor  the visible venue floor under a point: the same downward ray as Simulation.visibleGroundAt
//                 (sensors such as the support skin and chassis-only helper floors excluded), plus its normal
//   realBarrier   geometric test for a real wall: a steep face reaching > 0.5 m above the road nearby
// Only public Simulation members are used, so this keeps working once the support skin is removed.
// Lengths: native world units unless named ...M (metres = units * track.metersPerUnit).
import RAPIER from '@dimforge/rapier3d-compat';
import { Input, rotate, type Simulation } from '../shared/physics';
import { carById } from '../shared/cars';
import type { Track, Vec3 } from '../shared/tracks';

export const MPH = 2.23694;
export const DEFAULT_CARS = ['red-bull-rb19', 'nascar-camry', 'porsche-911-gt3', 'bugatti-bolide', 'celica-gt4'];
export const VENUE_TRACKS = ['bugatti', 'spa', 'hungaroring', 'barcelona', 'indianapolis', 'daytona', 'marina-bay'];

export type Route = {
  trackId: string; source: 'trace' | 'centerline' | 'authored'; closed: boolean; mpu: number;
  points: Vec3[];
  /** Cumulative horizontal distance at each point (native units); length includes the closing edge when closed. */
  s: number[]; length: number;
  /** Half the drivable lane width at each point (native units). */
  halfWidth: number[];
};

const dedupe = (points: Vec3[], widths: number[], minGap: number) => {
  const p: Vec3[] = [], w: number[] = [];
  points.forEach((point, i) => { const last = p.at(-1); if (!last || Math.hypot(point.x - last.x, point.z - last.z) >= minGap) { p.push({ x: point.x, y: point.y, z: point.z }); w.push(widths[i]); } });
  return { p, w };
};

function resample(points: Vec3[], widths: number[], spacing: number, closed: boolean) {
  const p: Vec3[] = [], w: number[] = [], n = points.length, edges = closed ? n : n - 1;
  let carry = 0;
  for (let i = 0; i < edges; i++) {
    const a = points[i], b = points[(i + 1) % n], len = Math.hypot(b.x - a.x, b.z - a.z);
    for (let d = carry; d < len; d += spacing) { const t = d / len; p.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t }); w.push(widths[i]); }
    carry = ((carry - len) % spacing + spacing) % spacing;
  }
  if (!closed) { p.push({ ...points[n - 1] }); w.push(widths[n - 1]); }
  return { p, w };
}
function smoothPath({ p, w }: { p: Vec3[]; w: number[] }, closed: boolean, sigma: number) {
  const n = p.length, reach = Math.ceil(sigma * 3), out: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const r = closed ? reach : Math.min(reach, i, n - 1 - i);
    let x = 0, y = 0, z = 0, total = 0;
    for (let k = -r; k <= r; k++) { const q = p[((i + k) % n + n) % n], g = Math.exp(-k * k / (2 * sigma * sigma)); x += q.x * g; y += q.y * g; z += q.z * g; total += g; }
    out.push({ x: x / total, y: y / total, z: z / total });
  }
  return { p: out, w };
}

/**
 * Points of a derived asphalt centreline file (work/smooth-audit/<id>-centerline.json, written by the
 * characterisation scripts from the clean GLB): either an array of {x,y,z,...} or {stations:[{x,y,z,...}]}.
 */
export function parseCenterline(json: unknown): Vec3[] | undefined {
  const list = Array.isArray(json) ? json : (json as { stations?: unknown })?.stations;
  if (!Array.isArray(list)) return undefined;
  const points = list.filter((p): p is Vec3 => [p?.x, p?.y, p?.z].every(Number.isFinite)).map(p => ({ x: p.x, y: p.y, z: p.z }));
  return points.length > 10 ? points : undefined;
}

/** Closes a loop polyline where its second half passes closest to its first point (within 30 m); undefined if it is no loop. */
function closeLoop(raw: Vec3[], mpu: number) {
  const first = raw[0];
  let cut = -1, best = Infinity;
  for (let i = Math.floor(raw.length / 2); i < raw.length; i++) { const d = Math.hypot(raw[i].x - first.x, raw[i].z - first.z); if (d < best) { best = d; cut = i; } }
  return best * mpu < 30 ? cut : undefined;
}

/**
 * The lap both gates drive. Priority: the saved drive trace (track.mapPath: grid to finish line, open), else a
 * derived asphalt centreline (closed loop), else the authored track.segments (closed loop). Authored segments are
 * NOT on the asphalt at Bugatti (13 m median, 40 m max off) and Marina Bay (both tests/driver.ts driveTrack and
 * this driver end in walls there), so the gates pass the characterisation centrelines for those circuits.
 * Loops are oriented to the saved grid's heading (Bugatti's authored/centreline order runs against the saved
 * checkpoints) so the car laps in the race direction from its own grid.
 */
export function buildRoute(track: Track, centerline?: Vec3[]): Route {
  const mpu = track.metersPerUnit;
  let raw: Vec3[] = [], widths: number[] = [], source: Route['source'], closed: boolean;
  // Same lane width the physics gives a saved drive trace (the authored mean, at least 10 m).
  const meanWidth = Math.max(10, track.segments.reduce((sum, segment) => sum + segment.width, 0) / track.segments.length);
  if (track.mapPath && track.mapPath.length > 1) {
    // A trace runs from the grid to the line: driven once, open.
    raw = track.mapPath; widths = raw.map(() => meanWidth); source = 'trace'; closed = false;
  } else if (centerline && centerline.length > 10) {
    raw = centerline.map(p => ({ ...p })); widths = raw.map(() => meanWidth); source = 'centerline';
    const cut = closeLoop(raw, mpu); closed = cut !== undefined;
    if (cut !== undefined) { raw = raw.slice(0, cut + 1); widths = widths.slice(0, cut + 1); }
  } else {
    track.segments.forEach((segment, i) => {
      const n = Math.max(1, Math.ceil(Math.hypot(segment.end.x - segment.start.x, segment.end.z - segment.start.z) * mpu / 4));
      const previous = track.segments[i - 1], joined = previous && Math.hypot(previous.end.x - segment.start.x, previous.end.z - segment.start.z) < 1e-3;
      for (let k = joined ? 1 : 0; k <= n; k++) {
        const t = k / n;
        raw.push({ x: segment.start.x + (segment.end.x - segment.start.x) * t, y: segment.start.y + (segment.end.y - segment.start.y) * t, z: segment.start.z + (segment.end.z - segment.start.z) * t });
        widths.push(segment.width);
      }
    });
    source = 'authored';
    // Authored circuits are loops that run back through their own first point and then overlap the first
    // segment for a while (Bugatti, Marina Bay, Barcelona, Indianapolis end ~100 m past the start). Cut the
    // polyline where it passes its first point again and close the loop there, so one lap is the whole circuit.
    const cut = closeLoop(raw, mpu); closed = cut !== undefined;
    if (cut !== undefined) { raw = raw.slice(0, cut + 1); widths = widths.slice(0, cut + 1); }
  }
  if (closed) {
    // Lap in the race direction of the saved grid.
    const grid = track.spawn ?? track.start;
    let nearest = 0, best = Infinity;
    raw.forEach((p, i) => { const d = Math.hypot(p.x - grid.position.x, p.z - grid.position.z); if (d < best) { best = d; nearest = i; } });
    const a = raw[Math.max(0, nearest - 3)], b = raw[Math.min(raw.length - 1, nearest + 3)];
    if ((b.x - a.x) * grid.forward.x + (b.z - a.z) * grid.forward.z < 0) { raw.reverse(); widths.reverse(); }
  }
  const deduped = dedupe(raw, widths, .3 / mpu);
  if (closed && deduped.p.length > 2 && Math.hypot(deduped.p[0].x - deduped.p.at(-1)!.x, deduped.p[0].z - deduped.p.at(-1)!.z) * mpu < 1) { deduped.p.pop(); deduped.w.pop(); }
  // Uniform 4 m spacing, then a Gaussian (sigma 6 m) along the route: rounds authored polyline corners and
  // irons out recording glitches in drive traces (Daytona's has a 13 m sideways jump in turn 2) without
  // straightening real corners. Open routes keep their end points (the window shrinks symmetrically).
  // Derived centrelines are already smooth and follow the asphalt: only sigma 2 m, so tight street corners
  // (Marina Bay) are not cut towards the inside barriers.
  const { p, w } = smoothPath(resample(deduped.p, deduped.w, 4 / mpu, closed), closed, (source === 'centerline' ? 2 : 6) / 4);
  const s = [0];
  for (let i = 1; i < p.length; i++) s.push(s[i - 1] + Math.hypot(p[i].x - p[i - 1].x, p[i].z - p[i - 1].z));
  const length = closed ? s.at(-1)! + Math.hypot(p[0].x - p.at(-1)!.x, p[0].z - p.at(-1)!.z) : s.at(-1)!;
  return { trackId: track.id, source, closed, mpu, points: p, s, length, halfWidth: w.map(x => x / 2) };
}

const wrapIndex = (route: Route, i: number) => { const n = route.points.length; return route.closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i)); };
/** Signed distance along the route from index a to index b (forward positive; closed routes take the short way). */
function along(route: Route, a: number, b: number) {
  let d = route.s[b] - route.s[a];
  if (route.closed) { if (d > route.length / 2) d -= route.length; else if (d < -route.length / 2) d += route.length; }
  return d;
}

/** Horizontal curvature (1/m) from the circle through points about +-20 m apart (irons out recorded-trace kinks), then the max over +-10 m. */
function curvature(route: Route) {
  const { points: p, mpu } = route, n = p.length, stencil = 20 / mpu, k = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let a = i, b = i;
    while (Math.abs(along(route, wrapIndex(route, a - 1), i)) < stencil && (route.closed ? i - a < n / 2 : a > 0)) a--;
    while (Math.abs(along(route, i, wrapIndex(route, b + 1))) < stencil && (route.closed ? b - i < n / 2 : b < n - 1)) b++;
    const A = p[wrapIndex(route, a)], B = p[i], C = p[wrapIndex(route, b)];
    const ab = Math.hypot(B.x - A.x, B.z - A.z), bc = Math.hypot(C.x - B.x, C.z - B.z), ac = Math.hypot(C.x - A.x, C.z - A.z);
    const cross = Math.abs((B.x - A.x) * (C.z - A.z) - (B.z - A.z) * (C.x - A.x));
    k[i] = ab > 0 && bc > 0 && ac > 0 ? 2 * cross / (ab * bc * ac) / mpu : 0;
  }
  const window = 10 / mpu;
  return k.map((_, i) => {
    let m = k[i];
    for (let j = i - 1; Math.abs(along(route, wrapIndex(route, j), i)) < window && i - j < n; j--) m = Math.max(m, k[wrapIndex(route, j)]);
    for (let j = i + 1; Math.abs(along(route, i, wrapIndex(route, j))) < window && j - i < n; j++) m = Math.max(m, k[wrapIndex(route, j)]);
    return m;
  });
}

/**
 * Target speed (m/s) at each route point. Corner speed uses the simulation's own tyre budget
 * (12 + 4 * downforce m/s^2, plus the arcade grip ramp from 25 to 60 m/s) times `grip`; braking
 * zones use `brake` times the car's 100-0 km/h deceleration. Capped at 98% of top speed.
 */
export function speedProfile(route: Route, carId: string, grip = .8, brake = .55): number[] {
  const physics = carById(carId).physics, top = physics.topSpeedKph / 3.6 * .98, n = route.points.length;
  const lateral = (v: number) => grip * (12 + physics.downforce * 4 + 6 * Math.max(0, Math.min(1, (v - 25) / 35)));
  const decel = brake * 27.78 * 27.78 / (2 * physics.brakeDistance);
  const v = curvature(route).map(k => { let speed = top; for (let it = 0; it < 4; it++) speed = Math.min(top, Math.sqrt(lateral(speed) / Math.max(k, 1e-6))); return Math.max(9, speed); });
  for (let round = 0; round < (route.closed ? 2 : 1); round++)
    for (let i = n - 2 + (route.closed ? 1 : 0); i >= 0; i--) {
      const next = wrapIndex(route, i + 1), ds = Math.abs(along(route, i, next)) * route.mpu;
      v[i] = Math.min(v[i], Math.sqrt(v[next] * v[next] + 2 * decel * ds));
    }
  return v;
}

/** Keyboard-input racing driver along a Route. Deterministic: a function of the simulation state only. */
export class RouteDriver {
  idx = 0; t = 0; startIdx = 0;
  /** Distance driven along the route since the start (native units). */
  progress = 0; lapLength = 0; done = false;
  /** Signed lateral offset from the route (native units, + = right of travel) and the lane half width there. */
  lateral = 0; halfWidth = 0;
  alpha = 0; targetSpeed = 0;
  recoveries = 0; respawnRequests = 0; recovering = false;
  private stuck = 0; private reversing = 0; private upsideDown = 0; private lastS = 0; private pulse = 0;
  constructor(public route: Route, public profile: number[]) {}

  /** Projects p onto the route near the current index (global search after a jump). */
  locate(p: Vec3, global = false): void {
    const { points, closed } = this.route, n = points.length;
    let best = Infinity, bi = this.idx, bt = 0;
    const test = (i: number) => {
      const a = points[i], j = wrapIndex(this.route, i + 1); if (!closed && i >= n - 1) return;
      const b = points[j], dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2));
      const d = Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t);
      if (d < best) { best = d; bi = i; bt = t; }
    };
    if (global) for (let i = 0; i < n; i++) test(i);
    else for (let k = -3; k <= 40; k++) { const i = closed ? wrapIndex(this.route, this.idx + k) : this.idx + k; if (i >= 0 && i < n) test(i); }
    if (!global && best * this.route.mpu > 25) { this.locate(p, true); return; }
    this.idx = bi; this.t = bt;
    const a = points[bi], b = points[wrapIndex(this.route, bi + 1)], len = Math.hypot(b.x - a.x, b.z - a.z) || 1, fx = (b.x - a.x) / len, fz = (b.z - a.z) / len;
    this.lateral = (p.x - a.x) * fz - (p.z - a.z) * fx;
    this.halfWidth = this.route.halfWidth[bi];
    const s = this.route.s[bi] + len * bt;
    let ds = s - this.lastS; if (this.route.closed) { if (ds > this.route.length / 2) ds -= this.route.length; else if (ds < -this.route.length / 2) ds += this.route.length; }
    if (Math.abs(ds) * this.route.mpu < 60) this.progress += ds; // a respawn jump does not count as driving
    this.lastS = s;
    if (this.progress >= this.lapLength - .5 / this.route.mpu || (!this.route.closed && bi >= n - 2 && bt > .5)) this.done = true;
  }
  /** Point `distance` ahead of the current projection along the route. */
  ahead(distance: number): Vec3 {
    const { points } = this.route; let i = this.idx, t = this.t, left = distance;
    for (let guard = 0; guard < points.length; guard++) {
      if (!this.route.closed && i >= points.length - 1) return points.at(-1)!;
      const a = points[i], b = points[wrapIndex(this.route, i + 1)], len = Math.hypot(b.x - a.x, b.z - a.z);
      const rest = len * (1 - t);
      if (left <= rest) { const u = t + left / (len || 1); return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, z: a.z + (b.z - a.z) * u }; }
      left -= rest; i = wrapIndex(this.route, i + 1); t = 0;
      if (!this.route.closed && i >= points.length - 1) return points.at(-1)!;
    }
    return points[i];
  }
  /**
   * Starts the lap. Keeps the simulation's own (saved) grid spawn when it sits on the route facing along it;
   * otherwise places the car on the route, heading along it, and lets it settle. Returns the settle ticks used.
   */
  start(sim: Simulation): { teleported: boolean; settleTicks: number } {
    const mpu = this.route.mpu, p = sim.car.translation();
    this.locate(p, true);
    const forward = rotate(sim.car.rotation(), { x: 0, y: 0, z: 1 });
    const a = this.route.points[this.idx], b = this.ahead(10 / mpu), heading = Math.atan2(b.x - a.x, b.z - a.z);
    let mismatch = Math.atan2(forward.x, forward.z) - heading; while (mismatch > Math.PI) mismatch -= 2 * Math.PI; while (mismatch < -Math.PI) mismatch += 2 * Math.PI;
    let teleported = false, settleTicks = 0;
    if (Math.abs(this.lateral) > this.halfWidth || Math.abs(mismatch) > .6) {
      const at = { x: a.x + (this.route.points[wrapIndex(this.route, this.idx + 1)].x - a.x) * this.t, y: a.y, z: a.z + (this.route.points[wrapIndex(this.route, this.idx + 1)].z - a.z) * this.t };
      const floor = visibleFloor(sim, { ...at, y: at.y + 4 }, .5, 12) ?? { y: at.y };
      sim.car.setTranslation({ x: at.x, y: floor.y + 1.05, z: at.z }, true);
      sim.car.setRotation({ x: 0, y: Math.sin(heading / 2), z: 0, w: Math.cos(heading / 2) }, true);
      sim.car.setLinvel({ x: 0, y: 0, z: 0 }, true); sim.car.setAngvel({ x: 0, y: 0, z: 0 }, true);
      for (; settleTicks < 90; settleTicks++) sim.step(0);
      teleported = true; this.locate(sim.car.translation(), true);
    }
    // locate() left lastS at the start position along the route.
    this.startIdx = this.idx; this.progress = 0;
    this.lapLength = this.route.closed ? this.route.length : this.route.length - this.lastS;
    this.done = false;
    return { teleported, settleTicks };
  }
  /** Inputs for the next tick. */
  input(sim: Simulation): number {
    const mpu = this.route.mpu, p = sim.car.translation(), q = sim.car.rotation();
    this.locate(p);
    const forward = rotate(q, { x: 0, y: 0, z: 1 }), up = rotate(q, { x: 0, y: 1, z: 0 }), w = sim.car.angvel();
    const speedM = sim.speed * mpu;
    // Pure pursuit: the yaw rate that arcs onto the route a speed-dependent distance ahead.
    const look = Math.max(9, Math.min(70, speedM * .75)) / mpu, aim = this.ahead(look);
    let alpha = Math.atan2(aim.x - p.x, aim.z - p.z) - Math.atan2(forward.x, forward.z);
    while (alpha > Math.PI) alpha -= 2 * Math.PI; while (alpha < -Math.PI) alpha += 2 * Math.PI;
    this.alpha = alpha;
    const distance = Math.max(1e-3, Math.hypot(aim.x - p.x, aim.z - p.z));
    const desiredYaw = 2 * Math.max(sim.forwardSpeed, 0) * Math.sin(alpha) / distance;
    const yawRate = w.x * up.x + w.y * up.y + w.z * up.z;
    // Speed: slowest profile value over the next ~0.6 s of road (brake pressure takes time to build).
    let target = Infinity;
    const preview = Math.max(6, speedM * .6) / mpu;
    for (let k = 0, i = this.idx; k < this.route.points.length; k++, i = wrapIndex(this.route, i + 1)) {
      target = Math.min(target, this.profile[i]);
      if (Math.abs(along(this.route, this.idx, i)) > preview || (!this.route.closed && i >= this.route.points.length - 1)) break;
    }
    if (Math.abs(alpha) > .5) target = Math.min(target, 12); else if (Math.abs(alpha) > .25) target = Math.min(target, 24);
    if (Math.abs(this.lateral) > this.halfWidth * .8) target *= .9;
    // Losing the line (understeer, a car with less grip than the profile assumes): shed speed in proportion.
    const offM = Math.abs(this.lateral) * mpu;
    if (offM > 1.2) target *= Math.max(.6, 1 - .08 * (offM - 1.2));
    this.targetSpeed = target;
    let input = speedM < target - .3 ? Input.Throttle : speedM > target + 1.2 ? Input.Brake : 0;
    const steer = desiredYaw - yawRate;
    if (steer > .012) input |= Input.Left; else if (steer < -.012) input |= Input.Right;
    // Recovery: only if the car is stuck (a wall, a spin) — counted by the caller as driver trouble.
    this.recovering = false;
    if (this.pulse > 0) { this.pulse--; this.recovering = true; return 0; }
    this.upsideDown = up.y < .25 ? this.upsideDown + 1 : 0;
    if (this.upsideDown > 60 && speedM < 6) { this.upsideDown = 0; this.recovering = true; this.pulse = 2; return Input.Flip; }
    this.stuck = speedM < 1 && !this.done ? this.stuck + 1 : 0;
    if (this.reversing > 0) { this.reversing--; this.recovering = true; return Input.Brake | (alpha > 0 ? Input.Right : Input.Left); }
    if (this.stuck > 120) {
      this.stuck = 0; this.recoveries++;
      if (this.recoveries % 4 === 0) { this.respawnRequests++; this.recovering = true; this.pulse = 2; return Input.Respawn; }
      this.reversing = 75; this.recovering = true; return Input.Brake;
    }
    return input;
  }
}

const FLAGS = RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC | RAPIER.QueryFilterFlags.EXCLUDE_SENSORS;
const filters = new WeakMap<Simulation, (collider: RAPIER.Collider) => boolean>();
/** Static geometry a player can see: not sensors (the support skin), not floors that only the chassis collides with. */
function staticFilter(sim: Simulation) {
  let filter = filters.get(sim);
  if (!filter) {
    // Default groups (no chassis-only floor exists): every static collider is visible.
    const groups = sim.car.collider(0).collisionGroups() >>> 0, chassis = groups >>> 16;
    filter = groups === 0xffffffff ? () => true : collider => ((collider.collisionGroups() & 0xffff) & ~chassis) !== 0;
    filters.set(sim, filter);
  }
  return filter;
}
export type Floor = { y: number; n: Vec3 };
/** Visible floor under p: ray from p.y + above, down `range`, first non-steep (|n.y| > 0.55) visible surface. */
export function visibleFloor(sim: Simulation, p: Vec3, above = .65, range = 1.8): Floor | undefined {
  const top = p.y + above;
  const hit = sim.world.castRayAndGetNormal(new RAPIER.Ray({ x: p.x, y: top, z: p.z }, { x: 0, y: -1, z: 0 }), range, false, FLAGS, undefined, undefined, undefined, staticFilter(sim));
  if (!hit || Math.abs(hit.normal.y) <= .55) return undefined;
  return { y: top - hit.timeOfImpact, n: { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z } };
}
/** Perpendicular height of p above the floor plane (native units; negative = below the visible surface). */
export const heightAbove = (p: Vec3, floor: Floor) => (p.y - floor.y) * Math.abs(floor.n.y);

/**
 * Height of the road the car physically rides at its centre: the mean contact height of the grounded wheels
 * (whatever they touch: venue mesh, a smoothing skin, a baked surface), else the visible floor, else 0.6 m
 * below the body. Used as the base for barrier heights, so a face is measured against the road the car is on.
 */
export function rideBase(sim: Simulation): number {
  const p = sim.car.translation(), v = sim.vehicle;
  let sum = 0, n = 0;
  for (let i = 0; i < 4; i++) if (v.wheelIsInContact(i)) { const c = v.wheelContactPoint(i); if (c) { sum += c.y; n++; } }
  if (n >= 2) return sum / n;
  return visibleFloor(sim, p, 1, 3)?.y ?? p.y - .6 / sim.track.metersPerUnit;
}

/**
 * True when a steep face (more than 60 degrees from the road plane) reaching higher than 0.5 m above the road
 * stands within `marginM` of the car body, sideways, ahead/behind or along the contact normal. Rays run parallel
 * to the car's road plane at 0.5 m and 0.9 m above the road the car rides (rideBase), so banking is not a
 * barrier, and kerbs, seams and triangle steps (0.5 m or lower) never are. With `contactPoint`, the same two
 * heights are also probed at the contact itself (narrow posts the centre rays pass by).
 */
export function realBarrier(sim: Simulation, contactNormal?: Vec3, marginM = 1.5, contactPoint?: Vec3): { distanceM: number; normal: Vec3 } | undefined {
  const mpu = sim.track.metersPerUnit, p = sim.car.translation(), q = sim.car.rotation();
  const up = rotate(q, { x: 0, y: 1, z: 0 }), right = rotate(q, { x: 1, y: 0, z: 0 }), forward = rotate(q, { x: 0, y: 0, z: 1 });
  const base = { x: p.x, y: rideBase(sim), z: p.z };
  const d = sim.carSpec.dimensions, halfW = d.bodyWidthM / 2, halfL = d.lengthM / 2;
  const directions: Vec3[] = [right, { x: -right.x, y: -right.y, z: -right.z }, forward, { x: -forward.x, y: -forward.y, z: -forward.z }];
  if (contactNormal) {
    const dot = contactNormal.x * up.x + contactNormal.y * up.y + contactNormal.z * up.z;
    const n = { x: contactNormal.x - up.x * dot, y: contactNormal.y - up.y * dot, z: contactNormal.z - up.z * dot }, l = Math.hypot(n.x, n.y, n.z);
    if (l > .2) directions.push({ x: n.x / l, y: n.y / l, z: n.z / l }, { x: -n.x / l, y: -n.y / l, z: -n.z / l });
  }
  let best: { distanceM: number; normal: Vec3 } | undefined;
  for (const h of [.5, .9]) for (const dir of directions) {
    const origin = { x: base.x + up.x * h / mpu, y: base.y + up.y * h / mpu, z: base.z + up.z * h / mpu };
    const extent = Math.abs(dir.x * right.x + dir.y * right.y + dir.z * right.z) * halfW + Math.abs(dir.x * forward.x + dir.y * forward.y + dir.z * forward.z) * halfL;
    const reach = extent + marginM;
    const hit = sim.world.castRayAndGetNormal(new RAPIER.Ray(origin, dir), reach / mpu, false, FLAGS, undefined, undefined, undefined, staticFilter(sim));
    if (!hit) continue;
    const n = hit.normal, facing = Math.abs(n.x * up.x + n.y * up.y + n.z * up.z);
    if (facing < .5) { const distanceM = Math.max(0, hit.timeOfImpact * mpu - extent); if (!best || distanceM < best.distanceM) best = { distanceM, normal: { x: n.x, y: n.y, z: n.z } }; }
  }
  // Narrow obstacles (posts, sign bases, barrier ends) can sit between the rays from the car centre: also probe
  // at the contact itself, from 0.4 m inside the body towards the contact, both ways along the contact normal.
  if (contactPoint && directions.length > 4) {
    const toward = { x: contactPoint.x - p.x, z: contactPoint.z - p.z }, length = Math.hypot(toward.x, toward.z), back = Math.min(length, .4 / mpu);
    const anchor = length > 1e-6 ? { x: contactPoint.x - toward.x / length * back, z: contactPoint.z - toward.z / length * back } : { x: p.x, z: p.z };
    for (const h of [.5, .9]) for (const dir of directions.slice(4)) {
      const origin = { x: anchor.x + up.x * h / mpu, y: base.y + up.y * h / mpu, z: anchor.z + up.z * h / mpu };
      const hit = sim.world.castRayAndGetNormal(new RAPIER.Ray(origin, dir), (.4 + marginM) / mpu, false, FLAGS, undefined, undefined, undefined, staticFilter(sim));
      if (!hit) continue;
      const n = hit.normal, facing = Math.abs(n.x * up.x + n.y * up.y + n.z * up.z);
      if (facing < .5) { const distanceM = Math.max(0, hit.timeOfImpact * mpu - .4); if (!best || distanceM < best.distanceM) best = { distanceM, normal: { x: n.x, y: n.y, z: n.z } }; }
    }
  }
  return best;
}

/** Physical bottom of each wheel at the moment of its suspension ray: hard point + direction * (suspension length + radius). */
export function wheelBottoms(sim: Simulation, rotationAtRaycast: { x: number; y: number; z: number; w: number }) {
  const v = sim.vehicle, out: ({ point: Vec3; grounded: boolean } | undefined)[] = [];
  for (let i = 0; i < 4; i++) {
    const hard = v.wheelHardPoint(i), length = v.wheelSuspensionLength(i), radius = v.wheelRadius(i), dirCs = v.wheelDirectionCs(i);
    if (!hard || length === null || radius === null || !dirCs) { out.push(undefined); continue; }
    const dir = rotate(rotationAtRaycast, dirCs), reach = length + radius;
    out.push({ point: { x: hard.x + dir.x * reach, y: hard.y + dir.y * reach, z: hard.z + dir.z * reach }, grounded: v.wheelIsInContact(i) });
  }
  return out;
}

/** Points on the bottom face of the chassis collider that rests on the floor (3 across x 5 along), world space. */
export function chassisBottom(sim: Simulation): Vec3[] {
  // The lowest collider that meets the floor: the safety box when the main box ignores the floor.
  const collider = sim.car.numColliders() > 1 ? sim.car.collider(1) : sim.car.collider(0), he = collider.halfExtents(), c = collider.translation(), q = collider.rotation(), out: Vec3[] = [];
  if (!he) return out;
  for (const sx of [-1, 0, 1]) for (const sz of [-1, -.5, 0, .5, 1]) {
    const o = rotate(q, { x: sx * he.x, y: -he.y, z: sz * he.z });
    out.push({ x: c.x + o.x, y: c.y + o.y, z: c.z + o.z });
  }
  return out;
}

/** Percentile of a sorted numeric array (nearest rank). */
export const percentile = (sorted: ArrayLike<number>, p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p / 100 * (sorted.length - 1))))] : NaN;
