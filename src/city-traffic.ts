import * as THREE from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { assetUrl } from '../shared/assets';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { ObstacleBody, Simulation } from '../shared/physics';
import { CityProps } from './city-props';
import { CityRaceScene } from './city-race';
import type { Track } from '../shared/tracks';
import type { RaceCar } from '../shared/race-traffic';

/**
 * City traffic: signalised intersections and AI cars that keep to their lane, follow the car ahead, stop for red
 * lights, take turns at unsignalised crossings and brake for the player. Cars never turn; each drives its road to the
 * end (or round a loop) and is placed again near the player when it ends or falls far behind.
 *
 * Everything is drawn as instanced batches: per vehicle kind, one per body material, one each for its head and brake
 * lamps (self-lit, brake lamps brightening per car) and one per wheel material for its front and rear wheels, which
 * spin with the distance driven and steer with the lane's curve. Lamp pools, signal bulbs and glows are one batch each.
 */

type RoadPath = { name: string; district: string; width: number; closed: boolean; points: number[][] };
type Signal = { intersection: Intersection; axis: 0 | 1; matrix: THREE.Matrix4; direction: THREE.Vector3 };
/**
 * A signal controller: its centre and the travel direction its axis 0 runs along. Signals are traffic-actuated:
 * `green` is the axis currently given right of way, `stage` and `t` the stage and seconds spent in it, `demand` the
 * cars approaching each axis's stop lines, and `maxGreen` how long each axis may hold green while the other waits.
 */
type Intersection = { center: THREE.Vector3; axis: THREE.Vector3; green: 0 | 1; stage: 'green' | 'yellow' | 'clear'; t: number; demand: [number, number]; maxGreen: [number, number] };
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
type Lane = {
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
/** Where a wheel sits on its car, and whether it steers and which side it is on (right wheels are the left one turned round). */
type WheelSlot = { at: THREE.Vector3; front: boolean; right: boolean };
type Kind = {
  name: string; weight: number; body: ObstacleBody; front: number; rear: number; halfWidth: number; wheelbase: number; radius: number;
  /** Instanced batches: body parts, lamps (with a per-car colour) and front/rear wheels; and the far version, a
   * simplified body with its wheels fixed in place. */
  parts: THREE.InstancedMesh[]; heads: THREE.InstancedMesh[]; tails: THREE.InstancedMesh[]; frontWheels: THREE.InstancedMesh[]; rearWheels: THREE.InstancedMesh[];
  far: THREE.InstancedMesh[];
  slots: WheelSlot[];
};
type Car = {
  id: number; kind: Kind; lane: Lane; s: number; v: number; index: number; braking: boolean;
  /** How briskly this driver goes: a share of each road's speed, kept from road to road. */
  temper: number;
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
  /** Rammed by the player: sliding free of its lane to a stop, then waiting with its hazards on (see wrecked()). */
  wreck?: { velocity: THREE.Vector3; yawRate: number; still: number; offLane: boolean; hitAt: number };
};
/** How often each kind turns up, relative to an ordinary car. */
const KIND_WEIGHT: Record<string, number> = { 'lct-3000-07': .45, 'lightbody-90-md-utility': .7 };
const KIND_MASS: Record<string, number> = { 'lct-3000-07': 4200, 'lightbody-90-md-utility': 2400 };
/** Cars further than this, or off screen, are not drawn. */
const DRAW_WITHIN = 480;

/** Signal cycle per intersection, in seconds: axis A green, yellow, all red, then axis B the same. */
/** Signal timing (s): shortest green, longest green for the busier and the quieter axis, yellow, all red. */
const MIN_GREEN = 7, MAX_GREEN = 20, MINOR_GREEN = 12, YELLOW = 3, CLEAR = 2;
/** Cars this close to a stop line (m) count as waiting for, or arriving at, that signal. */
const DEMAND_REACH = 60;
/** Cruising speed (m/s) and metres of lane per car, by district. The Training Link sets the feel (one car per ~135 m
 * of lane); the expressway is busier and much faster, the outer ridge roads quieter. */
const DISTRICT_SPEED: Record<string, number> = { Highway: 29, Outer: 20, Industrial: 15, Commercial: 15, Downtown: 13, Training: 15 };
const DISTRICT_SPACING: Record<string, number> = { Highway: 80, Outer: 190, Industrial: 150, Commercial: 130, Downtown: 140, Training: 135 };
/** Chance a car turns off onto a side road it passes. */
const TURN_OFF = .45;
/** Cars nearer than this are drawn in full (spinning, steering wheels); further ones as a simplified shell. */
const DETAIL_WITHIN = 75;
/** Roads with no traffic: the test straight is the player's own. */
const NO_TRAFFIC = new Set(['Acceleration']);
/** Upper bound on cars across the whole city (and the size of each instanced batch). */
const MAX_CARS = 460;
/** Only cars this close are solid to the player's car. */
const SOLID_WITHIN = 110;
/** A hit that changes a car's speed by more than this (m/s) knocks it out of its lane. */
const WRECK_HIT = 2.2;
/** A knocked car sits for this long (s) once stopped, then rejoins its lane when the player is not watching. */
const WRECK_HOLD = 9;
/** Car-following (intelligent driver model): comfortable acceleration and braking, time headway, standstill gap. */
const ACCEL = 2.2, BRAKE = 3.2, HEADWAY = 1.3, STANDSTILL = 3;

function glowTexture() {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
  const c = canvas.getContext('2d')!, gradient = c.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255,255,255,1)'); gradient.addColorStop(.4, 'rgba(255,255,255,.45)'); gradient.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = gradient; c.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; return texture;
}
const glow = (color: number, opacity: number, texture: THREE.Texture) => new THREE.MeshBasicMaterial({ map: texture, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });

