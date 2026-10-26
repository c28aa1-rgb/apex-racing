/**
 * Traffic on a city street race. Unlike free-roam traffic (src/city-traffic.ts), it is part of the simulation: a fixed
 * set of cars, placed from the track's own seed and moved once per physics tick from nothing but the race state, so
 * every replay of a run - the ghost, a leaderboard replay, the server's check - meets the same traffic in the same
 * places. Cars keep to lanes either side of the route (right-hand traffic), follow the car ahead, slow for the
 * player, and are knocked out of their lane when hit (sliding to a stop, then rejoining once the player is away).
 */
import type { ObstacleBody } from './obstacle';

/** Traffic models (public/models/traffic/traffic-cars.glb) with their measured bodies, and how often each turns up. */
export const RACE_TRAFFIC_KINDS: (ObstacleBody & { id: string; front: number; rear: number; weight: number })[] = [
  { id: 'ace-11', widthM: 1.826, heightM: 1.292, lengthM: 3.843, front: 2.022, rear: -1.822, massKg: 1500, weight: 1 },
  { id: 'asti-stradale-89', widthM: 1.84, heightM: 1.227, lengthM: 3.905, front: 1.976, rear: -1.929, massKg: 1500, weight: 1 },
  { id: 'fairheaven-lt-80', widthM: 1.832, heightM: 1.187, lengthM: 5.001, front: 2.393, rear: -2.608, massKg: 1500, weight: 1 },
  { id: 'fairheaven-lt-80-taxi', widthM: 1.832, heightM: 1.28, lengthM: 5.075, front: 2.466, rear: -2.608, massKg: 1500, weight: 1 },
  { id: 'lct-3000-07', widthM: 2.433, heightM: 2.645, lengthM: 5.857, front: 2.729, rear: -3.129, massKg: 4200, weight: .45 },
  { id: 'lightbody-90-md-utility', widthM: 2.002, heightM: 1.404, lengthM: 5.372, front: 2.482, rear: -2.891, massKg: 2400, weight: .7 },
  { id: 'milano-95', widthM: 1.93, heightM: 1.299, lengthM: 3.853, front: 1.993, rear: -1.86, massKg: 1500, weight: 1 },
  { id: 'negotiator-80', widthM: 1.875, heightM: 1.215, lengthM: 4.94, front: 2.376, rear: -2.564, massKg: 1500, weight: 1 },
];
export type RaceTrafficKind = typeof RACE_TRAFFIC_KINDS[number];

/** What a street race's traffic is built from: the route (x, y, z, road width, traffic speed per point). */
export type RaceTrafficSpec = { seed: string; route: readonly (readonly number[])[]; closed: boolean; start: { x: number; z: number } };
/** The few things traffic needs from the simulation. */
type Host = {
  car: { translation(): { x: number; y: number; z: number }; linvel(): { x: number; y: number; z: number } };
  setObstacle(id: string, body: ObstacleBody, pose?: { p: { x: number; y: number; z: number }; q: { x: number; y: number; z: number; w: number }; v?: { x: number; y: number; z: number } }): void;
  obstacleState(id: string): { p: { x: number; y: number; z: number }; q: { x: number; y: number; z: number; w: number }; v: { x: number; y: number; z: number }; w: { x: number; y: number; z: number } } | undefined;
};

type Lane = { x: Float64Array; y: Float64Array; z: Float64Array; s: Float64Array; speed: Float64Array; half: Float64Array; length: number; closed: boolean; cars: RaceCar[] };
export type RaceCar = {
  id: number; kind: RaceTrafficKind; lane: Lane; s: number; v: number; temper: number;
  /** Where the car is and which way it faces (yaw about y, pitch up the slope); distance rolled, for the wheels. */
  x: number; y: number; z: number; yaw: number; pitch: number; travel: number; braking: boolean;
  /** Off the road: past the end of an open route, waiting to come back in at its start. */
  parked: boolean; solid: boolean; hint: number;
  wreck?: { vx: number; vz: number; yawRate: number; still: number; offLane: boolean; hitAt: number };
};

const DT = 1 / 60, ACCEL = 1.6, BRAKE = 3.2, HEADWAY = 1.3, STANDSTILL = 2.5;
/** Metres of lane per car, the closest a car is placed to the race start, and the range at which cars are solid. */
const SPACING = 115, CLEAR_OF_START = 70, SOLID_WITHIN = 150, SOLID_UNTIL = 170;
/** A hit changing a car's speed by more than this (m/s) knocks it out of line; it rejoins after WRECK_HOLD seconds. */
const WRECK_HIT = 2.2, WRECK_HOLD = 9;

