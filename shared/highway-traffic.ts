/**
 * Traffic on the Endless Highway. Like a street race's (shared/race-traffic.ts) it lives inside the simulation and is
 * moved once per physics tick from the run's seed and state alone, so a run can be replayed exactly. Unlike it, the
 * road never ends: a fixed pool of cars lives in a window around the player, and a car that falls out of the window
 * behind is placed again in a free gap far ahead (out of sight), so the highway always has traffic.
 *
 * Cars keep right (lanes 0-2 run with the road's s, 3-5 against it), follow the car ahead (IDM), pass slower cars
 * by moving towards the median and drift back right when the lane is clear, slow for the player, and are knocked out
 * of line when hit (sliding to a stop with their hazards on).
 */
import type { ObstacleBody } from './obstacle';
import { RACE_TRAFFIC_KINDS, type RaceTrafficKind } from './race-traffic';
import { forwardLane, laneCentre, LANE_WIDTH, LANES, MEDIAN_HALF, RAIL, pointOn, type HighwayRoad } from './highway';

export type HighwayMode = 'cruise' | 'survival';
/** Cruise traffic, set by the player: cars per km in each direction, and their average speed (35-160 mph in the setup). */
export type HighwayTrafficSettings = { density: number; speedKph: number };
export type HighwayConfig = { seed: number; mode: HighwayMode; traffic: HighwayTrafficSettings };
export const DENSITY_STEPS = [{ label: 'Off', value: 0 }, { label: 'Light', value: 6 }, { label: 'Medium', value: 14 }, { label: 'Heavy', value: 24 }, { label: 'Rush hour', value: 38 }] as const;
export const DEFAULT_HIGHWAY_TRAFFIC: HighwayTrafficSettings = { density: 14, speedKph: 105 };
/** Survival: traffic at the start and after SURVIVAL_RAMP metres, at a fixed speed so every run is scored the same way. */
export const SURVIVAL_START = 9, SURVIVAL_END = 40, SURVIVAL_RAMP = 25000, SURVIVAL_SPEED_KPH = 110;
/** Survival traffic per km per direction after `metres` driven. */
export function survivalDensity(metres: number) {
  const t = Math.min(1, Math.max(0, metres / SURVIVAL_RAMP));
  return SURVIVAL_START + (SURVIVAL_END - SURVIVAL_START) * t * (2 - t);
}

/** The few things traffic needs from the simulation, all in its local (origin-shifted) frame. */
export type TrafficHost = {
  setObstacle(id: string, body: ObstacleBody, pose?: { p: { x: number; y: number; z: number }; q: { x: number; y: number; z: number; w: number }; v?: { x: number; y: number; z: number } }): void;
  obstacleState(id: string): { p: { x: number; y: number; z: number }; q: { x: number; y: number; z: number; w: number }; v: { x: number; y: number; z: number }; w: { x: number; y: number; z: number } } | undefined;
};
/** The player this tick: along the road (s, lat), in world space (absolute), and speed along the road. */
export type TrafficPlayer = { s: number; lat: number; x: number; y: number; z: number; along: number };

export type HighwayCar = {
  id: number; kind: RaceTrafficKind; truck: boolean;
  /** Lane, and while changing lanes the lane being moved into and progress 0-1. */
  lane: number; target: number; change: number;
  /** Distance along the road, lateral offset, speed (m/s, along its own direction) and the speed it wants. */
  s: number; lat: number; v: number; desired: number; temper: number;
  /** World pose (absolute coordinates) for drawing and the physics stand-in; distance rolled, for the wheels. */
  x: number; y: number; z: number; yaw: number; pitch: number; travel: number; braking: boolean;
  /** In the window (false: waiting in the pool). Solid: registered as a physics stand-in. */
  active: boolean; solid: boolean; decided: number;
  wreck?: { vx: number; vz: number; yawRate: number; still: number; offLane: boolean; hitAt: number };
};