export class CityTraffic {
  readonly group = new THREE.Group();
  private lanes: Lane[] = [];
  private signals: Signal[] = [];
  private kinds: Kind[] = [];
  private cars: Car[] = [];
  private nextId = 0;
  /** Counters for tuning: cars that left at dead ends, cars taken off crowded lanes out of sight, and hits by the player. */
  deadEnds = 0; trimmed = 0; wrecks = 0;
  dropped: { from: string; to: string; why: string; turn: string; end: boolean; ahead: number; angle: number }[] = [];
  private time = 0;
  private random = mulberry(20261022);
  private registered?: Simulation;
  private texture = glowTexture();
  private bulbs?: THREE.InstancedMesh;
  private bulbGlows?: THREE.InstancedMesh;
  private pools?: THREE.InstancedMesh;
  /** The camera drawing the city: cars outside its view are skipped. */
  camera?: THREE.Camera;
  private frustum = new THREE.Frustum();
  private matrix = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v3 = new THREE.Vector3();
  private scale = new THREE.Vector3(1, 1, 1);
  private color = new THREE.Color();

  /** Street furniture the player can knock over. */
  props?: CityProps;
  /** Street races: start boxes in free roam, police roadblocks during a race. */
  readonly race = new CityRaceScene();
  /** The street race whose route is closed to free-roam traffic, and the race's own cars as drawn. */
  private closedFor?: Track;
  private puppets = new Map<RaceCar, Car>();

  private constructor() { this.group.name = 'apex-city-traffic'; }

  /** Loads the road paths and vehicles, reads the traffic lights out of the loaded venue, and places the cars. */
  static async create(venue: THREE.Object3D, loader: GLTFLoader, player: THREE.Vector3) {
    const traffic = new CityTraffic();
    const [map, gltf, simplifier, police] = await Promise.all([
      fetch(assetUrl('models/tracks/racing-city.map.json')).then(response => { if (!response.ok) throw new Error(`City map failed: ${response.status}`); return response.json() as Promise<{ paths: RoadPath[] }>; }),
      loader.loadAsync(assetUrl('models/traffic/traffic-cars.glb')),
      import('meshoptimizer').then(async ({ MeshoptSimplifier }) => { await MeshoptSimplifier.ready; return MeshoptSimplifier.supported ? MeshoptSimplifier : undefined; }).catch(() => undefined),
      loader.loadAsync(assetUrl('models/traffic/police-cars.glb')).catch(error => { console.warn('Police cars unavailable.', error); return undefined; }),
    ]);
    traffic.buildSignals(venue);
    traffic.props = new CityProps(venue); traffic.group.add(traffic.props.group);
    traffic.buildLanes(map.paths);
    traffic.buildKinds(gltf.scene, simplifier);
    if (police) traffic.race.build(police.scene);
    traffic.group.add(traffic.race.group);
    traffic.buildLamps();
    traffic.populate(player);
    traffic.render();
    return traffic;
  }

  // ------------------------------------------------------------------ setup
  private buildSignals(venue: THREE.Object3D) {
    venue.updateMatrixWorld(true);
    const poles: { matrix: THREE.Matrix4; direction: THREE.Vector3; at: THREE.Vector3 }[] = [];
    venue.traverse(object => {
      if (!(object instanceof THREE.InstancedMesh) || !/TrafficLight/.test(object.name + ' ' + (object.parent?.name ?? ''))) return;
      for (let i = 0; i < object.count; i++) {
        const matrix = new THREE.Matrix4(); object.getMatrixAt(i, matrix); matrix.premultiply(object.matrixWorld);
        // The model's arm reaches over the road from a pole on the right of the traffic it faces: local +x points to
        // that traffic's right, so it travels along (x.z, 0, -x.x), and the lenses face local +z, towards the driver.
        const right = new THREE.Vector3(1, 0, 0).transformDirection(matrix);
        poles.push({ matrix, direction: new THREE.Vector3(right.z, 0, -right.x).normalize(), at: new THREE.Vector3().setFromMatrixPosition(matrix) });
      }
    });
    // Poles within 45 m of each other share one controller.
    const owner = poles.map((_, i) => i), find = (i: number): number => owner[i] === i ? i : (owner[i] = find(owner[i]));
    poles.forEach((a, i) => poles.forEach((b, j) => { if (j > i && a.at.distanceTo(b.at) < 45) owner[find(j)] = find(i); }));
    const intersections = new Map<number, Intersection>();
    for (let i = 0; i < poles.length; i++) {
      const root = find(i);
      if (!intersections.has(root)) {
        const members = poles.filter((_, j) => find(j) === root), center = members.reduce((sum, pole) => sum.add(pole.at), new THREE.Vector3()).divideScalar(members.length);
        intersections.set(root, { center, axis: poles[i].direction.clone(), green: this.random() < .5 ? 0 : 1, stage: 'green', t: this.random() * MIN_GREEN, demand: [0, 0], maxGreen: [MAX_GREEN, MAX_GREEN] });
      }
    }
    this.signals = poles.map((pole, i) => {
      const intersection = intersections.get(find(i))!;
      return { intersection, axis: Math.abs(pole.direction.dot(intersection.axis)) > .7 ? 0 : 1, matrix: pole.matrix, direction: pole.direction };
    });
  }

