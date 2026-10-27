import * as THREE from 'three';
import type { ObstacleBody } from './obstacle';
import { RACE_TRAFFIC_KINDS } from './race-traffic';

/** Vehicle kinds by number in network records: the same order on every machine, whatever order its models load in. */
const KIND_ORDER = RACE_TRAFFIC_KINDS.map(kind => kind.id);

/**
 * City traffic, the simulation: signalised intersections and AI cars that keep to their lane, follow the car ahead,
 * stop for red lights, take turns at unsignalised crossings, turn at junctions and brake for the players. Shared by
 * the game (src/city-traffic.ts, which draws it and drives it alone in single-player free roam) and the party server,
 * which runs one for a city party so every driver meets the same cars (shared/city-party-traffic.ts).
 *
 * It knows nothing of drawing or physics: the owner says who is driving (`drivers`), whether a point could be in
 * someone's view (`seen`, so cars appear and leave out of sight) and is told when a car is taken away (`onRetire`).
 */

export type RoadPath = { name: string; district: string; width: number; closed: boolean; points: number[][] };
/** A player's car as traffic sees it. */
export type Driver = { position: THREE.Vector3; velocity: THREE.Vector3 };
/** What traffic needs of a vehicle model: its body (for the physics stand-in), length either side of its centre, wheels. */
export type SimKind = { name: string; weight: number; body: ObstacleBody; front: number; rear: number; halfWidth: number; wheelbase: number; radius: number };
export type Signal = { intersection: Intersection; axis: 0 | 1; matrix: THREE.Matrix4; direction: THREE.Vector3 };
/**
 * A signal controller: its centre and the travel direction its axis 0 runs along. Signals are traffic-actuated:
 * `green` is the axis currently given right of way, `stage` and `t` the stage and seconds spent in it, `demand` the
 * cars approaching each axis's stop lines, and `maxGreen` how long each axis may hold green while the other waits.
 */
export type Intersection = { center: THREE.Vector3; axis: THREE.Vector3; green: 0 | 1; stage: 'green' | 'yellow' | 'clear'; t: number; demand: [number, number]; maxGreen: [number, number] };
/** A stop line before a signalised junction; `exit` is where the lane leaves the junction box again. */
type Stop = { s: number; exit: number; intersection: Intersection; axis: 0 | 1 };
type Zone = { center: THREE.Vector3; road?: string; cars: Set<Car>;
  /** A road whose cars have been kept waiting: once it has waited long enough, the road in the crossing stops admitting more. */
  request?: { road: string; since: number } };
/**
 * Where a car can leave its lane for another: at the lane's end onto the road it runs into (every car must take one
 * there; a lane end without any is a dead end), or part-way along onto a side road that starts beside it.
 */
type Link = { at: number; to: Lane; s: number; end: boolean;
  /** For a link into a connector: the road the connector leads to, and where it joins it. */
  final?: { to: Lane; s: number };
  /** A left turn inside a signalised junction gives way to oncoming traffic on these stretches of lane. */
  yieldTo?: { lane: Lane; from: number; to: number }[] };
type ZoneEntry = { zone: Zone; enter: number; leave: number };
export type Lane = {
  road: string; closed: boolean; speed: number; length: number;
  /** Other lanes of the same road in the same direction: where a car can move over to pass a stopped player. */
  siblings: Lane[];
  /** x, y, z per sample, and the distance along the lane at each sample. */
  points: Float32Array; s: Float64Array;
  stops: Stop[]; zones: ZoneEntry[]; cars: Car[];
  /** Metres of lane per car, the number of cars that makes, and the links out of this lane, by distance along it. */
  spacing: number; target: number; links: Link[];
  /** Road width; and whether this is a connector (a curved path through a junction from one road to another). */
  width: number; connector?: boolean;
  /** Lane number counted out from the centre line (0 is the inner lane, where left turns are made). */
  index: number;
  /** During a street race: the stretches of this lane inside the closed-off route (start and end distance). */
  shut?: [number, number][];
};
export type Car = {
  id: number; kind: SimKind; lane: Lane; s: number; v: number; index: number; braking: boolean;
  /** How briskly this driver goes: a share of each road's speed, kept from road to road. */
  temper: number;
  /** Whether the owner has made it solid in a physics world. */
  position: THREE.Vector3; heading: THREE.Vector3; zones: Set<Zone>; obstacle: boolean;
  /** Seconds spent held up by the player; and the sideways offset left over from a lane change, easing to zero. */
  blocked: number; drift: THREE.Vector3;
  /** Wheel roll angle, front-wheel steer angle and last heading (for the turn rate). */
  spin: number; steer: number; yaw: number;
  /** The next link considered and whether the car will take it (decided once, as the car comes up to it); and how long
   * it has waited for room to join. */
  considered?: Link; plan?: Link; joinWait: number;
  /** A stop line the car decided to drive through on yellow: it keeps going when the light then turns red. */
  committed?: Stop;
  /** What held the car back most this step (for tuning). */
  reason?: string;
  /** Rammed by a player: sliding free of its lane to a stop, then waiting with its hazards on (see wrecked()). */
  wreck?: { velocity: THREE.Vector3; yawRate: number; still: number; offLane: boolean; hitAt: number };
  /** City party: when the machine running the traffic last mentioned this car (sim time). */
  seen?: number;
};

/** Signal timing (s): shortest green, longest green for the busier and the quieter axis, yellow, all red. */
const MIN_GREEN = 7, MAX_GREEN = 20, MINOR_GREEN = 12, YELLOW = 3, CLEAR = 2;
/** Cars this close to a stop line (m) count as waiting for, or arriving at, that signal. */
const DEMAND_REACH = 60;
/** Cruising speed (m/s) and metres of lane per car, by district. The Training Link sets the feel (one car per ~135 m
 * of lane); the expressway is busier and much faster, the outer ridge roads quieter. */
const DISTRICT_SPEED: Record<string, number> = { Highway: 29, Outer: 20, Industrial: 15, Commercial: 15, Downtown: 13, Training: 15 };
const DISTRICT_SPACING: Record<string, number> = { Highway: 80, Outer: 190, Industrial: 150, Commercial: 130, Downtown: 140, Training: 135 };
/** Painted lane width (m). */
const LANE_WIDTH = 3.5;
/** Chance a car turns off onto a side road it passes. */
const TURN_OFF = .45;
/** Roads with no traffic: the test straight is the player's own. */
const NO_TRAFFIC = new Set(['Acceleration']);
/** Upper bound on cars across the whole city. */
export const MAX_CARS = 460;
/** A knocked car sits for this long (s) once stopped, then rejoins its lane when no player is watching. */
const WRECK_HOLD = 9;
/** Car-following (intelligent driver model): comfortable acceleration and braking, time headway, standstill gap. */
const ACCEL = 2.2, BRAKE = 3.2, HEADWAY = 1.3, STANDSTILL = 3;

export class TrafficSim {
  readonly lanes: Lane[] = [];
  signals: Signal[] = [];
  readonly cars: Car[] = [];
  private nextId = 0;
  /** Counters for tuning: cars that left at dead ends, cars taken off crowded lanes out of sight, and hits by players. */
  deadEnds = 0; trimmed = 0; wrecks = 0;
  dropped: { from: string; to: string; why: string; turn: string; end: boolean; ahead: number; angle: number }[] = [];
  time = 0;
  private random: () => number;
  private v3 = new THREE.Vector3();
  /** Whether a point could be in a player's view: cars are added and taken away only where it is not. */
  seen: (at: THREE.Vector3) => boolean = () => false;
  /** Told when a car leaves the city (its stand-in or drawing must go too). */
  onRetire?: (car: Car) => void;

  /** Roads from the road map, traffic-light poles (world matrices), the vehicle kinds and a seed. */
  constructor(paths: RoadPath[], poles: number[][], private kinds: SimKind[], seed = 20261022) {
    this.random = mulberry(seed);
    this.buildSignals(poles);
    this.buildLanes(paths);
  }

  /** Advances signals and cars by dt seconds. */
  step(dt: number, drivers: Driver[]) {
    dt = Math.min(dt, .1);
    if (dt <= 0) return;
    this.time += dt;
    this.runSignals(dt);
    for (const lane of this.lanes) lane.cars.sort((a, b) => a.s - b.s);
    for (const car of [...this.cars]) this.drive(car, dt, drivers);
    if (this.spawning) this.rebalance(drivers);
  }

