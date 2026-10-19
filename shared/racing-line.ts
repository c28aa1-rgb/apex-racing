import type { CarDefinition } from './cars';

/**
 * A baked racing line (shared/racing-lines.ts, written by design/build-racing-lines.ts): a closed loop of
 * stations `step` native units apart, in race direction. `points` is flat [x, z, yLeft, yRight] per station,
 * the road height under each edge of the painted ribbon.
 */
export type BakedLine = { step: number; points: number[] };

export type RacingLine = {
  n: number; mpu: number;
  x: Float32Array; z: Float32Array; y: Float32Array; yl: Float32Array; yr: Float32Array;
  /** Metres from station i to station i + 1 (the last wraps to 0). */
  ds: Float32Array;
  /** Horizontal curvature (1/m), the tightest within a few metres. */
  curvature: Float32Array;
  /** Lap length in metres. */
  length: number;
};

export const Zone = { Accelerate: 1, Lift: 2, Brake: 3 } as const;
export type Zone = typeof Zone[keyof typeof Zone];

/**
 * How much of the simulation's cornering and braking budget the target speeds use. Below 1 so a human
 * driving to the line, not on the tyre limit, still makes every corner. Calibrated with tests/racing-line-audit.ts.
 */
export const LINE_TUNING = { grip: .8, brake: .8 };

const wrap = (i: number, n: number) => ((i % n) + n) % n;

export function racingLine(baked: BakedLine, metersPerUnit: number): RacingLine {
  const n = baked.points.length / 4, p = baked.points;
  const x = new Float32Array(n), z = new Float32Array(n), y = new Float32Array(n), yl = new Float32Array(n), yr = new Float32Array(n);
  for (let i = 0; i < n; i++) { x[i] = p[i*4]; z[i] = p[i*4+1]; yl[i] = p[i*4+2]; yr[i] = p[i*4+3]; y[i] = (yl[i] + yr[i]) / 2; }
  const ds = new Float32Array(n);
  let length = 0;
  for (let i = 0; i < n; i++) { const j = wrap(i + 1, n); ds[i] = Math.hypot(x[j] - x[i], z[j] - z[i]) * metersPerUnit; length += ds[i]; }
  // Circle through stations about 8 m either side, then the tightest over +-4 m: a corner's limit
  // applies a little before and after its apex.
  const reach = Math.max(1, Math.round(8 / (baked.step * metersPerUnit))), spread = Math.max(1, Math.round(4 / (baked.step * metersPerUnit)));
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = wrap(i - reach, n), c = wrap(i + reach, n);
    const ab = Math.hypot(x[i]-x[a], z[i]-z[a]), bc = Math.hypot(x[c]-x[i], z[c]-z[i]), ac = Math.hypot(x[c]-x[a], z[c]-z[a]);
    const cross = Math.abs((x[i]-x[a]) * (z[c]-z[a]) - (z[i]-z[a]) * (x[c]-x[a]));
    raw[i] = ab && bc && ac ? 2 * cross / (ab * bc * ac) / metersPerUnit : 0;
  }
  const curvature = new Float32Array(n);
  for (let i = 0; i < n; i++) { let m = 0; for (let k = -spread; k <= spread; k++) m = Math.max(m, raw[wrap(i + k, n)]); curvature[i] = m; }
  return { n, mpu: metersPerUnit, x, z, y, yl, yr, ds, curvature, length };
}

/** The simulation's cornering budget (m/s^2) at speed v: shared/physics.ts gripAcceleration. */
const cornering = (car: CarDefinition, v: number) =>
  Math.min(28, 15 + car.physics.downforce * 4 + 6 * Math.max(0, Math.min(1, (v - 25) / 35)));
/** Aero drag and rolling resistance (m/s^2). */
const resistance = (car: CarDefinition, v: number, mpu: number) => car.physics.drag * v * v / (car.physics.massKg * mpu) + .15;
/** Full-brake deceleration (m/s^2): shared/physics.ts arcade brakes plus drag, inside the traction budget. */
const braking = (car: CarDefinition, v: number, mpu: number, share: number) =>
  Math.min(26, share * 1.5 * 27.78 * 27.78 / (2 * car.physics.brakeDistance) + resistance(car, v, mpu));