/** Small seeded generator (mulberry32), from a string seed. */
function generator(seed: string) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = h << 13 | h >>> 19; }
  let a = h >>> 0;
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

export class RaceTraffic {
  readonly cars: RaceCar[] = [];
  private lanes: Lane[] = [];
  private tick = 0;

  constructor(spec: RaceTrafficSpec) {
    const route = spec.route, count = route.length;
    const minHalf = Math.min(...route.map(p => p[3] / 2)), perDirection = Math.min(2, Math.max(1, Math.floor((minHalf - 1) / 4)));
    for (const reverse of [false, true]) for (let lane = 0; lane < perDirection; lane++) {
      const offset = 2.5 + lane * 4, source = reverse ? [...route].reverse() : route;
      const x = new Float64Array(count), y = new Float64Array(count), z = new Float64Array(count), speed = new Float64Array(count), half = new Float64Array(count);
      for (let i = 0; i < count; i++) {
        const prev = source[spec.closed ? (i - 1 + count) % count : Math.max(0, i - 1)], next = source[spec.closed ? (i + 1) % count : Math.min(count - 1, i + 1)];
        const tx = next[0] - prev[0], tz = next[2] - prev[2], l = Math.hypot(tx, tz) || 1;
        x[i] = source[i][0] - tz / l * offset; y[i] = source[i][1]; z[i] = source[i][2] + tx / l * offset; speed[i] = source[i][4]; half[i] = source[i][3] / 2;
      }
      const samples = spec.closed ? count + 1 : count, s = new Float64Array(samples);
      for (let i = 1; i < samples; i++) { const a = (i - 1) % count, b = i % count; s[i] = s[i - 1] + Math.hypot(x[b] - x[a], z[b] - z[a]); }
      this.lanes.push({ x, y, z, s, speed, half, length: s[samples - 1], closed: spec.closed, cars: [] });
    }
    const random = generator(spec.seed), total = RACE_TRAFFIC_KINDS.reduce((sum, kind) => sum + kind.weight, 0);
    const pick = () => { let r = random() * total; for (const kind of RACE_TRAFFIC_KINDS) { r -= kind.weight; if (r <= 0) return kind; } return RACE_TRAFFIC_KINDS[0]; };
    let id = 0;
    for (const lane of this.lanes) {
      const cars = Math.max(1, Math.round(lane.length / SPACING));
      for (let k = 0; k < cars; k++) {
        const s = Math.min(lane.length - 1, Math.max(0, (k + .5) * lane.length / cars + (random() - .5) * 50)), kind = pick(), temper = .85 + random() * .25;
        const car: RaceCar = { id: id++, kind, lane, s, v: 0, temper, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, travel: 0, braking: false, parked: false, solid: false, hint: 0 };
        this.place(car);
        if (Math.hypot(car.x - spec.start.x, car.z - spec.start.z) < CLEAR_OF_START) continue;
        car.v = this.speedAt(lane, s) * temper * .8;
        lane.cars.push(car); this.cars.push(car);
      }
    }
  }

  /** One physics tick, before the world steps: reacts to last tick's contacts, drives every car, poses the solid ones. */
  step(host: Host) {
    this.tick++;
    const p = host.car.translation(), pv = host.car.linvel();
    for (const car of this.cars) if (car.solid && Math.hypot(car.x - p.x, car.z - p.z) < 12) this.knocked(car, host, p);
    for (const lane of this.lanes) lane.cars.sort((a, b) => a.s - b.s || a.id - b.id);
    for (const lane of this.lanes) for (let i = 0; i < lane.cars.length; i++) {
      const car = lane.cars[i];
      if (car.parked) { this.unpark(car, p); continue; }
      if (car.wreck) { this.slide(car, p); continue; }
      this.drive(car, i, p, pv);
    }
    for (const car of this.cars) {
      const near = !car.parked && Math.hypot(car.x - p.x, car.z - p.z) < (car.solid ? SOLID_UNTIL : SOLID_WITHIN);
      if (!near) { if (car.solid) { host.setObstacle(`race-${car.id}`, car.kind, undefined); car.solid = false; } continue; }
      const h = car.kind.heightM, sy = Math.sin(car.yaw / 2), cy = Math.cos(car.yaw / 2), sp = Math.sin(car.pitch / 2), cp = Math.cos(car.pitch / 2);
      const v = car.wreck ? { x: car.wreck.vx, y: 0, z: car.wreck.vz } : { x: Math.sin(car.yaw) * car.v, y: 0, z: Math.cos(car.yaw) * car.v };
      host.setObstacle(`race-${car.id}`, car.kind, { p: { x: car.x, y: car.y + .25 + h * .32, z: car.z }, q: { x: cy * sp, y: sy * cp, z: -sy * sp, w: cy * cp }, v });
      car.solid = true;
    }
  }