  // ------------------------------------------------------------------ setup
  private buildSignals(poles: number[][]) {
    const found = poles.map(elements => {
      const matrix = new THREE.Matrix4().fromArray(elements);
      // The model's arm reaches over the road from a pole on the right of the traffic it faces: local +x points to
      // that traffic's right, so it travels along (x.z, 0, -x.x), and the lenses face local +z, towards the driver.
      const right = new THREE.Vector3(1, 0, 0).transformDirection(matrix);
      return { matrix, direction: new THREE.Vector3(right.z, 0, -right.x).normalize(), at: new THREE.Vector3().setFromMatrixPosition(matrix) };
    });
    // Poles within 45 m of each other share one controller.
    const owner = found.map((_, i) => i), find = (i: number): number => owner[i] === i ? i : (owner[i] = find(owner[i]));
    found.forEach((a, i) => found.forEach((b, j) => { if (j > i && a.at.distanceTo(b.at) < 45) owner[find(j)] = find(i); }));
    const intersections = new Map<number, Intersection>();
    for (let i = 0; i < found.length; i++) {
      const root = find(i);
      if (!intersections.has(root)) {
        const members = found.filter((_, j) => find(j) === root), center = members.reduce((sum, pole) => sum.add(pole.at), new THREE.Vector3()).divideScalar(members.length);
        intersections.set(root, { center, axis: found[i].direction.clone(), green: this.random() < .5 ? 0 : 1, stage: 'green', t: this.random() * MIN_GREEN, demand: [0, 0], maxGreen: [MAX_GREEN, MAX_GREEN] });
      }
    }
    this.signals = found.map((pole, i) => {
      const intersection = intersections.get(find(i))!;
      return { intersection, axis: Math.abs(pole.direction.dot(intersection.axis)) > .7 ? 0 : 1, matrix: pole.matrix, direction: pole.direction };
    });
  }
  /** The signal controllers, in a fixed order (for sending their state over the network). */
  get junctions() { return this.junctionList ??= [...new Set(this.signals.map(signal => signal.intersection))]; }
  private junctionList?: Intersection[];

  // ------------------------------------------------------------------ network
  /**
   * A car as a short row of numbers, for a city party: id, lane, distance along it (dm), speed (cm/s), kind, flags
   * (1 braking, 2 knocked, 4 knocked clear of its lane), temper (%); a knocked car adds where it is and how it slides:
   * x, z (dm), yaw (mrad), velocity x, z (cm/s), spin (mrad/s), seconds stopped (ds). Lanes are built the same way
   * on every machine from the same road data, so a lane number and a distance place a car exactly.
   */
  record(car: Car): number[] {
    const flags = (car.braking ? 1 : 0) | (car.wreck ? 2 : 0) | (car.wreck?.offLane ? 4 : 0), base = [car.id, this.laneIndex(car.lane), Math.round(car.s * 10), Math.round(car.v * 100), this.kindIndex(car.kind), flags, Math.round(car.temper * 100)];
    const w = car.wreck;
    return w ? [...base, Math.round(car.position.x * 10), Math.round(car.position.z * 10), Math.round(car.yaw * 1000), Math.round(w.velocity.x * 100), Math.round(w.velocity.z * 100), Math.round(w.yawRate * 1000), Math.round(w.still * 10)] : base;
  }
  /**
   * Brings a car into line with a record from the machine running the traffic (adding it if new). `age` is how old
   * the record is (s): the car is moved on by that long at its speed. Small differences are eased out over a few
   * frames; a car found on another lane, or far from where it should be, moves there and its drawing eases across.
   */
  apply(record: number[], age = 0) {
    const [id, laneIndex, s10, v100, kindIndex, flags, temper] = record, lane = this.lanes[laneIndex], kind = this.kinds.find(k => k.name === KIND_ORDER[kindIndex]) ?? this.kinds[0];
    if (!lane) return undefined;
    const v = v100 / 100, target = lane.closed ? (s10 / 10 + v * age) % lane.length : Math.min(lane.length, s10 / 10 + v * age);
    let car = this.byId(id);
    if (!car) {
      const at = new THREE.Vector3(), index = this.sample(lane, target, 0, at);
      car = { id, kind, lane, s: target, v, temper: temper / 100, index, braking: !!(flags & 1), position: at, heading: this.direction(lane, target), zones: new Set(), obstacle: false,
        blocked: 0, drift: new THREE.Vector3(), spin: 0, steer: 0, yaw: 0, joinWait: 0 };
      car.yaw = Math.atan2(car.heading.x, car.heading.z);
      lane.cars.push(car); lane.cars.sort((a, b) => a.s - b.s); this.cars.push(car); this.ids.set(id, car);
      this.nextId = Math.max(this.nextId, id + 1);
    } else {
      car.kind = kind; car.temper = temper / 100; car.braking = !!(flags & 1);
      const gap = car.lane === lane ? (lane.closed ? ((target - car.s + lane.length * 1.5) % lane.length) - lane.length / 2 : target - car.s) : Infinity;
      if (Math.abs(gap) > 6 || car.lane !== lane) {
        // Somewhere else: move there, drawn where it was and easing across.
        const before = car.position.clone();
        if (car.lane !== lane) { car.lane.cars.splice(car.lane.cars.indexOf(car), 1); this.leaveZones(car); lane.cars.push(car); car.lane = lane; car.considered = car.plan = undefined; car.committed = undefined; }
        car.s = target; car.index = this.sample(lane, Math.min(target, lane.length), 0, car.position);
        if (!car.wreck) car.drift.copy(before).sub(car.position).setY(0);
      } else car.s += gap * .35;
      car.v = v;
      // The machine running the traffic decides turns and lights: a car it has past the point where this copy meant
      // to turn off, or past a stop line, carries on (its own record says where it went next).
      if (car.lane === lane) {
        if (car.plan && target > car.plan.at + .5) { car.plan = car.considered = undefined; car.joinWait = 0; }
        const line = lane.stops.find(stop => target + car!.kind.front > stop.s && target - car!.kind.body.lengthM <= stop.exit);
        if (line) car.committed = line;
      }
    }
    car.seen = this.time;
    if (flags & 2) {
      const [, , , , , , , x10, z10, yaw, vx, vz, spin, still] = record;
      car.wreck ??= { velocity: new THREE.Vector3(), yawRate: 0, still: 0, offLane: false, hitAt: this.time };
      car.position.set(x10 / 10, car.position.y, z10 / 10); car.yaw = yaw / 1000; car.heading.set(Math.sin(car.yaw), 0, Math.cos(car.yaw));
      car.wreck.velocity.set(vx / 100, 0, vz / 100); car.wreck.yawRate = spin / 1000; car.wreck.still = still / 10; car.wreck.offLane = !!(flags & 4);
      car.v = 0; car.drift.set(0, 0, 0);
    } else if (car.wreck) car.wreck = undefined;
    return car;
  }
  /** Signal stages as numbers: green axis, stage (0 green, 1 yellow, 2 all red) and seconds in it (ds), per junction. */
  signalRecord() { return this.junctions.flatMap(j => [j.green, j.stage === 'green' ? 0 : j.stage === 'yellow' ? 1 : 2, Math.round(j.t * 10)]); }
  applySignals(record: number[]) {
    this.junctions.forEach((j, i) => { if (record.length < i * 3 + 3) return; j.green = record[i * 3] ? 1 : 0; j.stage = (['green', 'yellow', 'clear'] as const)[record[i * 3 + 1]] ?? 'green'; j.t = record[i * 3 + 2] / 10; });
  }
  /** Cars not heard of since `before` (out of range of the machine running the traffic) are taken away. */
  forget(before: number) { for (const car of [...this.cars]) if ((car.seen ?? -Infinity) < before) this.retire(car); }
  byId(id: number) {
    if (this.ids.size !== this.cars.length) { this.ids.clear(); for (const car of this.cars) this.ids.set(car.id, car); }
    return this.ids.get(id);
  }
  private ids = new Map<number, Car>();
  private laneIndices?: Map<Lane, number>;
  private laneIndex(lane: Lane) { return (this.laneIndices ??= new Map(this.lanes.map((l, i) => [l, i]))).get(lane) ?? 0; }
  private kindIndex(kind: SimKind) { return Math.max(0, KIND_ORDER.indexOf(kind.name)); }
  /** Whether cars may be added and taken away to keep each lane near its density (off while another machine runs them). */
  spawning = true;