  private buildLanes(paths: RoadPath[]) {
    for (const path of paths) {
      if (NO_TRAFFIC.has(path.name)) continue;
      const half = path.width / 2, perDirection = Math.min(2, Math.max(1, Math.floor((half - 1) / 4)));
      for (const reverse of [false, true]) {
        const source = reverse ? [...path.points].reverse() : path.points, group: Lane[] = [];
        for (let lane = 0; lane < perDirection; lane++) {
          // Drive on the right: lanes sit right of the centreline, the inner one 2.5 m out, then 4 m apart.
          const offset = 2.5 + lane * 4, count = source.length, points = new Float32Array(count * 3);
          for (let i = 0; i < count; i++) {
            const previous = source[path.closed ? (i - 1 + count) % count : Math.max(0, i - 1)], next = source[path.closed ? (i + 1) % count : Math.min(count - 1, i + 1)];
            const tx = next[0] - previous[0], tz = next[2] - previous[2], l = Math.hypot(tx, tz) || 1;
            points[i * 3] = source[i][0] - tz / l * offset; points[i * 3 + 1] = source[i][1]; points[i * 3 + 2] = source[i][2] + tx / l * offset;
          }
          const samples = path.closed ? count + 1 : count, s = new Float64Array(samples);
          for (let i = 1; i < samples; i++) { const a = (i - 1) % count, b = i % count; s[i] = s[i - 1] + Math.hypot(points[b * 3] - points[a * 3], points[b * 3 + 1] - points[a * 3 + 1], points[b * 3 + 2] - points[a * 3 + 2]); }
          const spacing = DISTRICT_SPACING[path.district] ?? 140;
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

  private buildKinds(scene: THREE.Object3D, simplifier?: typeof import('meshoptimizer').MeshoptSimplifier) {
    scene.updateMatrixWorld(true);
    const roleOf = (object: THREE.Object3D) => { for (let o: THREE.Object3D | null = object; o; o = o.parent) if (o.userData.apexPart) return o.userData.apexPart as string; return 'body'; };
    const clean = (geometry: THREE.BufferGeometry, matrix: THREE.Matrix4) => {
      // Every part ends up with the same attributes (position, normal, uv) and an index, so parts can be merged.
      const g = geometry.clone().applyMatrix4(matrix);
      for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
      if (!g.attributes.normal) g.computeVertexNormals();
      if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
      if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);
      return g;
    };
    for (const vehicle of scene.children) {
      if (!vehicle.userData.apexVehicle) continue;
      const groups = new Map<string, { role: string; material: THREE.Material; geometries: THREE.BufferGeometry[] }>();
      const wheels: { center: THREE.Vector3; meshes: THREE.Mesh[] }[] = [], box = new THREE.Box3();
      vehicle.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        const role = roleOf(object);
        if (role === 'wheel') {
          // A wheel node may hold several meshes (tyre, rim); group them by the node that carries the role.
          let owner: THREE.Object3D = object; while (owner.parent && !owner.userData.apexPart) owner = owner.parent;
          const center = new THREE.Box3().setFromObject(owner).getCenter(new THREE.Vector3());
          let wheel = wheels.find(w => w.center.distanceTo(center) < .05);
          if (!wheel) { wheel = { center, meshes: [] }; wheels.push(wheel); }
          wheel.meshes.push(object); return;
        }
        const material = object.material as THREE.Material, key = `${role}:${material.uuid}`;
        const group = groups.get(key) ?? groups.set(key, { role, material, geometries: [] }).get(key)!;
        const geometry = clean(object.geometry, object.matrixWorld); group.geometries.push(geometry);
        geometry.computeBoundingBox(); box.union(geometry.boundingBox!);
      });
      if (wheels.length < 4) continue;
      const kind: Kind = {
        name: vehicle.name, weight: KIND_WEIGHT[vehicle.name] ?? 1, front: box.max.z, rear: box.min.z, halfWidth: (box.max.x - box.min.x) / 2, wheelbase: 0, radius: 0,
        body: { widthM: box.max.x - box.min.x, heightM: box.max.y - box.min.y, lengthM: box.max.z - box.min.z, massKg: KIND_MASS[vehicle.name] ?? 1500 },
        parts: [], heads: [], tails: [], frontWheels: [], rearWheels: [], far: [], slots: [],
      };
      const batch = (geometry: THREE.BufferGeometry, material: THREE.Material, count: number, perCarColour = false) => {
        const mesh = new THREE.InstancedMesh(geometry, material, count);
        mesh.count = 0; mesh.frustumCulled = false; mesh.castShadow = false; mesh.receiveShadow = true; mesh.name = `traffic-${vehicle.name}`;
        if (perCarColour) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3).fill(1), 3);
        this.group.add(mesh); return mesh;
      };
      const farParts: THREE.BufferGeometry[] = [];
      for (const { role, material, geometries } of groups.values()) {
        const geometry = geometries.length > 1 ? mergeGeometries(geometries)! : geometries[0];
        if (role === 'body') {
          kind.parts.push(batch(geometry, material, MAX_CARS));
          // Far version: the part at about a tenth of the triangles, painted its material's average colour, so the
          // whole far car (wheels included, interior dropped) merges into a single draw.
          if (!/Interior/i.test(material.name)) farParts.push(painted(simplifier ? simplified(geometry, simplifier, .12) : geometry, material));
          continue;
        }
        // Lamps glow by themselves: an unlit copy of the lamp texture, tinted per car (brighter when braking).
        const source = material as THREE.MeshStandardMaterial;
        const lamp = new THREE.MeshBasicMaterial({ map: source.map, color: 0xffffff, toneMapped: false, transparent: source.transparent, opacity: source.opacity, side: source.side });
        (role === 'head' ? kind.heads : kind.tails).push(batch(geometry, lamp, MAX_CARS, true));
      }
      // Wheels: forward is +z and right is -x, so left wheels have x > 0. The left front and left rear wheels become
      // the shapes; each is centred on its hub so it can turn about it.
      const middle = wheels.reduce((sum, w) => sum + w.center.z, 0) / wheels.length;
      for (const wheel of wheels) kind.slots.push({ at: wheel.center.clone(), front: wheel.center.z > middle, right: wheel.center.x < 0 });
      const frontZ = Math.max(...wheels.map(w => w.center.z)), rearZ = Math.min(...wheels.map(w => w.center.z));
      kind.wheelbase = frontZ - rearZ;
      for (const front of [true, false]) {
        const shape = wheels.filter(w => (w.center.z > middle) === front).sort((a, b) => b.center.x - a.center.x)[0];
        const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
        for (const mesh of shape.meshes) {
          const geometry = clean(mesh.geometry, mesh.matrixWorld).translate(-shape.center.x, -shape.center.y, -shape.center.z);
          (byMaterial.get(mesh.material as THREE.Material) ?? byMaterial.set(mesh.material as THREE.Material, []).get(mesh.material as THREE.Material)!).push(geometry);
        }
        for (const [material, geometries] of byMaterial) {
          const geometry = geometries.length > 1 ? mergeGeometries(geometries)! : geometries[0];
          if (front) { geometry.computeBoundingBox(); kind.radius = Math.max(kind.radius, geometry.boundingBox!.max.y); }
          (front ? kind.frontWheels : kind.rearWheels).push(batch(geometry, material, MAX_CARS * 2));
        }
      }
      // Far wheels: all four, simplified and fixed in place, in one batch per wheel material.
      const farWheels = new Map<THREE.Material, THREE.BufferGeometry[]>();
      for (const wheel of wheels) for (const mesh of wheel.meshes) {
        const geometry = clean(mesh.geometry, mesh.matrixWorld);
        (farWheels.get(mesh.material as THREE.Material) ?? farWheels.set(mesh.material as THREE.Material, []).get(mesh.material as THREE.Material)!).push(geometry);
      }
      for (const [material, geometries] of farWheels) farParts.push(painted(simplifier ? simplified(mergeGeometries(geometries)!, simplifier, .15) : mergeGeometries(geometries)!, material));
      if (farParts.length) kind.far.push(batch(mergeGeometries(farParts)!, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .55, metalness: .25, name: 'traffic-far' }), MAX_CARS));
      this.kinds.push(kind);
    }
  }

  private buildLamps() {
    const poolMaterial = glow(0xfff0d0, .32, this.texture);
    poolMaterial.polygonOffset = true; poolMaterial.polygonOffsetFactor = -2; poolMaterial.polygonOffsetUnits = -2;
    this.pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), poolMaterial, MAX_CARS);
    this.pools.frustumCulled = false; this.pools.count = 0; this.group.add(this.pools);
    // Signal bulbs: red, yellow and green per head, lit or dim; one glow per head around the lit bulb.
    const count = this.signals.length;
    if (!count) return;
    this.bulbs = new THREE.InstancedMesh(new THREE.CircleGeometry(.17, 14), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), count * 3);
    this.bulbs.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 9), 3);
    this.bulbGlows = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), glow(0xffffff, .85, this.texture), count);
    this.bulbGlows.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    this.signals.forEach((signal, i) => {
      for (let bulb = 0; bulb < 3; bulb++) this.bulbs!.setMatrixAt(i * 3 + bulb, this.matrix.copy(signal.matrix).multiply(new THREE.Matrix4().makeTranslation(-1.58, 3.88 - bulb * .27, .08)));
    });
    this.bulbs.computeBoundingSphere(); this.bulbGlows.frustumCulled = false;
    this.group.add(this.bulbs, this.bulbGlows);
  }

  // ------------------------------------------------------------------ lanes
  /** Point and travel direction along a lane at distance s. */
  private sample(lane: Lane, s: number, hint: number, out: THREE.Vector3) {
    const count = lane.points.length / 3;
    let i = Math.min(Math.max(0, hint), lane.s.length - 2);
    while (i < lane.s.length - 2 && lane.s[i + 1] < s) i++;
    while (i > 0 && lane.s[i] > s) i--;
    const a = (i % count) * 3, b = ((i + 1) % count) * 3, t = THREE.MathUtils.clamp((s - lane.s[i]) / ((lane.s[i + 1] - lane.s[i]) || 1), 0, 1), p = lane.points;
    out.set(p[a] + (p[b] - p[a]) * t, p[a + 1] + (p[b + 1] - p[a + 1]) * t, p[a + 2] + (p[b + 2] - p[a + 2]) * t);
    return i;
  }
  private direction(lane: Lane, s: number) {
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    this.sample(lane, Math.max(0, s - 2), 0, a); this.sample(lane, Math.min(lane.length, s + 2), 0, b);
    return b.sub(a).setY(0).normalize();
  }
  private nearest(lane: Lane, point: THREE.Vector3) {
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

  /** Fills every lane to its density, evenly spaced with a little jitter, keeping clear of the player. */
  private populate(player: THREE.Vector3) {
    for (const lane of this.lanes) {
      if (lane.connector) continue;
      const step = lane.length / lane.target;
      for (let k = 0; k < lane.target && this.cars.length < MAX_CARS; k++)
        for (const shift of [.5, .2, .8, .05, .95]) if (this.place(lane, (k + shift) * step, player, 25)) break;
    }
  }
  /** Puts a new car on a lane at distance s if the spot is clear (of cars, stop lines, crossings and the player). */
  private place(lane: Lane, s: number, player: THREE.Vector3, clearOfPlayer: number, hidden = false): Car | undefined {
    if (!lane.closed && lane.links.some(link => link.end) && s > Math.max(...lane.links.filter(link => link.end).map(link => link.at)) - 5) return undefined;
    if (lane.cars.some(other => Math.abs(other.s - s) < 18) || lane.stops.some(stop => Math.abs(stop.s - s) < 12) || lane.zones.some(zone => s > zone.enter - 4 && s < zone.leave)) return undefined;
    if (lane.shut?.some(([from, to]) => s > from - 30 && s < to + 5)) return undefined;
    const at = new THREE.Vector3(), index = this.sample(lane, s, 0, at);
    if (at.distanceTo(player) < clearOfPlayer) return undefined;
    if (hidden && this.camera && at.distanceTo(this.eye) < 420 && this.frustum.intersectsSphere(new THREE.Sphere(at, 4))) return undefined;
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
  private rebalance(player: THREE.Vector3, sim: Simulation) {
    const crowded = this.lanes.find(lane => !lane.connector && lane.cars.length > lane.target * 1.1 + 1);
    if (crowded) {
      const car = crowded.cars.find(c => !this.visible(c.position) && c.position.distanceTo(player) > 200 && !c.zones.size);
      if (car) { this.retire(car, sim); this.trimmed++; }
    }
    // Up to three of the emptiest lanes gain a car each frame.
    const short = this.lanes.filter(lane => !lane.connector && lane.cars.length < lane.target * .9).sort((a, b) => a.cars.length / a.target - b.cars.length / b.target);
    let added = 0;
    for (const lane of short) {
      if (added >= 3 || this.cars.length >= MAX_CARS) break;
      for (let attempt = 0; attempt < 8; attempt++) if (this.place(lane, this.random() * lane.length, player, 160, true)) { added++; break; }
    }
  }
  private get eye() { return this.camera ? this.eyePosition.setFromMatrixPosition(this.camera.matrixWorld) : this.eyePosition; }
  private eyePosition = new THREE.Vector3();
  private visible(at: THREE.Vector3) { return !!this.camera && at.distanceTo(this.eye) < DRAW_WITHIN && this.frustum.intersectsSphere(new THREE.Sphere(at, 5)); }
  private retire(car: Car, sim: Simulation) {
    this.remove(car); this.release(car, sim);
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
  private state(signal: { intersection: Intersection; axis: 0 | 1 }) {
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

  // ------------------------------------------------------------------ update
  /** Advances signals and cars by dt seconds and keeps the nearby cars solid in the player's simulation. */
  update(dt: number, sim: Simulation, player: THREE.Vector3, playerVelocity: THREE.Vector3) {
    dt = Math.min(dt, .1);
    this.time += dt;
    const street = sim.track.kind === 'street' ? sim.track : undefined;
    if (street !== this.closedFor) this.close(street, sim);
    this.race.update(dt, this.camera ? this.eye : undefined);
    if (dt > 0) this.runSignals(dt);
    if (this.camera) { this.camera.updateMatrixWorld(); this.frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse)); }
    for (const lane of this.lanes) lane.cars.sort((a, b) => a.s - b.s);
    if (dt > 0) {
      for (const car of [...this.cars]) this.drive(car, dt, player, playerVelocity, sim);
      this.rebalance(player, sim);
    }
    this.solid(sim, player);
    if (dt > 0) this.props?.update(dt, sim, player);
    this.syncPuppets(sim);
    this.render();
  }

  private drive(car: Car, dt: number, player: THREE.Vector3, playerVelocity: THREE.Vector3, sim: Simulation) {
    if (car.wreck) { this.wrecked(car, dt, player); return; }
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
    // The player: a car (or anything) in this lane ahead is followed like any other car.
    const toPlayer = this.v3.copy(player).sub(car.position), along = toPlayer.x * car.heading.x + toPlayer.z * car.heading.z;
    const across = Math.abs(toPlayer.x * car.heading.z - toPlayer.z * car.heading.x);
    const playerAhead = along > 0 && along < 60 && across < car.kind.halfWidth + 1.6 && Math.abs(toPlayer.y) < 4;
    if (playerAhead) follow(along - car.kind.front - 2.3, Math.max(0, playerVelocity.x * car.heading.x + playerVelocity.z * car.heading.z), STANDSTILL, 'player');
    // Held up by a stopped player for a few seconds: move over to another lane going the same way, if it is clear.
    const wreckAhead = !!ahead?.wreck && ahead.s - car.s < car.kind.body.lengthM + 12;
    car.blocked = (playerAhead && playerVelocity.length() < 1 || wreckAhead) && v < 1 ? car.blocked + dt : 0;
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
      else { this.retire(car, sim); this.deadEnds++; return; }
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
      if (lane === car.lane) continue;
      const s = this.nearest(lane, car.position).s;
      if (lane.cars.some(other => Math.abs(other.s - s) < 14)) continue;
      const before = car.position.clone();
      car.lane.cars.splice(car.lane.cars.indexOf(car), 1);
      car.lane = lane; car.s = s; lane.cars.push(car); lane.cars.sort((a, b) => a.s - b.s);
      car.index = this.sample(lane, s, 0, car.position);
      // Keep drawing it where it was and ease across, instead of jumping 4 m sideways.
      car.drift.copy(before).sub(car.position).setY(0);
      return;
    }
  }
  /** Registers nearby cars as stand-ins in the player's physics world, and removes the rest. */
  private solid(sim: Simulation, player: THREE.Vector3) {
    // A street race's simulation has its own traffic; free-roam cars there are scenery, never solid (replays must
    // not depend on them), and recovery goes back to the last checkpoint.
    if (sim.track.kind === 'street') { if (this.registered !== sim) { this.registered = sim; for (const car of this.cars) car.obstacle = false; } return; }
    if (this.registered !== sim) { this.registered = sim; for (const car of this.cars) car.obstacle = false; sim.recoverPoint = at => this.roadside(at); }
    for (const car of this.cars) {
      const near = car.position.distanceTo(player) < SOLID_WITHIN;
      if (!near) { this.release(car, sim); continue; }
      if (car.obstacle && car.position.distanceTo(player) < 12) this.knocked(car, sim, player);
      const h = car.kind.body.heightM, yaw = Math.atan2(car.heading.x, car.heading.z), pitch = -Math.asin(THREE.MathUtils.clamp(car.heading.y, -1, 1));
      this.q.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
      sim.setObstacle(`traffic-${car.id}`, car.kind.body, {
        p: { x: car.position.x, y: car.position.y + .25 + h * .32, z: car.position.z },
        q: { x: this.q.x, y: this.q.y, z: this.q.z, w: this.q.w },
        v: car.wreck ? { x: car.wreck.velocity.x, y: 0, z: car.wreck.velocity.z } : { x: car.heading.x * car.v, y: car.heading.y * car.v, z: car.heading.z * car.v },
      });
      car.obstacle = true;
    }
  }
  /**
   * Where a recovered player car goes: the nearest point on a road lane (not a junction connector), facing along the
   * lane, moved forward along it if a traffic car is close by, and clear of junction boxes.
   */
  private roadside(at: { x: number; y: number; z: number }) {
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
   * Whether the player just hit this car: its stand-in in the physics world moving well off the speed it was given.
   * The physics has already shared out the momentum by mass, so the stand-in's velocity is the shove; the car takes
   * it and leaves its lane (or, already knocked, takes the new shove).
   */
  private knocked(car: Car, sim: Simulation, player: THREE.Vector3) {
    // Only with the player's car against it (the stand-in also strays a little on its own as it is steered).
    const to = this.v3.copy(player).sub(car.position), along = Math.abs(to.x * car.heading.x + to.z * car.heading.z), across = Math.abs(to.x * car.heading.z - to.z * car.heading.x);
    if (along > car.kind.body.lengthM / 2 + 3 || across > car.kind.halfWidth + 2.2 || (car.wreck && this.time - car.wreck.hitAt < .3)) return;
    const state = sim.obstacleState(`traffic-${car.id}`); if (!state) return;
    const given = car.wreck ? car.wreck.velocity : this.v3.copy(car.heading).multiplyScalar(car.v);
    if (Math.hypot(state.v.x - given.x, state.v.z - given.z) < WRECK_HIT) return;
    if (!car.wreck) {
      car.wreck = { velocity: new THREE.Vector3(), yawRate: 0, still: 0, offLane: false, hitAt: 0 };
      car.drift.set(0, 0, 0); this.leaveZones(car); car.plan = undefined; car.committed = undefined;
    }
    // Carry on from where the hit really left it.
    const forward = this.v3.set(0, 0, 1).applyQuaternion(this.q.set(state.q.x, state.q.y, state.q.z, state.q.w));
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
  private wrecked(car: Car, dt: number, player: THREE.Vector3) {
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
    if (wreck.still < WRECK_HOLD || (this.visible(car.position) && car.position.distanceTo(player) < 90 && wreck.still < 40)) return;
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
  private close(race: Track | undefined, sim: Simulation) {
    this.closedFor = race; this.race.show(race); this.puppets.clear();
    for (const lane of this.lanes) lane.shut = undefined;
    const route = race?.street?.route; if (!route) return;
    const CELL = 20, grid = new Map<string, number[]>(), segments = race!.street!.closed ? route.length : route.length - 1;
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
    for (const car of [...this.cars]) if (car.lane.shut?.some(([from, to]) => car.s > from - car.kind.front - 2 && car.s < to)) this.retire(car, sim);
  }
  /** The race's own cars (shared/race-traffic.ts), copied into drawable cars each frame. */
  private syncPuppets(sim: Simulation) {
    const cars = sim.raceTraffic?.cars; if (!cars) return;
    for (const raceCar of cars) {
      let car = this.puppets.get(raceCar);
      if (raceCar.parked) { if (car) this.puppets.delete(raceCar); continue; }
      const kind = this.kinds.find(k => k.name === raceCar.kind.id); if (!kind) continue;
      if (!car) {
        car = { id: -1 - raceCar.id, kind, lane: this.lanes[0], s: 0, v: 0, index: 0, braking: false, temper: 1, position: new THREE.Vector3(), heading: new THREE.Vector3(), zones: new Set(), obstacle: false,
          blocked: 0, drift: new THREE.Vector3(), spin: 0, steer: 0, yaw: raceCar.yaw, joinWait: 0 };
        this.puppets.set(raceCar, car);
      }
      const turn = Math.atan2(Math.sin(raceCar.yaw - car.yaw), Math.cos(raceCar.yaw - car.yaw)), speed = Math.max(.5, raceCar.v);
      car.position.set(raceCar.x, raceCar.y, raceCar.z); car.yaw = raceCar.yaw; car.v = raceCar.v; car.braking = raceCar.braking;
      car.heading.set(Math.sin(raceCar.yaw) * Math.cos(raceCar.pitch), -Math.sin(raceCar.pitch), Math.cos(raceCar.yaw) * Math.cos(raceCar.pitch));
      car.spin = (raceCar.travel / Math.max(kind.radius, .2)) % (Math.PI * 2);
      car.steer = raceCar.v > .5 ? THREE.MathUtils.clamp(Math.atan(kind.wheelbase * turn * 60 / speed), -.6, .6) * .5 + car.steer * .5 : car.steer;
      car.wreck = raceCar.wreck ? (car.wreck ?? { velocity: new THREE.Vector3(), yawRate: 0, still: 0, offLane: false, hitAt: 0 }) : undefined;
    }
  }
  private release(car: Car, sim: Simulation) {
    if (car.obstacle && this.registered === sim) sim.setObstacle(`traffic-${car.id}`, car.kind.body, undefined);
    car.obstacle = false;
  }

  // ------------------------------------------------------------------ drawing
  private render() {
    const m = this.matrix, q = this.q, up = new THREE.Vector3(0, 1, 0), counts = new Map<Kind, number>(), farCounts = new Map<Kind, number>(), lamps = new Map<Kind, number>();
    const local = new THREE.Matrix4(), spin = new THREE.Matrix4(), steer = new THREE.Matrix4(), flip = new THREE.Matrix4().makeRotationY(Math.PI);
    const sphere = new THREE.Sphere(), eye = this.camera ? this.eye.clone() : undefined;
    let pool = 0;
    for (const car of [...this.cars, ...this.puppets.values()]) {
      const k = car.kind;
      sphere.set(car.position, k.body.lengthM * .6);
      const distance = eye ? car.position.distanceTo(eye) : 0;
      if (eye && (distance > DRAW_WITHIN || !this.frustum.intersectsSphere(sphere))) continue;
      const pitch = -Math.asin(THREE.MathUtils.clamp(car.heading.y, -1, 1));
      q.setFromEuler(new THREE.Euler(pitch, car.yaw, 0, 'YXZ'));
      const carMatrix = new THREE.Matrix4().compose(car.position, q, this.scale.set(1, 1, 1));
      const l = lamps.get(k) ?? 0; lamps.set(k, l + 1);
      for (const mesh of k.heads) { mesh.setMatrixAt(l, carMatrix); mesh.setColorAt(l, this.color.setRGB(2.4, 2.3, 2.1)); }
      // A knocked car flashes its hazards.
      const hazard = car.wreck && Math.floor(this.time * 2.6) % 2 === 0;
      for (const mesh of k.tails) { mesh.setMatrixAt(l, carMatrix); mesh.setColorAt(l, hazard ? this.color.setRGB(5, 2.2, .4) : car.braking ? this.color.setRGB(4.5, 1.2, 1.1) : this.color.setRGB(1.6, .55, .5)); }
      if (distance > DETAIL_WITHIN && k.far.length) {
        const f = farCounts.get(k) ?? 0; farCounts.set(k, f + 1);
        for (const mesh of k.far) mesh.setMatrixAt(f, carMatrix);
        if (distance < 200 && pool < MAX_CARS) this.pools!.setMatrixAt(pool++, m.compose(this.v3.set(0, .06, k.front + 7).applyQuaternion(q).add(car.position), this.q.setFromAxisAngle(up, car.yaw), this.scale.set(5.5, 1, 12)));
        this.scale.set(1, 1, 1);
        continue;
      }
      const n = counts.get(k) ?? 0; counts.set(k, n + 1);
      for (const mesh of k.parts) mesh.setMatrixAt(n, carMatrix);
      let front = 0, rear = 0;
      for (const slot of k.slots) {
        spin.makeRotationX(car.spin); steer.makeRotationY(slot.front ? car.steer : 0);
        local.makeTranslation(slot.at.x, slot.at.y, slot.at.z).multiply(steer).multiply(spin);
        if (slot.right) local.multiply(flip);
        m.multiplyMatrices(carMatrix, local);
        const index = n * 2 + (slot.front ? front++ : rear++);
        for (const mesh of slot.front ? k.frontWheels : k.rearWheels) mesh.setMatrixAt(index, m);
      }
      if (pool < MAX_CARS) this.pools!.setMatrixAt(pool++, m.compose(this.v3.set(0, .06, k.front + 7).applyQuaternion(q).add(car.position), this.q.setFromAxisAngle(up, car.yaw), this.scale.set(5.5, 1, 12)));
      this.scale.set(1, 1, 1);
    }
    for (const kind of this.kinds) {
      const n = counts.get(kind) ?? 0;
      for (const mesh of kind.parts) { mesh.count = n; mesh.instanceMatrix.needsUpdate = true; }
      for (const mesh of [...kind.frontWheels, ...kind.rearWheels]) { mesh.count = n * 2; mesh.instanceMatrix.needsUpdate = true; }
      for (const mesh of kind.far) { mesh.count = farCounts.get(kind) ?? 0; mesh.instanceMatrix.needsUpdate = true; }
      for (const mesh of [...kind.heads, ...kind.tails]) { mesh.count = lamps.get(kind) ?? 0; mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor!.needsUpdate = true; }
    }
    this.pools!.count = pool; this.pools!.instanceMatrix.needsUpdate = true;
    if (!this.bulbs || !this.bulbGlows) return;
    const colors = [new THREE.Color(4, .15, .1), new THREE.Color(4, 2.2, .1), new THREE.Color(.2, 3.5, 1.2)], dim = .06;
    this.signals.forEach((signal, i) => {
      const lit = 2 - this.state(signal); // bulb 0 red (top), 1 yellow, 2 green
      for (let bulb = 0; bulb < 3; bulb++) this.bulbs!.setColorAt(i * 3 + bulb, this.color.copy(colors[bulb]).multiplyScalar(bulb === lit ? 1 : dim));
      this.bulbGlows!.setColorAt(i, this.color.copy(colors[lit]).multiplyScalar(.35));
      this.v3.set(-1.58, 3.88 - lit * .27, .25).applyMatrix4(signal.matrix);
      this.bulbGlows!.setMatrixAt(i, m.compose(this.v3, q.setFromRotationMatrix(new THREE.Matrix4().extractRotation(signal.matrix)), this.scale.set(1.6, 1.6, 1.6)));
      this.scale.set(1, 1, 1);
    });
    this.bulbs.instanceColor!.needsUpdate = true; this.bulbGlows.instanceColor!.needsUpdate = true; this.bulbGlows.instanceMatrix.needsUpdate = true;
  }

  /** Signal states for the map: position and 0 green, 1 yellow, 2 red. */
  signalStates() { return this.signals.map(signal => ({ at: new THREE.Vector3().setFromMatrixPosition(signal.matrix), state: this.state(signal) })); }

  dispose(sim?: Simulation) {
    if (sim) for (const car of this.cars) this.release(car, sim);
    // Debris shares the venue's geometry and materials; the venue frees those.
    this.props?.dispose();
    this.group.traverse(object => { if (object instanceof THREE.Mesh) { object.geometry.dispose(); (object.material as THREE.Material).dispose(); } });
    this.texture.dispose();
    this.group.removeFromParent();
  }
}

/** Small seeded generator, so traffic starts the same way each visit. */
function mulberry(seed: number) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

/**
 * A far version of a mesh: positions welded first (texture seams split vertices, and the simplifier will not collapse
 * across a split), simplified to `ratio` of the triangles, then indexed back into the original vertex buffer.
 */
function simplified(source: THREE.BufferGeometry, simplifier: typeof import('meshoptimizer').MeshoptSimplifier, ratio: number) {
  const index = source.getIndex()!, position = source.getAttribute('position');
  if (index.count < 600) return source;
  const unique = new Map<string, number>(), remap = new Uint32Array(position.count), flat: number[] = [];
  for (let i = 0; i < position.count; i++) {
    const key = `${position.getX(i).toFixed(3)},${position.getY(i).toFixed(3)},${position.getZ(i).toFixed(3)}`;
    let id = unique.get(key); if (id === undefined) { id = unique.size; unique.set(key, id); flat.push(position.getX(i), position.getY(i), position.getZ(i)); }
    remap[i] = id;
  }
  const representative = new Uint32Array(unique.size); for (let i = position.count - 1; i >= 0; i--) representative[remap[i]] = i;
  const welded = new Uint32Array(index.count); for (let i = 0; i < index.count; i++) welded[i] = remap[index.getX(i)];
  const [reduced] = simplifier.simplify(welded, new Float32Array(flat), 3, Math.max(36, Math.floor(index.count * ratio / 3) * 3), .05);
  const lod = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(source.attributes)) lod.setAttribute(name, attribute);
  lod.setIndex(new THREE.BufferAttribute(reduced.map(id => representative[id]), 1));
  return lod;
}

/** A material's overall colour: its texture averaged (sampled small) times its colour factor, in linear space. */
const averages = new WeakMap<THREE.Material, THREE.Color>();
function averageColour(material: THREE.Material) {
  const known = averages.get(material); if (known) return known;
  const standard = material as THREE.MeshStandardMaterial, colour = standard.color?.clone() ?? new THREE.Color(1, 1, 1);
  const image = standard.map?.image as CanvasImageSource | undefined;
  if (image) {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 8;
    const c = canvas.getContext('2d', { willReadFrequently: true })!; c.drawImage(image, 0, 0, 8, 8);
    const data = c.getImageData(0, 0, 8, 8).data; let r = 0, g = 0, b = 0;
    for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; }
    colour.multiply(new THREE.Color().setRGB(r / 64 / 255, g / 64 / 255, b / 64 / 255, THREE.SRGBColorSpace));
  }
  averages.set(material, colour); return colour;
}
/**
 * A compact copy of a geometry (only the vertices its index uses) with plain position and normal arrays, coloured per
 * vertex with the material's average colour. Plain arrays matter: source parts may store vertices interleaved, which
 * cannot be merged.
 */
function painted(source: THREE.BufferGeometry, material: THREE.Material) {
  const index = source.getIndex(), position = source.getAttribute('position'), normal = source.getAttribute('normal'), colour = averageColour(material);
  const remap = new Map<number, number>(), positions: number[] = [], normals: number[] = [], colours: number[] = [], indices: number[] = [];
  const count = index ? index.count : position.count;
  for (let i = 0; i < count; i++) {
    const vertex = index ? index.getX(i) : i;
    let id = remap.get(vertex);
    if (id === undefined) {
      id = remap.size; remap.set(vertex, id);
      positions.push(position.getX(vertex), position.getY(vertex), position.getZ(vertex));
      normals.push(normal.getX(vertex), normal.getY(vertex), normal.getZ(vertex));
      colours.push(colour.r, colour.g, colour.b);
    }
    indices.push(id);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  geometry.setIndex(indices);
  return geometry;
}