const DT = 1 / 60, ACCEL = 1.4, BRAKE = 3.5, HEADWAY = 1.4, STANDSTILL = 3;
/** The window: cars live from BEHIND metres behind the player to AHEAD in front; new ones appear SPAWN_NEAR-AHEAD out. */
const BEHIND = 380, AHEAD = 1500, SPAWN_NEAR = 950, SPAWN_BEHIND = 300;
const SOLID_WITHIN = 150, SOLID_UNTIL = 170;
/** Lane changes take this long (s); a car reconsiders its lane about once a second. */
const CHANGE_TIME = 3.2;
const WRECK_HIT = 2.2, WRECK_HOLD = 9;
/** Taxis and the panel van are rare out here. */
const KIND_WEIGHT: Record<string, number> = { 'fairheaven-lt-80-taxi': .12, 'lct-3000-07': .55, 'lightbody-90-md-utility': .8 };
const TRUCKS = new Set(['lct-3000-07']);

function generator(seed: number) {
  let a = seed >>> 0;
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const smoothstep = (t: number) => t * t * (3 - 2 * t);

export class HighwayTraffic {
  readonly cars: HighwayCar[] = [];
  /** Live for cruise; survival sets it from the distance driven each tick. */
  settings: HighwayTrafficSettings;
  private random: () => number;
  private tick = 0;
  private lanes: HighwayCar[][] = Array.from({ length: LANES * 2 }, () => []);
  private weights: { kind: RaceTrafficKind; weight: number }[];
  private total: number;

  constructor(private road: HighwayRoad, readonly config: HighwayConfig, player: TrafficPlayer) {
    this.random = generator(config.seed ^ 0x5bd1e995);
    this.settings = { ...config.traffic };
    if (config.mode === 'survival') this.settings = { density: survivalDensity(0), speedKph: SURVIVAL_SPEED_KPH };
    this.weights = RACE_TRAFFIC_KINDS.map(kind => ({ kind, weight: KIND_WEIGHT[kind.id] ?? 1 }));
    this.total = this.weights.reduce((sum, w) => sum + w.weight, 0);
    // Fill the window evenly, keeping the player's own lane clear for the first stretch.
    for (const forward of [true, false]) {
      const count = this.target(), span = BEHIND + AHEAD - 200;
      for (let k = 0; k < count; k++) {
        const car = this.make(), offset = -BEHIND + 100 + (k + this.random()) * span / Math.max(1, count);
        if (!this.place(car, forward, player, offset, offset + 1, true)) continue;
        car.v = car.desired * .95;
      }
    }
  }

  /** Cars wanted in each direction: the density over the window's length. */
  private target() { return Math.round(this.settings.density * (BEHIND + AHEAD) / 1000); }

  private make(): HighwayCar {
    let r = this.random() * this.total, kind = this.weights[0].kind;
    for (const w of this.weights) { r -= w.weight; if (r <= 0) { kind = w.kind; break; } }
    const car: HighwayCar = { id: this.cars.length, kind, truck: TRUCKS.has(kind.id), lane: 0, target: 0, change: 0, s: 0, lat: 0, v: 0, desired: 0, temper: .86 + this.random() * .28,
      x: 0, y: 0, z: 0, yaw: 0, pitch: 0, travel: 0, braking: false, active: false, solid: false, decided: Math.floor(this.random() * 60) };
    this.cars.push(car);
    return car;
  }
  private desired(car: HighwayCar) {
    const speed = this.settings.speedKph / 3.6 * car.temper;
    // Trucks hold about 60 mph; with fast traffic set they keep up at least partly, so they are not standing obstacles.
    return car.truck ? Math.min(speed, Math.max(24 + car.temper * 3, speed * .7)) : speed;
  }
  /** Which way along the road the player is going (+1 with s): the window reaches ahead of them. */
  private facing = 1; private reversing = 0;
  /**
   * Puts a car in a free spot `from`-`to` metres ahead of the player (negative: behind) in a lane of the given
   * direction: slow lanes are likelier, trucks never take the fast lane. False if no lane had room.
   */
  private place(car: HighwayCar, forward: boolean, player: TrafficPlayer, from: number, to: number, initial = false) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const pick = this.random(), slot = car.truck ? (pick < .7 ? 2 : 1) : pick < .36 ? 2 : pick < .7 ? 1 : 0;
      const lane = forward ? slot : LANES + slot;
      const s = player.s + this.facing * (from + this.random() * (to - from));
      // Clear of every other car in the lane, and on the first fill clear of the player's lane near the start.
      if (this.cars.some(other => other !== car && other.active && (other.lane === lane || other.target === lane) && Math.abs(other.s - s) < 55)) continue;
      if (initial && Math.abs(laneCentre(lane) - player.lat) < LANE_WIDTH && Math.abs(s - player.s) < 160) continue;
      Object.assign(car, { lane, target: lane, change: 0, s, lat: laneCentre(lane), active: true, wreck: undefined, braking: false });
      car.desired = this.desired(car); car.v = car.desired;
      // Never placed at full speed straight onto a slower car's bumper: start no faster than the car ahead.
      const dir = forwardLane(lane) ? 1 : -1;
      for (const other of this.cars) if (other !== car && other.active && (other.lane === lane || other.target === lane) && (other.s - s) * dir > 0 && (other.s - s) * dir < 160) car.v = Math.min(car.v, other.wreck ? 0 : other.v);
      this.pose(car, 0);
      return true;
    }
    return false;
  }

  /** One physics tick, before the world steps. `origin` is the simulation's floating origin (absolute coordinates). */
  step(host: TrafficHost, player: TrafficPlayer, origin: { x: number; y: number; z: number }, driven: number) {
    this.tick++;
    if (this.config.mode === 'survival') this.settings = { density: survivalDensity(driven), speedKph: SURVIVAL_SPEED_KPH };
    for (const car of this.cars) if (car.active && car.solid && Math.hypot(car.x - player.x, car.z - player.z) < 14) this.knocked(car, host, player, origin);
    // Lane occupancy, sorted along each lane (a car changing lanes is in both).
    for (const lane of this.lanes) lane.length = 0;
    for (const car of this.cars) if (car.active) { this.lanes[car.lane].push(car); if (car.target !== car.lane) this.lanes[car.target].push(car); }
    for (const lane of this.lanes) lane.sort((a, b) => a.s - b.s || a.id - b.id);
    const playerLanes = this.playerLanes(player);
    for (const car of this.cars) {
      if (!car.active) continue;
      if (car.wreck) { this.slide(car, player); continue; }
      this.drive(car, player, playerLanes);
    }
    // The window turns round only once the player has really been driving the other way for two seconds (not a
    // moment rolling backwards after a spin), or it would send every car ahead to the far side and leave the road bare.
    this.reversing = Math.sign(player.along) === -this.facing && Math.abs(player.along) > 8 ? this.reversing + 1 : 0;
    if (this.reversing > 120) { this.facing = -this.facing; this.reversing = 0; }
    this.recycle(player);
    for (const car of this.cars) {
      const near = car.active && Math.hypot(car.x - player.x, car.z - player.z) < (car.solid ? SOLID_UNTIL : SOLID_WITHIN);
      if (!near) { if (car.solid) { host.setObstacle(`highway-${car.id}`, car.kind, undefined); car.solid = false; } continue; }
      const h = car.kind.heightM, sy = Math.sin(car.yaw / 2), cy = Math.cos(car.yaw / 2), sp = Math.sin(car.pitch / 2), cp = Math.cos(car.pitch / 2);
      const v = car.wreck ? { x: car.wreck.vx, y: 0, z: car.wreck.vz } : { x: Math.sin(car.yaw) * car.v, y: 0, z: Math.cos(car.yaw) * car.v };
      host.setObstacle(`highway-${car.id}`, car.kind, { p: { x: car.x - origin.x, y: car.y + .25 + h * .32 - origin.y, z: car.z - origin.z }, q: { x: cy * sp, y: sy * cp, z: -sy * sp, w: cy * cp }, v });
      car.solid = true;
    }
  }

  /** The lanes the player's car overlaps. */
  private playerLanes(player: TrafficPlayer) {
    const lanes: number[] = [];
    for (let lane = 0; lane < LANES * 2; lane++) if (Math.abs(laneCentre(lane) - player.lat) < LANE_WIDTH / 2 + 1.1) lanes.push(lane);
    return lanes;
  }
  /** The nearest car ahead of `car` in a lane (ignoring wrecks knocked clear of it), and the gap to its tail. */
  private leader(car: HighwayCar, lane: number) {
    const list = this.lanes[lane], dir = forwardLane(lane) ? 1 : -1;
    let best: HighwayCar | undefined, gap = Infinity;
    for (const other of list) {
      if (other === car || other.wreck?.offLane) continue;
      const ahead = (other.s - car.s) * dir;
      if (ahead <= 0 || ahead >= gap) continue;
      gap = ahead; best = other;
    }
    return best ? { car: best, gap: gap - (car.kind.front - best.kind.rear), speed: best.wreck ? 0 : best.v } : undefined;
  }
  /** The nearest car behind a point in a lane, and how far behind. */
  private follower(lane: number, s: number, self: HighwayCar) {
    const dir = forwardLane(lane) ? 1 : -1;
    let best: HighwayCar | undefined, gap = Infinity;
    for (const other of this.lanes[lane]) {
      if (other === self) continue;
      const behind = (s - other.s) * dir;
      if (behind < 0 || behind >= gap) continue;
      gap = behind; best = other;
    }
    return best ? { car: best, gap } : undefined;
  }

  private drive(car: HighwayCar, player: TrafficPlayer, playerLanes: number[]) {
    const dir = forwardLane(car.lane) ? 1 : -1, v = car.v;
    car.desired += (this.desired(car) - car.desired) * .01;
    const cruise = Math.max(4, car.desired);
    let accel = ACCEL * (1 - Math.pow(v / cruise, 4));
    const follow = (gap: number, leaderSpeed: number) => {
      const desired = STANDSTILL + v * HEADWAY + v * (v - leaderSpeed) / (2 * Math.sqrt(ACCEL * BRAKE));
      accel = Math.min(accel, ACCEL * (1 - Math.pow(v / cruise, 4) - Math.pow(Math.max(desired, 0) / Math.max(gap, .1), 2)));
    };
    const lanes = car.target !== car.lane ? [car.lane, car.target] : [car.lane];
    let lead: ReturnType<HighwayTraffic['leader']>;
    for (const lane of lanes) { const l = this.leader(car, lane); if (l && l.gap < 220) { follow(l.gap, l.speed); if (!lead || l.gap < lead.gap) lead = l; } }
    // The player, ahead in a lane this car is in.
    const playerAhead = (player.s - car.s) * dir;
    if (playerAhead > 0 && playerAhead < 90 && lanes.some(lane => playerLanes.includes(lane))) follow(playerAhead - car.kind.front - 2.4, Math.max(0, player.along * dir));
    accel = Math.max(accel, -11);
    car.braking = accel < -1 || (v < .5 && accel <= 0);
    car.v = Math.max(0, v + accel * DT);
    // About once a second: pass a slow car on the median side, or move back right when the slow lane is clear.
    if (car.target === car.lane && (this.tick + car.decided) % 60 === 0) this.considerLanes(car, lead, player, playerLanes);
    let latRate = 0;
    if (car.target !== car.lane) {
      const before = car.lat;
      car.change = Math.min(1, car.change + DT / CHANGE_TIME);
      car.lat = laneCentre(car.lane) + (laneCentre(car.target) - laneCentre(car.lane)) * smoothstep(car.change);
      latRate = (car.lat - before) / DT;
      if (car.change >= 1) { car.lane = car.target; car.change = 0; car.lat = laneCentre(car.lane); }
    }
    car.s += dir * car.v * DT; car.travel += car.v * DT;
    this.pose(car, latRate);
  }

  /**
   * Lane choice (a simple MOBIL). A car compares how fast it could go in each lane beside it (its own speed, or the
   * car ahead's if that is close) with its own lane: it moves towards the median for a clear gain, and back to the
   * right whenever the right lane is about as quick, so passing lanes empty again instead of everyone piling into
   * the fast lane. Only into a gap big enough ahead and behind, with the player's car counted as traffic.
   */
  private considerLanes(car: HighwayCar, _lead: ReturnType<HighwayTraffic['leader']>, player: TrafficPlayer, playerLanes: number[]) {
    const group = forwardLane(car.lane) ? 0 : LANES, slot = car.lane - group, dir = group === 0 ? 1 : -1;
    const pace = (lane: number) => { const ahead = this.leader(car, lane); return !ahead || ahead.gap > 110 ? car.desired : Math.min(car.desired, ahead.speed + Math.max(0, ahead.gap - 25) * .04); };
    const here = pace(car.lane), options: number[] = [];
    // Passing: towards the median (never the fast lane for a truck) when it is clearly quicker.
    if (slot > (car.truck ? 1 : 0) && pace(car.lane - 1) > here + 1.5) options.push(slot - 1);
    // Keep right: back towards the slow lane when it is nearly as quick as this one.
    if (slot < LANES - 1 && pace(car.lane + 1) >= here - .6 && this.random() < .6) options.push(slot + 1);
    for (const option of options) {
      const lane = group + option, ahead = this.leader(car, lane), behind = this.follower(lane, car.s, car);
      if (ahead && ahead.gap < Math.max(22, car.v * 1.1) + (ahead.speed < car.v ? (car.v - ahead.speed) * 2 : 0)) continue;
      if (behind && behind.gap < Math.max(16, (behind.car.v - car.v) * 3 + 12)) continue;
      // Never cut in on, or next to, the player.
      if (playerLanes.includes(lane)) { const gap = (player.s - car.s) * dir; if (gap > -25 - Math.max(0, player.along * dir - car.v) * 3 && gap < 35) continue; }
      car.target = lane; car.change = 0;
      return;
    }
  }

  /**
   * Cars out of the window are placed again far ahead of the player (or behind, out of sight, when the player is slower
   * than the traffic and it has pulled away); with more cars than wanted, the extra ones retire to the pool.
   */
  private recycle(player: TrafficPlayer) {
    const wanted = this.target();
    for (const forward of [true, false]) {
      let count = 0;
      for (const car of this.cars) if (car.active && forwardLane(car.lane) === forward) count++;
      for (const car of this.cars) {
        if (!car.active || forwardLane(car.lane) !== forward) continue;
        const ahead = (car.s - player.s) * this.facing;
        if (ahead > -BEHIND && ahead < AHEAD + 150) continue;
        car.active = false; count--;
        if (count >= wanted) continue;
        // Traffic going the player's way that ran away ahead comes back in behind; everything else far ahead.
        const behind = ahead > 0 && forward === this.facing > 0;
        if (behind ? this.place(car, forward, player, -BEHIND + 30, -SPAWN_BEHIND) : this.place(car, forward, player, SPAWN_NEAR, AHEAD)) count++;
      }
      // Too few (more traffic asked for, or a place found no room): bring pooled cars in far ahead, a few per tick.
      for (let added = 0; count < wanted && added < 2; added++) {
        const car = this.cars.find(c => !c.active && !c.solid) ?? this.make();
        if (!this.place(car, forward, player, SPAWN_NEAR, AHEAD)) break;
        count++;
      }
    }
  }

  /** World pose from (s, lat): on the road, facing along its lane, turned a little while changing lanes. */
  private pose(car: HighwayCar, latRate: number) {
    const dir = forwardLane(car.lane) ? 1 : -1, sample = this.road.at(car.s);
    car.x = sample.x - Math.cos(sample.heading) * car.lat; car.z = sample.z + Math.sin(sample.heading) * car.lat;
    car.y = sample.y + sample.bank * car.lat;
    car.yaw = sample.heading + (dir < 0 ? Math.PI : 0) - dir * Math.atan2(latRate, Math.max(2, car.v));
    car.pitch = -Math.atan(sample.grade * dir);
  }

  /** The player just hit this car: its stand-in moving well off the speed it was given (see RaceTraffic.knocked). */
  private knocked(car: HighwayCar, host: TrafficHost, player: TrafficPlayer, origin: { x: number; y: number; z: number }) {
    const hx = Math.sin(car.yaw), hz = Math.cos(car.yaw), dx = player.x - car.x, dz = player.z - car.z;
    if (Math.abs(dx * hx + dz * hz) > car.kind.lengthM / 2 + 3 || Math.abs(dx * hz - dz * hx) > car.kind.widthM / 2 + 2.2) return;
    if (car.wreck && this.tick - car.wreck.hitAt < 18) return;
    const state = host.obstacleState(`highway-${car.id}`); if (!state) return;
    const gx = car.wreck ? car.wreck.vx : hx * car.v, gz = car.wreck ? car.wreck.vz : hz * car.v;
    if (Math.hypot(state.v.x - gx, state.v.z - gz) < WRECK_HIT) return;
    const q = state.q, fx = 2 * (q.x * q.z + q.w * q.y), fz = 1 - 2 * (q.x * q.x + q.y * q.y);
    car.x = state.p.x + origin.x; car.z = state.p.z + origin.z; car.yaw = Math.atan2(fx, fz); car.v = 0; car.target = car.lane; car.change = 0;
    car.wreck = { vx: state.v.x, vz: state.v.z, yawRate: Math.max(-3, Math.min(3, state.w.y)), still: 0, offLane: car.wreck?.offLane ?? false, hitAt: this.tick };
  }
  /** A knocked car skids to a stop and turns with its spin, then (well away from the player) carries on in its lane. */
  private slide(car: HighwayCar, player: TrafficPlayer) {
    const wreck = car.wreck!, hx = Math.sin(car.yaw), hz = Math.cos(car.yaw);
    const along = wreck.vx * hx + wreck.vz * hz, sx = wreck.vx - hx * along, sz = wreck.vz - hz * along, side = Math.hypot(sx, sz);
    const slow = (value: number, rate: number) => Math.sign(value) * Math.max(0, Math.abs(value) - rate * DT);
    const a = slow(along, 7), b = slow(side, 10) / (side || 1);
    wreck.vx = hx * a + sx * b; wreck.vz = hz * a + sz * b;
    if (Math.hypot(wreck.vx, wreck.vz) > .05) { car.x += wreck.vx * DT; car.z += wreck.vz * DT; car.travel += a * DT; } else { wreck.vx = wreck.vz = 0; wreck.still += DT; }
    wreck.yawRate *= Math.exp(-DT / .45); car.yaw += wreck.yawRate * DT; car.pitch = 0;
    const at = this.road.project(car.x, car.z, car.s, 20), sample = this.road.at(at.s);
    // The slide knows nothing of walls: keep it on its own carriageway, between the median and the guardrail.
    const way = forwardLane(car.lane) ? 1 : -1, half = car.kind.widthM / 2 + .15, inner = MEDIAN_HALF + half, outer = RAIL - half;
    const across = way * at.lat, held = Math.min(outer, Math.max(inner, across));
    if (held !== across) {
      const p = pointOn(sample, way * held); car.x = p.x; car.z = p.z;
      // Lose the push into the wall (the across-road part of the slide).
      const rx = -Math.cos(sample.heading), rz = Math.sin(sample.heading), into = wreck.vx * rx + wreck.vz * rz;
      wreck.vx -= rx * into; wreck.vz -= rz * into;
    }
    car.s = at.s; car.lat = way * held; car.y = sample.y + sample.bank * car.lat;
    wreck.offLane = Math.abs(at.lat - laneCentre(car.lane)) > car.kind.widthM / 2 + 1.9;
    car.braking = true;
    if (wreck.still < WRECK_HOLD || Math.hypot(car.x - player.x, car.z - player.z) < 120) return;
    if (this.lanes[car.lane].some(other => other !== car && Math.abs(other.s - car.s) < car.kind.lengthM + 6)) return;
    car.wreck = undefined; car.v = 0; car.lat = laneCentre(car.lane); this.pose(car, 0);
  }
}