  private buildLanes(paths: RoadPath[]) {
    for (const path of paths) {
      if (NO_TRAFFIC.has(path.name)) continue;
      // The painted layout (measured from the city's lane paint, work/lane-paint.ts): an amber centre line, white lane
      // lines every LANE_WIDTH, and an edge line half a metre in from the road's edge. So 16-20 m roads have two
      // lanes each way and 22-28 m roads three; any width left over beyond the last lane is shoulder.
      const half = path.width / 2, perDirection = Math.max(1, Math.floor((half - .5) / LANE_WIDTH + 1e-6));
      for (const reverse of [false, true]) {
        const source = reverse ? [...path.points].reverse() : path.points, group: Lane[] = [];
        for (let lane = 0; lane < perDirection; lane++) {
          // Drive on the right: each lane's centre, counted out from the centre line. The outer lane runs from the last
          // dashed line to the edge line, wider than the rest on some roads: its cars keep to the middle of it.
          const edge = half - .5, offset = lane < perDirection - 1 ? (lane + .5) * LANE_WIDTH : (lane * LANE_WIDTH + edge) / 2;
          const count = source.length, points = new Float32Array(count * 3);
          for (let i = 0; i < count; i++) {
            const previous = source[path.closed ? (i - 1 + count) % count : Math.max(0, i - 1)], next = source[path.closed ? (i + 1) % count : Math.min(count - 1, i + 1)];
            const tx = next[0] - previous[0], tz = next[2] - previous[2], l = Math.hypot(tx, tz) || 1;
            points[i * 3] = source[i][0] - tz / l * offset; points[i * 3 + 1] = source[i][1]; points[i * 3 + 2] = source[i][2] + tx / l * offset;
          }
          const samples = path.closed ? count + 1 : count, s = new Float64Array(samples);
          for (let i = 1; i < samples; i++) { const a = (i - 1) % count, b = i % count; s[i] = s[i - 1] + Math.hypot(points[b * 3] - points[a * 3], points[b * 3 + 1] - points[a * 3 + 1], points[b * 3 + 2] - points[a * 3 + 2]); }
          // District spacing is per lane of a two-lane direction: more lanes share the same cars per metre of road.
          const spacing = (DISTRICT_SPACING[path.district] ?? 140) * perDirection / 2;
          const built: Lane = { road: path.name, closed: path.closed, speed: DISTRICT_SPEED[path.district] ?? 15, length: s[samples - 1], siblings: group, points, s, stops: [], zones: [], cars: [],
            spacing, target: Math.max(1, Math.round(s[samples - 1] / spacing)), links: [], width: path.width, index: lane };
          group.push(built); this.lanes.push(built);
        }
      }
    }
    this.buildStops();
    this.buildZones();
    this.buildLinks();
  }

  /**
   * Stop lines. Each signalised junction is a box: a circle as wide as its widest crossing road plus a crosswalk.
   * Every lane that drives into the box gets a stop line just before it (lanes that start inside it are leaving and
   * need none; lanes that end before it stop at their end). The signal phase follows the lane's direction of travel:
   * the junction's axis 0, or the cross axis. (The poles stand on the far side of the junction, so their positions
   * cannot be used for the line itself.)
   */
  private buildStops() {
    const at = new THREE.Vector3();
    for (const intersection of new Set(this.signals.map(signal => signal.intersection))) {
      const near = this.lanes.filter(lane => this.nearest(lane, intersection.center).distance < 30);
      for (const lane of near) {
        const crossing = Math.max(0, ...near.filter(other => other.road !== lane.road).map(other => other.width / 2));
        if (!crossing) continue;
        const radius = crossing + 3.5, middle = this.nearest(lane, intersection.center).s;
        // Walk the lane from 70 m before the point nearest the centre to 70 m after it (round a loop if need be).
        const wrap = (value: number) => lane.closed ? ((value % lane.length) + lane.length) % lane.length : THREE.MathUtils.clamp(value, 0, lane.length);
        const inside = (value: number) => { this.sample(lane, wrap(value), 0, at); return Math.hypot(at.x - intersection.center.x, at.z - intersection.center.z) < radius; };
        let enter: number | undefined, exit: number | undefined;
        for (let d = -70; d <= 70; d += 1) {
          const here = middle + d;
          if (!lane.closed && (here < 0 || here > lane.length)) continue;
          if (inside(here)) { enter ??= here; } else if (enter !== undefined) { exit = here; break; }
        }
        // Lanes that start inside the box are leaving the junction; lanes that never reach it end before it.
        if (enter !== undefined && !lane.closed && enter <= 1) continue;
        if (enter === undefined && (lane.closed || middle < lane.length - 1)) continue;
        const s = enter !== undefined ? wrap(Math.max(lane.closed ? enter - 1 : 1, enter - 1)) : lane.length - 1;
        const leave = exit !== undefined ? wrap(exit) : lane.length;
        const stopAt = s;
        const direction = this.direction(lane, Math.min(lane.length, stopAt + 2));
        lane.stops.push({ s: stopAt, exit: leave < stopAt ? leave + lane.length : leave, intersection, axis: Math.abs(direction.dot(intersection.axis)) > .7 ? 0 : 1 });
      }
    }
    for (const lane of this.lanes) lane.stops.sort((a, b) => a.s - b.s);
    // The axis with more lanes stopping at a junction is the main road: it may hold green longer.
    for (const junction of new Set(this.signals.map(signal => signal.intersection))) {
      const lanes = [0, 1].map(axis => this.lanes.filter(lane => lane.stops.some(stop => stop.intersection === junction && stop.axis === axis)).length);
      junction.maxGreen = lanes[0] >= lanes[1] ? [MAX_GREEN, MINOR_GREEN] : [MINOR_GREEN, MAX_GREEN];
    }
  }

  /**
   * Links between roads. A lane that ends where it runs into another road joins that road's lane going a compatible
   * way (not a U-turn onto its own road). A lane that starts beside another road can be turned into from it.
   */
  private buildLinks() {
    const end = new THREE.Vector3(), start = new THREE.Vector3();
    for (const lane of this.lanes) {
      if (lane.closed) continue;
      this.sample(lane, lane.length, lane.s.length - 2, end);
      const heading = this.direction(lane, lane.length - 2);
      for (const to of this.lanes) {
        if (to.road === lane.road) continue;
        const near = this.nearest(to, end);
        if (near.distance > 18 || (!to.closed && near.s > to.length - 40)) continue;
        if (this.direction(to, near.s).dot(heading) < -.35) continue;
        this.sample(to, near.s, 0, start); if (Math.abs(start.y - end.y) > 4) continue;
        // Join the road beyond its junction box, never inside it or before its own stop line: cars there queue at
        // that road's red light, which would block the turn on exactly the phase it is allowed to go.
        const box = to.stops.find(stop => near.s >= stop.s - 8 && near.s <= stop.exit + 4);
        // A turn starts before the road it turns onto (after this lane's own stop line) and joins it past the far
        // edge of this road (past its junction box when it has signals), so the path sweeps through the junction.
        const past = box ? box.exit + 3 : near.s + lane.width / 2 + 3;
        const join = to.closed ? past % to.length : Math.min(to.length - 1, past);
        const myStop = lane.stops.find(stop => stop.s > lane.length - 40);
        const at = Math.max(myStop ? myStop.s + 1 : 0, lane.length - (to.width / 2 + 3));
        lane.links.push({ at, to, s: join, end: true });
      }
      // A true dead end: turn round into this road's nearest lane going back the other way, which starts here.
      if (!lane.links.length) {
        const back = this.lanes.filter(to => to.road === lane.road && !lane.siblings.includes(to))
          .map(to => { this.sample(to, 0, 0, start); return { to, gap: start.distanceTo(end) }; }).sort((a, b) => a.gap - b.gap)[0];
        if (back && back.gap < 20) lane.links.push({ at: lane.length, to: back.to, s: 0, end: true });
      }
      // Side roads that start beside this lane, as optional turn-offs.
      this.sample(lane, 0, 0, start);
      const away = this.direction(lane, 2);
      for (const from of this.lanes) {
        if (from.road === lane.road) continue;
        const near = this.nearest(from, start);
        if (near.distance > 18 || near.s < 30 || (!from.closed && near.s > from.length - 30)) continue;
        if (this.direction(from, near.s).dot(away) < -.35) continue;
        // Turning off starts before the side road (after a stop line there) and joins it past this road's edge.
        const stop = from.stops.find(st => st.s < near.s && st.s > near.s - 40);
        const at = Math.min(near.s, Math.max(stop ? stop.s + 1 : 0, near.s - (lane.width / 2 + 3)));
        from.links.push({ at, to: lane, s: Math.min(lane.length - 1, from.width / 2 + 3), end: false });
      }
    }
    // A car must never arrive on a road past that road's own ways on: joining points sit before its last one.
    const lastWay = (lane: Lane) => Math.max(-Infinity, ...lane.links.filter(link => link.end).map(link => link.at));
    for (const lane of this.lanes) for (const link of lane.links) if (!link.to.closed && link.to.links.some(l => l.end)) link.s = Math.max(0, Math.min(link.s, lastWay(link.to) - 8));
    for (const lane of this.lanes) lane.links = this.realistic(lane);
    for (const lane of [...this.lanes]) for (const link of lane.links) this.connect(lane, link);
    for (const lane of this.lanes) lane.links.sort((a, b) => a.at - b.at);
  }