  private speedAt(lane: Lane, s: number) { return lane.speed[this.index(lane, s, 0)]; }
  /** Point index at or before distance s along a lane, searched from a hint. */
  private index(lane: Lane, s: number, hint: number) {
    const n = lane.s.length;
    let i = Math.min(Math.max(0, hint), n - 2);
    while (i < n - 2 && lane.s[i + 1] < s) i++;
    while (i > 0 && lane.s[i] > s) i--;
    return i;
  }
  /** Puts the car on its lane at its distance s, facing along it. */
  private place(car: RaceCar) {
    const lane = car.lane, count = lane.x.length, i = car.hint = this.index(lane, car.s, car.hint);
    const a = i % count, b = (i + 1) % count, t = Math.min(1, Math.max(0, (car.s - lane.s[i]) / ((lane.s[i + 1] - lane.s[i]) || 1)));
    car.x = lane.x[a] + (lane.x[b] - lane.x[a]) * t; car.y = lane.y[a] + (lane.y[b] - lane.y[a]) * t; car.z = lane.z[a] + (lane.z[b] - lane.z[a]) * t;
    // Facing: toward a point 3 m on, for smooth turns.
    const ahead = lane.closed ? (car.s + 3) % lane.length : Math.min(lane.length, car.s + 3), j = this.index(lane, ahead, i), c = j % count, d = (j + 1) % count;
    const u = Math.min(1, Math.max(0, (ahead - lane.s[j]) / ((lane.s[j + 1] - lane.s[j]) || 1)));
    const fx = lane.x[c] + (lane.x[d] - lane.x[c]) * u - car.x, fy = lane.y[c] + (lane.y[d] - lane.y[c]) * u - car.y, fz = lane.z[c] + (lane.z[d] - lane.z[c]) * u - car.z;
    if (fx * fx + fz * fz > 1e-4) { car.yaw = Math.atan2(fx, fz); car.pitch = -Math.atan2(fy, Math.hypot(fx, fz)); }
  }

  private drive(car: RaceCar, order: number, p: { x: number; y: number; z: number }, pv: { x: number; y: number; z: number }) {
    const lane = car.lane, v = car.v;
    // Cruise at the road's speed, or the slower speed just ahead (junction curves).
    const cruise = Math.max(4, Math.min(this.speedAt(lane, car.s), this.speedAt(lane, lane.closed ? (car.s + 20 + v * 2) % lane.length : Math.min(lane.length, car.s + 20 + v * 2))) * car.temper);
    let accel = ACCEL * (1 - Math.pow(v / cruise, 4));
    const follow = (gap: number, leaderSpeed: number) => {
      const desired = STANDSTILL + v * HEADWAY + v * (v - leaderSpeed) / (2 * Math.sqrt(ACCEL * BRAKE));
      accel = Math.min(accel, ACCEL * (1 - Math.pow(v / cruise, 4) - Math.pow(Math.max(desired, 0) / Math.max(gap, .1), 2)));
    };
    // The car ahead in the lane (round the loop on a closed route), passing any knocked clear of it.
    const cars = lane.cars;
    for (let k = 1; k < cars.length; k++) {
      const ahead = cars[lane.closed ? (order + k) % cars.length : order + k]; if (!ahead) break;
      if (ahead.parked || ahead.wreck?.offLane) continue;
      const gap = ahead.s - car.s + (ahead.s < car.s ? lane.length : 0) - (car.kind.front - ahead.kind.rear);
      if (gap < 150) follow(gap, ahead.wreck ? 0 : ahead.v);
      break;
    }
    // The player, ahead in this lane.
    const hx = Math.sin(car.yaw), hz = Math.cos(car.yaw), dx = p.x - car.x, dz = p.z - car.z, along = dx * hx + dz * hz, across = Math.abs(dx * hz - dz * hx);
    if (along > 0 && along < 60 && across < car.kind.widthM / 2 + 1.6 && Math.abs(p.y - car.y) < 4) follow(along - car.kind.front - 2.3, Math.max(0, pv.x * hx + pv.z * hz));
    accel = Math.max(accel, -9);
    car.braking = accel < -1 || (v < .5 && accel <= 0);
    car.v = Math.max(0, v + accel * DT);
    car.s += car.v * DT; car.travel += car.v * DT;
    if (lane.closed) { if (car.s >= lane.length) car.s -= lane.length; }
    else if (car.s >= lane.length - .5) { car.parked = true; car.v = 0; return; }
    this.place(car);
  }