/** Full-throttle acceleration (m/s^2): shared/physics.ts engine force and its top-speed balance, less resistance, up to top speed. */
export function acceleration(car: CarDefinition, v: number, mpu: number) {
  const { zeroToHundred, topSpeedKph, drag, massKg } = car.physics, top = topSpeedKph / 3.6, r = Math.max(0, v / top);
  const torque = Math.max(0, 1 - Math.pow(Math.max(0, (r - .32) / .68), 1.45));
  const balance = (drag * top * top / (massKg * mpu) + .015 * top) * Math.min(1, r * r) * Math.max(0, 2 - r);
  const net = Math.min(26, 27.78 / zeroToHundred * 1.16 * torque + balance) - resistance(car, v, mpu);
  // The limiter holds the car at its top speed.
  return r >= 1 ? Math.min(0, net) : net;
}

/**
 * The fastest speed (m/s) at each station from which the car can still make every corner ahead:
 * corner limits from curvature, then braking zones worked backwards from each one.
 */
export function brakingEnvelope(line: RacingLine, car: CarDefinition, tuning = LINE_TUNING): Float32Array {
  const { n, curvature, ds, mpu } = line, top = car.physics.topSpeedKph / 3.6, v = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let speed = top;
    for (let it = 0; it < 5; it++) speed = Math.min(top, Math.sqrt(tuning.grip * cornering(car, speed) / Math.max(curvature[i], 1e-6)));
    v[i] = Math.max(8, speed);
  }
  // Two passes around the loop so the braking zone for the first corner reaches back past the start.
  for (let round = 0; round < 2; round++) for (let i = n - 1; i >= 0; i--) {
    const next = v[wrap(i + 1, n)];
    v[i] = Math.min(v[i], Math.sqrt(next * next + 2 * braking(car, next, mpu, tuning.brake) * ds[i]));
  }
  return v;
}

/** Nearest station to (x, z), searching around `hint` first and the whole loop when the car has jumped (a recovery). */
export function nearestStation(line: RacingLine, x: number, z: number, hint = -1): number {
  const { n } = line;
  let best = Infinity, index = 0;
  const test = (i: number) => { const d = (line.x[i] - x) ** 2 + (line.z[i] - z) ** 2; if (d < best) { best = d; index = i; } };
  if (hint >= 0) {
    for (let k = -15; k <= 60; k++) test(wrap(hint + k, n));
    if (Math.sqrt(best) * line.mpu < 30) return index;
  }
  for (let i = 0; i < n; i++) test(i);
  return index;
}

/**
 * Dynamic colours for the `count` stations from `start`: what the car must do there if it keeps its throttle
 * pinned from its current speed and follows the line. Accelerate where full throttle stays under the envelope,
 * Lift where it would not but easing off is enough, Brake where the car has to shed speed harder than coasting.
 */
export function predictZones(line: RacingLine, envelope: Float32Array, car: CarDefinition, start: number, speedMps: number, count: number, out: Uint8Array) {
  const { n, ds, mpu } = line;
  let v = Math.max(0, speedMps);
  for (let k = 0; k < count; k++) {
    const i = wrap(start + k, n), step = ds[wrap(i - 1, n)], limit = envelope[i];
    const flat = Math.sqrt(Math.max(0, v * v + 2 * acceleration(car, v, mpu) * step));
    if (flat <= limit) { out[i] = Zone.Accelerate; v = flat; continue; }
    // Deceleration needed to arrive at the limit: more than a lift (drag, rolling, a dab) means braking.
    const needed = (v * v - limit * limit) / (2 * Math.max(step, .01));
    out[i] = needed > resistance(car, v, mpu) + 2.5 ? Zone.Brake : Zone.Lift;
    v = Math.min(v, limit);
  }
}