  /**
   * Keeps the links a driver would really take. Turns bend at most 120 degrees and end ahead of where they start
   * (no U-turns in a junction; the one exception is the turn-round at a true dead end, onto the same road). On a road
   * with two lanes each way, left turns are made from and into the inner lane and right turns from and into the
   * outer one, so a car waiting to turn left does not hold up traffic going straight on. A lane end always keeps at
   * least one way on.
   */
  private realistic(lane: Lane) {
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    const kinds = lane.links.map(link => {
      if (link.to.road === lane.road) return { link, keep: true };
      const ta = this.direction(lane, Math.max(0, link.at - 1)), tb = this.direction(link.to, link.s + 1);
      this.sample(lane, link.at, 0, a); this.sample(link.to, link.s, 0, b);
      const angle = Math.acos(THREE.MathUtils.clamp(ta.dot(tb), -1, 1)), ahead = (b.x - a.x) * ta.x + (b.z - a.z) * ta.z;
      const side = tb.x * ta.z - tb.z * ta.x, turn = side > .3 ? 'left' : side < -.3 ? 'right' : 'straight';
      const inner = (l: Lane) => l.index === 0, outer = (l: Lane) => l.index === Math.max(...l.siblings.map(x => x.index));
      let keep = angle < THREE.MathUtils.degToRad(120) && ahead > 2, why = angle >= THREE.MathUtils.degToRad(120) ? 'angle' : ahead <= 2 ? 'behind' : '';
      if (keep && turn === 'left') { keep = (lane.siblings.length < 2 || inner(lane)) && (link.to.siblings.length < 2 || inner(link.to)); if (!keep) why = 'lane'; }
      if (keep && turn === 'right') { keep = (lane.siblings.length < 2 || outer(lane)) && (link.to.siblings.length < 2 || outer(link.to)); if (!keep) why = 'lane'; }
      if (why) this.dropped.push({ from: lane.road, to: link.to.road, why, turn, end: link.end, ahead: Math.round(ahead), angle: Math.round(THREE.MathUtils.radToDeg(angle)) });
      return { link, keep, angle };
    });
    const kept = kinds.filter(k => k.keep).map(k => k.link);
    // Never strand a lane end: if every way on was filtered out, keep the gentlest forward one.
    if (!lane.closed && !kept.some(link => link.end)) {
      const best = kinds.filter(k => k.link.end && 'angle' in k).sort((x, y) => (x.angle ?? 9) - (y.angle ?? 9))[0];
      if (best) kept.push(best.link);
    }
    return kept;
  }

  /**
   * Gives a link a curved path through the junction: a cubic curve leaving the lane along its heading and arriving
   * on the new road along that road's heading. Cars drive it at a turning speed (slower the sharper the turn) and
   * join the road at its end, so a turn is driven instead of slid across.
   */
  private connect(from: Lane, link: Link) {
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    this.sample(from, link.at, 0, a); this.sample(link.to, link.s, 0, b);
    const distance = a.distanceTo(b);
    if (distance < 3) return;
    const ta = this.direction(from, Math.max(0, link.at - 1)), tb = this.direction(link.to, link.s + 1);
    const c1 = a.clone().addScaledVector(ta, distance * .45), c2 = b.clone().addScaledVector(tb, -distance * .45);
    const count = Math.max(4, Math.ceil(distance / 1.5)), points = new Float32Array((count + 1) * 3), s = new Float64Array(count + 1), p = new THREE.Vector3(), last = new THREE.Vector3();
    for (let i = 0; i <= count; i++) {
      const t = i / count, u = 1 - t;
      p.set(0, 0, 0).addScaledVector(a, u * u * u).addScaledVector(c1, 3 * u * u * t).addScaledVector(c2, 3 * u * t * t).addScaledVector(b, t * t * t);
      points.set([p.x, p.y, p.z], i * 3);
      if (i) s[i] = s[i - 1] + p.distanceTo(last);
      last.copy(p);
    }
    const angle = Math.acos(THREE.MathUtils.clamp(ta.dot(tb), -1, 1));
    // A left turn (the car's right is -x when it faces +z, so its left is (z, 0, -x)) made inside a signalised junction
    // crosses the oncoming lanes of the same phase: it waits for them to be clear from 45 m out to the junction's far side.
    const leftTurn = tb.x * ta.z - tb.z * ta.x > .3, box = from.stops.find(stop => link.at >= stop.s - 2 && link.at <= stop.exit + 2);
    if (leftTurn && box) {
      link.yieldTo = this.lanes.filter(lane => !lane.connector && lane.road === from.road && !from.siblings.includes(lane))
        .flatMap(lane => lane.stops.filter(stop => stop.intersection === box.intersection).map(stop => ({ lane, from: stop.s - 45, to: stop.exit })));
    }
    const connector: Lane = { road: `${from.road}>${link.to.road}`, closed: false, speed: Math.max(5, Math.min(from.speed, link.to.speed) * (1 - angle / Math.PI * .65)),
      length: s[count], siblings: [], points, s, stops: [], zones: [], cars: [], spacing: Infinity, target: 0, width: 0, connector: true, index: 0,
      links: [{ at: s[count], to: link.to, s: link.s, end: true }] };
    connector.siblings.push(connector);
    this.lanes.push(connector);
    link.final = { to: link.to, s: link.s };
    link.to = connector; link.s = 0;
  }