  /** A car past the end of an open route comes back in at its start, once the player is well clear of it. */
  private unpark(car: RaceCar, p: { x: number; z: number }) {
    const lane = car.lane;
    if (Math.hypot(lane.x[0] - p.x, lane.z[0] - p.z) < 160) return;
    if (lane.cars.some(other => other !== car && !other.parked && other.s < 30)) return;
    car.parked = false; car.s = 0; car.hint = 0; car.v = this.speedAt(lane, 0) * car.temper * .8; this.place(car);
  }

  /** The player just hit this car: its stand-in moving well off the speed it was given (see CityTraffic.knocked). */
  private knocked(car: RaceCar, host: Host, p: { x: number; z: number }) {
    const hx = Math.sin(car.yaw), hz = Math.cos(car.yaw), dx = p.x - car.x, dz = p.z - car.z;
    if (Math.abs(dx * hx + dz * hz) > car.kind.lengthM / 2 + 3 || Math.abs(dx * hz - dz * hx) > car.kind.widthM / 2 + 2.2) return;
    if (car.wreck && this.tick - car.wreck.hitAt < 18) return;
    const state = host.obstacleState(`race-${car.id}`); if (!state) return;
    const gx = car.wreck ? car.wreck.vx : hx * car.v, gz = car.wreck ? car.wreck.vz : hz * car.v;
    if (Math.hypot(state.v.x - gx, state.v.z - gz) < WRECK_HIT) return;
    const q = state.q, fx = 2 * (q.x * q.z + q.w * q.y), fz = 1 - 2 * (q.x * q.x + q.y * q.y);
    car.x = state.p.x; car.z = state.p.z; car.yaw = Math.atan2(fx, fz); car.v = 0;
    car.wreck = { vx: state.v.x, vz: state.v.z, yawRate: Math.max(-3, Math.min(3, state.w.y)), still: 0, offLane: car.wreck?.offLane ?? false, hitAt: this.tick };
  }
  /** A knocked car skids to a stop and turns with its spin; it stays in its lane's queue where it sits beside it. */
  private slide(car: RaceCar, p: { x: number; z: number }) {
    const wreck = car.wreck!, hx = Math.sin(car.yaw), hz = Math.cos(car.yaw);
    const along = wreck.vx * hx + wreck.vz * hz, sx = wreck.vx - hx * along, sz = wreck.vz - hz * along, side = Math.hypot(sx, sz);
    const slow = (value: number, rate: number) => Math.sign(value) * Math.max(0, Math.abs(value) - rate * DT);
    const a = slow(along, 7), b = slow(side, 10) / (side || 1);
    wreck.vx = hx * a + sx * b; wreck.vz = hz * a + sz * b;
    if (Math.hypot(wreck.vx, wreck.vz) > .05) { car.x += wreck.vx * DT; car.z += wreck.vz * DT; car.travel += a * DT; } else { wreck.vx = wreck.vz = 0; wreck.still += DT; }
    wreck.yawRate *= Math.exp(-DT / .45); car.yaw += wreck.yawRate * DT; car.pitch = 0;
    // Where it sits along its lane (searched near where it was), and how far off it.
    const lane = car.lane, count = lane.x.length; let best = Infinity, bestS = car.s;
    for (let i = Math.max(0, car.hint - 8); i < Math.min(lane.s.length - 1, car.hint + 8); i++) {
      const a0 = i % count, b0 = (i + 1) % count, ex = lane.x[b0] - lane.x[a0], ez = lane.z[b0] - lane.z[a0], l2 = ex * ex + ez * ez || 1;
      const t = Math.min(1, Math.max(0, ((car.x - lane.x[a0]) * ex + (car.z - lane.z[a0]) * ez) / l2)), d = Math.hypot(car.x - lane.x[a0] - ex * t, car.z - lane.z[a0] - ez * t);
      if (d < best) { best = d; bestS = lane.s[i] + (lane.s[i + 1] - lane.s[i]) * t; }
    }
    car.s = bestS; car.hint = this.index(lane, car.s, car.hint);
    wreck.offLane = best > car.kind.widthM / 2 + 1.9;
    car.braking = true;
    if (wreck.still < WRECK_HOLD || Math.hypot(car.x - p.x, car.z - p.z) < 60) return;
    if (lane.cars.some(other => other !== car && !other.parked && Math.abs(other.s - car.s) < car.kind.lengthM + 4)) return;
    car.wreck = undefined; car.v = 0; this.place(car);
  }
}