  /** Where lanes of different roads cross away from a signal, cars take turns: one road at a time in the crossing. */
  private buildZones() {
    type Hit = { lane: Lane; s: number; at: THREE.Vector3 };
    const cell = 12, grid = new Map<string, [Lane, number][]>(), hits: Hit[][] = [];
    const segments = (lane: Lane) => lane.s.length - 1, at = (lane: Lane, i: number) => (i % (lane.points.length / 3)) * 3;
    for (const lane of this.lanes) for (let i = 0; i < segments(lane); i++) {
      const a = at(lane, i), b = at(lane, i + 1), x0 = Math.floor(Math.min(lane.points[a], lane.points[b]) / cell), x1 = Math.floor(Math.max(lane.points[a], lane.points[b]) / cell);
      const z0 = Math.floor(Math.min(lane.points[a + 2], lane.points[b + 2]) / cell), z1 = Math.floor(Math.max(lane.points[a + 2], lane.points[b + 2]) / cell);
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) { const key = `${x},${z}`; (grid.get(key) ?? grid.set(key, []).get(key)!).push([lane, i]); }
    }
    const seen = new Set<string>();
    for (const list of grid.values()) for (let m = 0; m < list.length; m++) for (let n = m + 1; n < list.length; n++) {
      const [la, i] = list[m], [lb, j] = list[n];
      if (la.road === lb.road) continue;
      const key = `${this.lanes.indexOf(la)}:${i}:${this.lanes.indexOf(lb)}:${j}`; if (seen.has(key)) continue; seen.add(key);
      const a = at(la, i), b = at(la, i + 1), c = at(lb, j), d = at(lb, j + 1);
      const p = la.points, q = lb.points, rx = p[b] - p[a], rz = p[b + 2] - p[a + 2], sx = q[d] - q[c], sz = q[d + 2] - q[c + 2];
      const denominator = rx * sz - rz * sx; if (Math.abs(denominator) < 1e-6) continue;
      const t = ((q[c] - p[a]) * sz - (q[c + 2] - p[a + 2]) * sx) / denominator, u = ((q[c] - p[a]) * rz - (q[c + 2] - p[a + 2]) * rx) / denominator;
      if (t < 0 || t > 1 || u < 0 || u > 1) continue;
      // Grade-separated crossings (the expressway over a street) are not conflicts.
      if (Math.abs((p[a + 1] + (p[b + 1] - p[a + 1]) * t) - (q[c + 1] + (q[d + 1] - q[c + 1]) * u)) > 3) continue;
      const point = new THREE.Vector3(p[a] + rx * t, p[a + 1], p[a + 2] + rz * t);
      hits.push([{ lane: la, s: la.s[i] + (la.s[i + 1] - la.s[i]) * t, at: point }, { lane: lb, s: lb.s[j] + (lb.s[j + 1] - lb.s[j]) * u, at: point }]);
    }
    // Crossings within 25 m form one zone; zones next to a signal are left to the signal.
    const zones: Zone[] = [];
    for (const pair of hits) {
      if (this.signals.some(signal => signal.intersection.center.distanceTo(pair[0].at) < 50)) continue;
      // Where a road starts or ends at another, cars merge (see links) instead of taking turns: a car queuing to merge
      // inside a crossing would hold it forever.
      if (pair.some(hit => !hit.lane.closed && (hit.s < 30 || hit.s > hit.lane.length - 30))) continue;
      let zone = zones.find(z => z.center.distanceTo(pair[0].at) < 25);
      if (!zone) { zone = { center: pair[0].at.clone(), cars: new Set() }; zones.push(zone); }
      for (const hit of pair) {
        const entry = hit.lane.zones.find(e => e.zone === zone);
        if (entry) { entry.enter = Math.min(entry.enter, hit.s - 5); entry.leave = Math.max(entry.leave, hit.s + 5); }
        else hit.lane.zones.push({ zone, enter: hit.s - 5, leave: hit.s + 5 });
      }
    }
    for (const lane of this.lanes) lane.zones.sort((a, b) => a.enter - b.enter);
  }

  // ------------------------------------------------------------------ lanes
  /** Point and travel direction along a lane at distance s. */
  sample(lane: Lane, s: number, hint: number, out: THREE.Vector3) {
    const count = lane.points.length / 3;
    let i = Math.min(Math.max(0, hint), lane.s.length - 2);
    while (i < lane.s.length - 2 && lane.s[i + 1] < s) i++;
    while (i > 0 && lane.s[i] > s) i--;
    const a = (i % count) * 3, b = ((i + 1) % count) * 3, t = THREE.MathUtils.clamp((s - lane.s[i]) / ((lane.s[i + 1] - lane.s[i]) || 1), 0, 1), p = lane.points;
    out.set(p[a] + (p[b] - p[a]) * t, p[a + 1] + (p[b + 1] - p[a + 1]) * t, p[a + 2] + (p[b + 2] - p[a + 2]) * t);
    return i;
  }
  direction(lane: Lane, s: number) {
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    this.sample(lane, Math.max(0, s - 2), 0, a); this.sample(lane, Math.min(lane.length, s + 2), 0, b);
    return b.sub(a).setY(0).normalize();
  }
  nearest(lane: Lane, point: THREE.Vector3) {
    let best = { distance: Infinity, s: 0 };
    const p = lane.points, count = p.length / 3;
    for (let i = 0; i < lane.s.length - 1; i++) {
      const a = (i % count) * 3, b = ((i + 1) % count) * 3, dx = p[b] - p[a], dz = p[b + 2] - p[a + 2], l2 = dx * dx + dz * dz || 1;
      const t = THREE.MathUtils.clamp(((point.x - p[a]) * dx + (point.z - p[a + 2]) * dz) / l2, 0, 1);
      const distance = Math.hypot(point.x - p[a] - dx * t, point.z - p[a + 2] - dz * t);
      if (distance < best.distance) best = { distance, s: lane.s[i] + (lane.s[i + 1] - lane.s[i]) * t };
    }
    return best;
  }

  /** Fills every lane to its density, evenly spaced with a little jitter, keeping clear of the drivers. */
  populate(drivers: Driver[]) {
    for (const lane of this.lanes) {
      if (lane.connector) continue;
      const step = lane.length / lane.target;
      for (let k = 0; k < lane.target && this.cars.length < MAX_CARS; k++)
        for (const shift of [.5, .2, .8, .05, .95]) if (this.place(lane, (k + shift) * step, drivers, 25)) break;
    }
  }
  /** Puts a new car on a lane at distance s if the spot is clear (of cars, stop lines, crossings and the player). */
  private place(lane: Lane, s: number, drivers: Driver[], clearOfDrivers: number, hidden = false): Car | undefined {
    if (!lane.closed && lane.links.some(link => link.end) && s > Math.max(...lane.links.filter(link => link.end).map(link => link.at)) - 5) return undefined;
    if (lane.cars.some(other => Math.abs(other.s - s) < 18) || lane.stops.some(stop => Math.abs(stop.s - s) < 12) || lane.zones.some(zone => s > zone.enter - 4 && s < zone.leave)) return undefined;
    if (lane.shut?.some(([from, to]) => s > from - 30 && s < to + 5)) return undefined;
    const at = new THREE.Vector3(), index = this.sample(lane, s, 0, at);
    if (drivers.some(driver => at.distanceTo(driver.position) < clearOfDrivers)) return undefined;
    if (hidden && this.seen(at)) return undefined;
    const car: Car = { id: this.nextId++, kind: this.pickKind(), lane, s, v: lane.speed * .7, temper: .85 + this.random() * .25,
      index, braking: false, position: at, heading: this.direction(lane, s), zones: new Set(), obstacle: false, blocked: 0, drift: new THREE.Vector3(),
      spin: 0, steer: 0, yaw: 0, joinWait: 0 };
    car.yaw = Math.atan2(car.heading.x, car.heading.z);
    lane.cars.push(car); lane.cars.sort((a, b) => a.s - b.s); this.cars.push(car);
    return car;
  }
  /**
   * Keeps each lane near its density without anything popping in or out where the player can see: a lane well over
   * its share (cars pile up on loops fed by side roads) loses a car out of sight, and the emptiest lane gains one, out
   * of sight and away from the player.
   */
  private rebalance(drivers: Driver[]) {
    const crowded = this.lanes.find(lane => !lane.connector && lane.cars.length > lane.target * 1.1 + 1);
    if (crowded) {
      const car = crowded.cars.find(c => !this.seen(c.position) && !drivers.some(driver => c.position.distanceTo(driver.position) < 200) && !c.zones.size);
      if (car) { this.retire(car); this.trimmed++; }
    }
    // Up to three of the emptiest lanes gain a car each frame.
    const short = this.lanes.filter(lane => !lane.connector && lane.cars.length < lane.target * .9).sort((a, b) => a.cars.length / a.target - b.cars.length / b.target);
    let added = 0;
    for (const lane of short) {
      if (added >= 3 || this.cars.length >= MAX_CARS) break;
      for (let attempt = 0; attempt < 8; attempt++) if (this.place(lane, this.random() * lane.length, drivers, 160, true)) { added++; break; }
    }
  }

  /** Takes a car out of the city (its owner releases whatever it drew or made solid for it). */
  retire(car: Car) {
    this.remove(car); this.onRetire?.(car); this.ids.delete(car.id);
    this.cars.splice(this.cars.indexOf(car), 1);
  }
  private pickKind() {
    const total = this.kinds.reduce((sum, kind) => sum + kind.weight, 0);
    let pick = this.random() * total;
    for (const kind of this.kinds) { pick -= kind.weight; if (pick <= 0) return kind; }
    return this.kinds[0];
  }
  private remove(car: Car) {
    car.lane.cars.splice(car.lane.cars.indexOf(car), 1);
    this.leaveZones(car);
  }
  private leaveZones(car: Car) {
    for (const zone of car.zones) { zone.cars.delete(car); if (!zone.cars.size) zone.road = undefined; }
    car.zones.clear();
  }
  /** Moves a car onto a linked lane, drawn where it was and easing across to the new line. */
  private follow(car: Car, link: Link) {
    const before = car.position.clone();
    car.lane.cars.splice(car.lane.cars.indexOf(car), 1); this.leaveZones(car);
    car.lane = link.to; car.s = link.s; car.considered = car.plan = undefined; car.joinWait = 0;
    // A car crossing a junction stays committed along the connector, and is done once it is on its new road.
    if (!link.to.connector) car.committed = undefined;
    link.to.cars.push(car); link.to.cars.sort((a, b) => a.s - b.s);
    car.index = this.sample(link.to, car.s, 0, car.position);
    car.drift.copy(before).sub(car.position).setY(0);
  }
  /** Whether a linked lane has room at the joining point. */
  /**
   * Whether a car may take a link now: the road it ends up on has a gap (no car within ~3 s upstream of the joining
   * point or just past it), and a connector has room at its start.
   */
  private clear(link: Link) {
    // Upstream cars matter only if they will reach the joining point within ~3 s at their current speed (a queue
    // stopped at a red light behind it will not), or are already right at it.
    const target = link.final ?? link;
    if (target.to.cars.some(other => other.s < target.s + 10 && other.s > target.s - Math.max(10, other.v * 3))) return false;
    if (link.yieldTo?.some(stretch => stretch.lane.cars.some(other => other.v > 1 && other.s > stretch.from && other.s < stretch.to))) return false;
    return !link.final || !link.to.cars.some(other => other.s < 9);
  }

  // ------------------------------------------------------------------ signals
  /** 0 green, 1 yellow, 2 red, for one signal at the current time. */
  state(signal: { intersection: Intersection; axis: 0 | 1 }) {
    const junction = signal.intersection, mine = junction.green === signal.axis;
    return junction.stage === 'green' ? (mine ? 0 : 2) : junction.stage === 'yellow' ? (mine ? 1 : 2) : 2;
  }
  /** Seconds, at the soonest, before the cross street gets green (what a car needs to be out of the box by). */
  private timeToCrossGreen(signal: { intersection: Intersection; axis: 0 | 1 }) {
    const junction = signal.intersection;
    if (junction.stage === 'clear') return Math.max(0, CLEAR - junction.t);
    if (junction.stage === 'yellow') return Math.max(0, YELLOW - junction.t) + CLEAR;
    // On green a car goes: yellow and all-red (5 s) are there to see it through the box.
    return junction.green === signal.axis ? Infinity : 0;
  }
  /**
   * Traffic-actuated signals: green stays with an axis while its cars keep coming, and passes to the other axis when
   * cars wait there and either this axis has gone quiet or it has had its longest green. Busier axes (more lanes
   * stopping at the junction) may hold green longer.
   */
  private runSignals(dt: number) {
    const junctions = new Set(this.signals.map(signal => signal.intersection));
    for (const junction of junctions) junction.demand = [0, 0];
    for (const car of this.cars) {
      for (const stop of car.lane.stops) {
        const distance = stop.s - car.s;
        if (distance < -2 || distance > DEMAND_REACH) continue;
        stop.intersection.demand[stop.axis]++; break;
      }
    }
    for (const junction of junctions) {
      junction.t += dt;
      const other = junction.green === 0 ? 1 : 0;
      if (junction.stage === 'green') {
        const waiting = junction.demand[other] > 0, quiet = junction.demand[junction.green] === 0;
        if (junction.t >= MIN_GREEN && waiting && (quiet || junction.t >= junction.maxGreen[junction.green])) { junction.stage = 'yellow'; junction.t = 0; }
      } else if (junction.stage === 'yellow' && junction.t >= YELLOW) { junction.stage = 'clear'; junction.t = 0; }
      else if (junction.stage === 'clear' && junction.t >= CLEAR) { junction.stage = 'green'; junction.green = other; junction.t = 0; }
    }
  }

  // ------------------------------------------------------------------ driving
  private drive(car: Car, dt: number, drivers: Driver[]) {
    if (car.wreck) { this.wrecked(car, dt, drivers); return; }
    const lane = car.lane, v = car.v;
    // Out of the junction box (or onto another road): no longer committed to it.
    if (car.committed && !lane.connector && (!lane.stops.includes(car.committed) || car.s - car.kind.body.lengthM > car.committed.exit)) car.committed = undefined;
    const cruise = lane.speed * car.temper;
    let accel = ACCEL * (1 - Math.pow(v / cruise, 4));
    let reason = 'free';
    const follow = (gap: number, leaderSpeed: number, standstill = STANDSTILL, why = 'car ahead') => {
      const desired = standstill + v * HEADWAY + v * (v - leaderSpeed) / (2 * Math.sqrt(ACCEL * BRAKE));
      const next = ACCEL * (1 - Math.pow(v / cruise, 4) - Math.pow(Math.max(desired, 0) / Math.max(gap, .1), 2));
      if (next < accel) { accel = next; reason = why; }
    };
    // The car ahead in this lane (round a loop, the first car is behind the last one).
    // A knocked car pushed clear of the lane is passed, not queued behind.
    const index = lane.cars.indexOf(car);
    let ahead: Car | undefined = lane.cars[index + 1] ?? (lane.closed && lane.cars.length > 1 ? lane.cars[0] : undefined);
    for (let k = index + 2; ahead?.wreck?.offLane && k < lane.cars.length; k++) ahead = lane.cars[k];
    if (ahead?.wreck?.offLane) ahead = undefined;
    if (ahead && ahead !== car) {
      const gap = (ahead.s - car.s + (ahead.s < car.s ? lane.length : 0)) - (car.kind.front - ahead.kind.rear);
      if (gap < 150) follow(gap, ahead.v);
    }
    // Red lights, and yellow ones it can still stop for.
    const stopping = v * v / (2 * BRAKE);
    for (const stop of lane.stops) {
      const distance = stop.s - car.s - car.kind.front;
      if (distance < -1 || distance > 90) continue;
      const state = this.state(stop);
      if (car.committed === stop) { if (car.s - car.kind.body.lengthM > stop.exit) car.committed = undefined; continue; }
      // Never stop inside the box: every wait happens at the line. The car enters only if it can drive straight
      // through - its turn or merge has a gap now (left turns: oncoming traffic too), and there is room for the
      // whole car beyond the box on the road it will be on.
      const length = car.kind.body.lengthM;
      const inBox = car.plan && car.plan.at >= stop.s - 2 && car.plan.at <= stop.exit + 2 ? car.plan : undefined;
      const turnClear = !inBox || this.clear(inBox);
      const beyond = inBox?.final ?? (inBox ? { to: inBox.to, s: inBox.s } : undefined);
      const backedUp = beyond
        ? beyond.to.cars.some(other => other.s > beyond.s - 2 && other.s < beyond.s + length + 6 && other.v < 3)
        : !!ahead && ahead !== car && ahead.s > stop.s && ahead.s < stop.exit + length + 6 && ahead.v < 3;
      // Held at the line by an optional left turn: after 2.5 s give it up and go straight on instead.
      if (inBox && !turnClear && state !== 2) {
        car.joinWait += dt;
        if (inBox.yieldTo && !inBox.end && car.joinWait > 8) { car.plan = undefined; car.joinWait = 0; }
        else if (inBox.end && car.joinWait > 3) {
          const ends = lane.links.filter(link => link.end && link.at > car.s - .5 && this.clear(link));
          if (ends.length) { car.plan = ends[Math.floor(this.random() * ends.length)]; car.joinWait = 0; }
        }
      }
      // Last resort against gridlock: a car that has waited 15 s at a green line goes anyway.
      const desperate = car.joinWait > 15;
      if (state !== 2 && ((turnClear && !backedUp) || desperate)) {
        // A road ending in the junction is crossed by its turn path as well.
        const endsHere = !lane.closed && stop.exit >= lane.length - .5, turn = endsHere && car.plan?.final ? car.plan.to.length : 0;
        const across = stop.exit - car.s - car.kind.rear + 1 + turn, clearIn = (-v + Math.sqrt(v * v + 2 * ACCEL * Math.max(0, across))) / ACCEL;
        const cannotStop = distance < v * v / (2 * 8);
        if (clearIn < this.timeToCrossGreen(stop) - .3 || cannotStop || desperate) { if (distance < 15 || cannotStop) { car.committed = stop; car.joinWait = 0; } continue; }
      }
      if (distance > -1) { follow(Math.max(distance, 0), 0, .5, state === 2 ? 'red light' : backedUp ? 'box blocked' : !turnClear ? (inBox?.yieldTo ? 'left-turn yield' : 'merge gap') : 'cannot clear in time'); break; }
    }
    // Unsignalised crossings: enter only when the crossing is empty or in use by this road.
    for (const entry of lane.zones) {
      const distance = entry.enter - car.s - car.kind.front;
      if (car.s > entry.leave) { if (car.zones.delete(entry.zone)) { entry.zone.cars.delete(car); if (!entry.zone.cars.size) entry.zone.road = undefined; } continue; }
      if (car.zones.has(entry.zone) || distance > Math.max(10, stopping + 6)) continue;
      const zone = entry.zone, overdue = zone.request && zone.request.road !== lane.road && this.time - zone.request.since > 4;
      if (!zone.cars.size || (zone.road === lane.road && !overdue)) {
        zone.road = lane.road; zone.cars.add(car); car.zones.add(zone);
        if (zone.request?.road === lane.road) zone.request = undefined;
      } else {
        if (!zone.request) zone.request = { road: lane.road, since: this.time };
        follow(Math.max(distance, 0), 0, .5, 'crossing turn');
      }
      break;
    }
    // Links: decide once per link as it comes up; at the lane's end the car must take one, or it has reached a dead end.
    const next = lane.links.find(link => link.at > car.s - .5 && link.at - car.s < 45);
    if (next && car.considered !== next) {
      car.considered = next;
      const ends = lane.links.filter(link => link.end && link.at > car.s - .5);
      car.plan = next.end ? ends[Math.floor(this.random() * ends.length)] : this.random() < TURN_OFF ? next : undefined;
    }
    // A turn ahead: slow to the connector's speed by the time the car reaches it.
    if (car.plan?.final && v > car.plan.to.speed) follow(car.plan.at - car.s + 10, car.plan.to.speed, 0, 'slowing to turn');
    // Waiting to join: after 3 s try the roomiest other way on; after 6 s squeeze in rather than lock the junction up.
    if (car.plan && !this.clear(car.plan)) {
      if (car.plan.at - car.s - car.kind.front < 3 && car.v < 1) car.joinWait += dt;
      if (car.joinWait > 3 && car.plan.end) {
        const ends = lane.links.filter(link => link.end && link.at > car.s - .5 && this.clear(link));
        if (ends.length) car.plan = ends[Math.floor(this.random() * ends.length)];
      }
      // An optional left turn held up by oncoming traffic is given up after 2.5 s (the car carries on straight), so a
      // waiting turner does not hold the whole lane behind it.
      if (car.plan.yieldTo && !car.plan.end && car.joinWait > 2.5) { car.plan = undefined; car.joinWait = 0; }
    }
    if (car.plan && !this.clear(car.plan)) {
      // A left turn never forces its way through oncoming traffic: it waits for a gap (or their red light). A car
      // already in a junction box (committed at its line) never waits in there: it completes its move.
      const squeeze = (car.joinWait > 6 && !car.plan.yieldTo) || !!car.committed;
      if (!squeeze && !this.clear(car.plan)) follow(car.plan.at - car.s - car.kind.front, 0, .5, car.plan.yieldTo ? 'left-turn yield' : 'merge gap');
    }
    // A street race is on: the closed-off route ahead is a roadblock to wait at.
    if (lane.shut) for (const [from] of lane.shut) {
      const gap = from - car.s - car.kind.front - 4;
      if (gap > -2 && gap < 60) { follow(Math.max(0, gap), 0, .5, 'roadblock'); break; }
    }
    // The players: a car (or anything) in this lane ahead is followed like any other car.
    let stoppedPlayer = false;
    for (const driver of drivers) {
      const toPlayer = this.v3.copy(driver.position).sub(car.position), along = toPlayer.x * car.heading.x + toPlayer.z * car.heading.z;
      const across = Math.abs(toPlayer.x * car.heading.z - toPlayer.z * car.heading.x);
      if (!(along > 0 && along < 60 && across < car.kind.halfWidth + 1.6 && Math.abs(toPlayer.y) < 4)) continue;
      follow(along - car.kind.front - 2.3, Math.max(0, driver.velocity.x * car.heading.x + driver.velocity.z * car.heading.z), STANDSTILL, 'player');
      if (driver.velocity.length() < 1) stoppedPlayer = true;
    }
    // Held up by a stopped player for a few seconds: move over to another lane going the same way, if it is clear.
    const wreckAhead = !!ahead?.wreck && ahead.s - car.s < car.kind.body.lengthM + 12;
    car.blocked = (stoppedPlayer || wreckAhead) && v < 1 ? car.blocked + dt : 0;
    if (car.blocked > 3) { car.blocked = 0; this.changeLane(car); }
    accel = Math.max(accel, -9); car.reason = reason;
    car.braking = accel < -1 || (v < .5 && accel <= 0);
    car.v = Math.max(0, v + accel * dt);
    car.s += car.v * dt;
    if (lane.closed && car.s >= lane.length) car.s -= lane.length;
    if (car.plan && car.s >= car.plan.at) {
      if (this.clear(car.plan) || (car.joinWait > 6 && !car.plan.yieldTo) || car.committed) this.follow(car, car.plan);
      else car.s = car.plan.at, car.v = 0;
    } else if (!lane.closed && car.s >= lane.length) {
      // Past its road's ways on (it joined or was placed beyond them): take the nearest one from here, eased across.
      const ends = lane.links.filter(link => link.end);
      if (ends.length) { const way = ends.sort((x, y) => y.at - x.at)[0]; this.follow(car, way); }
      // A true dead end (no road to join): the car leaves, and rebalance() brings one in elsewhere, out of sight.
      else { this.retire(car); this.deadEnds++; return; }
    }
    car.index = this.sample(car.lane, Math.min(car.s, car.lane.length), car.index, car.position);
    car.drift.multiplyScalar(Math.exp(-dt / .7)); car.position.add(car.drift);
    const look = this.v3, ahead2 = car.lane; this.sample(ahead2, Math.min(ahead2.closed ? car.s + 3 : ahead2.length, car.s + 3), car.index, look);
    if (ahead2.closed && car.s + 3 >= ahead2.length) this.sample(ahead2, car.s + 3 - ahead2.length, 0, look);
    const heading = look.sub(car.position); if (heading.lengthSq() > 1e-4) car.heading.copy(heading.normalize());
    // Wheels roll with the distance covered; the front ones steer to the angle that makes the turn the car is taking.
    const yaw = Math.atan2(car.heading.x, car.heading.z), turn = Math.atan2(Math.sin(yaw - car.yaw), Math.cos(yaw - car.yaw)) / dt;
    car.yaw = yaw;
    car.spin = (car.spin + car.v * dt / Math.max(car.kind.radius, .2)) % (Math.PI * 2);
    const steer = car.v > .5 ? THREE.MathUtils.clamp(Math.atan(car.kind.wheelbase * turn / car.v), -.6, .6) : car.steer;
    car.steer += (steer - car.steer) * (1 - Math.exp(-dt / .15));
  }

  private changeLane(car: Car) {
    for (const lane of car.lane.siblings) {
      // Only into the next lane over.
      if (Math.abs(lane.index - car.lane.index) !== 1) continue;
      const s = this.nearest(lane, car.position).s;
      if (lane.cars.some(other => Math.abs(other.s - s) < 14)) continue;
      const before = car.position.clone();
      car.lane.cars.splice(car.lane.cars.indexOf(car), 1);
      car.lane = lane; car.s = s; lane.cars.push(car); lane.cars.sort((a, b) => a.s - b.s);
      car.index = this.sample(lane, s, 0, car.position);
      // Keep drawing it where it was and ease across, instead of jumping a lane sideways.
      car.drift.copy(before).sub(car.position).setY(0);
      return;
    }
  }

  /**
   * Where a recovered player car goes: the nearest point on a road lane (not a junction connector), facing along the
   * lane, moved forward along it if a traffic car is close by, and clear of junction boxes.
   */
  roadside(at: { x: number; y: number; z: number }) {
    const point = new THREE.Vector3(at.x, at.y, at.z), here = new THREE.Vector3();
    let best: { lane: Lane; s: number; distance: number } | undefined;
    for (const lane of this.lanes) {
      if (lane.connector) continue;
      const near = this.nearest(lane, point);
      this.sample(lane, near.s, 0, here);
      // Prefer lanes at the car's height (the expressway above a street, or the street below it).
      const distance = near.distance + Math.abs(here.y - point.y) * 2;
      if (!best || distance < best.distance) best = { lane, s: near.s, distance };
    }
    if (!best) return undefined;
    const { lane } = best;
    let s = best.s;
    for (let tries = 0; tries < 12; tries++) {
      const busy = lane.cars.some(car => Math.abs(car.s - s) < 14) || lane.stops.some(stop => s > stop.s - 3 && s < stop.exit + 3);
      if (!busy) break;
      s = lane.closed ? (s + 12) % lane.length : Math.min(lane.length - 6, s + 12);
    }
    this.sample(lane, s, 0, here);
    const forward = this.direction(lane, s), yaw = Math.atan2(forward.x, forward.z), q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    return { position: { x: here.x, y: here.y, z: here.z }, forward: { x: forward.x, y: 0, z: forward.z }, rotation: { x: q.x, y: q.y, z: q.z, w: q.w }, width: lane.width, segment: 0 };
  }

  /**
   * The player hit this car: `state` is its stand-in's pose and motion just after the hit (the physics has shared out
   * the momentum by mass, so its velocity is the shove). The car takes it and leaves its lane (or, already knocked,
   * takes the new shove). Detecting the hit is the owner's job (it has the physics); see CityTraffic.knocked.
   */
  applyKnock(car: Car, state: { p: { x: number; z: number }; q: { x: number; y: number; z: number; w: number }; v: { x: number; z: number }; w: { y: number } }) {
    if (!car.wreck) {
      car.wreck = { velocity: new THREE.Vector3(), yawRate: 0, still: 0, offLane: false, hitAt: 0 };
      car.drift.set(0, 0, 0); this.leaveZones(car); car.plan = undefined; car.committed = undefined;
    }
    // Carry on from where the hit really left it.
    const forward = this.v3.set(0, 0, 1).applyQuaternion(new THREE.Quaternion(state.q.x, state.q.y, state.q.z, state.q.w));
    car.position.x = state.p.x; car.position.z = state.p.z; car.yaw = Math.atan2(forward.x, forward.z);
    car.wreck.velocity.set(state.v.x, 0, state.v.z); car.wreck.yawRate = THREE.MathUtils.clamp(state.w.y, -3, 3); car.wreck.still = 0; car.wreck.hitAt = this.time;
    car.v = 0; this.wrecks++;
  }

  /**
   * A knocked car: it skids to a stop (hard on its brakes, harder still sideways) and turns with the spin it was given,
   * and stays in its lane's queue at the point beside it, so cars behind stop or change lanes. Pushed clear of the
   * lane, it no longer holds anyone up. Once it has sat for WRECK_HOLD and the player is not looking, it rejoins its
   * lane where it stopped and drives on.
   */
  private wrecked(car: Car, dt: number, drivers: Driver[]) {
    const wreck = car.wreck!, velocity = wreck.velocity, speed = velocity.length();
    if (speed > .05) {
      const along = velocity.dot(car.heading), side = this.v3.copy(velocity).addScaledVector(car.heading, -along), sideways = side.length();
      const slow = (value: number, rate: number) => Math.sign(value) * Math.max(0, Math.abs(value) - rate * dt);
      velocity.copy(car.heading).multiplyScalar(slow(along, 7)).addScaledVector(side.normalize(), slow(sideways, 10));
      velocity.y = 0; car.position.addScaledVector(velocity, dt);
      // The wheels roll with the car's motion along its own heading.
      car.spin = (car.spin + along * dt / Math.max(car.kind.radius, .2)) % (Math.PI * 2);
    } else { velocity.set(0, 0, 0); wreck.still += dt; }
    wreck.yawRate *= Math.exp(-dt / .45);
    car.yaw += wreck.yawRate * dt;
    car.heading.set(Math.sin(car.yaw), 0, Math.cos(car.yaw));
    car.braking = true;
    // Where it now sits along its lane, and how far off it.
    const near = this.nearest(car.lane, car.position), onLane = new THREE.Vector3();
    car.s = near.s; car.index = this.sample(car.lane, Math.min(car.s, car.lane.length), car.index, onLane);
    wreck.offLane = near.distance > car.kind.halfWidth + 1.9;
    if (wreck.still < WRECK_HOLD || (this.seen(car.position) && drivers.some(driver => car.position.distanceTo(driver.position) < 90) && wreck.still < 40)) return;
    // Back on the road: eased across from where it sat, facing along the lane, from a standstill.
    if (car.lane.cars.some(other => other !== car && !other.wreck && Math.abs(other.s - car.s) < car.kind.body.lengthM + 4)) return;
    car.wreck = undefined; car.v = 0; car.considered = undefined; car.joinWait = 0;
    car.drift.copy(car.position).sub(onLane).setY(0); car.position.copy(onLane);
    car.heading.copy(this.direction(car.lane, car.s)); car.yaw = Math.atan2(car.heading.x, car.heading.z);
  }

  /**
   * Closes a street race's route to free-roam traffic (or opens it again): the stretches of every lane inside the
   * route are marked shut, cars already in there are taken away, and cars coming up to them wait at the roadblock.
   */
  close(street: { route: readonly (readonly number[])[]; closed: boolean } | undefined) {
    for (const lane of this.lanes) lane.shut = undefined;
    const route = street?.route; if (!route) return;
    const CELL = 20, grid = new Map<string, number[]>(), segments = street!.closed ? route.length : route.length - 1;
    for (let i = 0; i < segments; i++) {
      const a = route[i], b = route[(i + 1) % route.length];
      for (let x = Math.floor((Math.min(a[0], b[0]) - 20) / CELL); x <= Math.floor((Math.max(a[0], b[0]) + 20) / CELL); x++)
        for (let z = Math.floor((Math.min(a[2], b[2]) - 20) / CELL); z <= Math.floor((Math.max(a[2], b[2]) + 20) / CELL); z++) (grid.get(`${x},${z}`) ?? grid.set(`${x},${z}`, []).get(`${x},${z}`)!).push(i);
    }
    const inside = (x: number, y: number, z: number) => (grid.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`) ?? []).some(i => {
      const a = route[i], b = route[(i + 1) % route.length], dx = b[0] - a[0], dz = b[2] - a[2], l2 = dx * dx + dz * dz || 1;
      const t = Math.min(1, Math.max(0, ((x - a[0]) * dx + (z - a[2]) * dz) / l2));
      return Math.hypot(x - a[0] - dx * t, z - a[2] - dz * t) < a[3] / 2 + 2 && Math.abs(y - a[1] - (b[1] - a[1]) * t) < 4;
    });
    for (const lane of this.lanes) {
      const p = lane.points, count = p.length / 3, shut: [number, number][] = [];
      let from = -1;
      for (let i = 0; i < lane.s.length; i++) {
        const j = (i % count) * 3, isIn = inside(p[j], p[j + 1], p[j + 2]);
        if (isIn && from < 0) from = lane.s[i];
        if ((!isIn || i === lane.s.length - 1) && from >= 0) { shut.push([from, lane.s[i]]); from = -1; }
      }
      if (shut.length) lane.shut = shut;
    }
    for (const car of [...this.cars]) if (car.lane.shut?.some(([from, to]) => car.s > from - car.kind.front - 2 && car.s < to)) this.retire(car);
  }
}

/** Small seeded generator, so traffic starts the same way each visit. */
function mulberry(seed: number) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
