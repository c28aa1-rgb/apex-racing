import * as THREE from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { assetUrl } from '../shared/assets';
import type { ObstacleBody, Simulation } from '../shared/physics';

/**
 * City traffic: signalised intersections and AI cars that keep to their lane, follow the car ahead, stop for red
 * lights, take turns at unsignalised crossings and brake for the player. Cars never turn; each drives its road to the
 * end (or round a loop) and is placed again near the player when it ends or falls far behind.
 *
 * Everything is drawn as instanced batches: one per vehicle kind, one each for head lamps, tail lamps and lamp pools,
 * and one each for signal bulbs and their glows.
 */

type RoadPath = { name: string; district: string; width: number; closed: boolean; points: number[][] };
type Signal = { intersection: Intersection; axis: 0 | 1; matrix: THREE.Matrix4; direction: THREE.Vector3 };
type Intersection = { center: THREE.Vector3; offset: number };
type Stop = { s: number; signal: Signal };
type Zone = { center: THREE.Vector3; road?: string; cars: Set<Car> };
type ZoneEntry = { zone: Zone; enter: number; leave: number };
type Lane = {
  road: string; closed: boolean; speed: number; length: number;
  /** Other lanes of the same road in the same direction: where a car can move over to pass a stopped player. */
  siblings: Lane[];
  /** x, y, z per sample, and the distance along the lane at each sample. */
  points: Float32Array; s: Float64Array;
  stops: Stop[]; zones: ZoneEntry[]; cars: Car[];
};
type Kind = { name: string; mesh: THREE.InstancedMesh; body: ObstacleBody; front: number; rear: number; halfWidth: number; lampY: number };
type Car = {
  id: number; kind: Kind; lane: Lane; s: number; v: number; cruise: number; index: number; braking: boolean;
  position: THREE.Vector3; heading: THREE.Vector3; zones: Set<Zone>; obstacle: boolean;
  /** Seconds spent held up by the player; and the sideways offset left over from a lane change, easing to zero. */
  blocked: number; drift: THREE.Vector3;
};

/** Signal cycle per intersection, in seconds: axis A green, yellow, all red, then axis B the same. */
const GREEN = 14, YELLOW = 3, CLEAR = 1.5, CYCLE = 2 * (GREEN + YELLOW + CLEAR);
const DISTRICT_SPEED: Record<string, number> = { Highway: 25, Outer: 19, Industrial: 15, Commercial: 15, Downtown: 13, Training: 15 };
/** Roads with no traffic: the test straight is the player's own. */
const NO_TRAFFIC = new Set(['Acceleration']);
const CAR_COUNT = 34;
/** Traffic is kept within this distance of the player; cars beyond it are placed again ahead of time. */
const KEEP_NEAR = 650;
/** Only cars this close are solid to the player's car. */
const SOLID_WITHIN = 110;
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
  /** Car ids waiting for a free spot near the player (none was found when they were last placed). */
  private waiting: number[] = [];
  private time = 0;
  private random = mulberry(20261022);
  private registered?: Simulation;
  private texture = glowTexture();
  private bulbs?: THREE.InstancedMesh;
  private bulbGlows?: THREE.InstancedMesh;
  private heads?: THREE.InstancedMesh;
  private tails?: THREE.InstancedMesh;
  private pools?: THREE.InstancedMesh;
  private matrix = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v3 = new THREE.Vector3();
  private scale = new THREE.Vector3(1, 1, 1);
  private color = new THREE.Color();

  private constructor() { this.group.name = 'apex-city-traffic'; }

  /** Loads the road paths and vehicles, reads the traffic lights out of the loaded venue, and places the cars. */
  static async create(venue: THREE.Object3D, loader: GLTFLoader, player: THREE.Vector3) {
    const traffic = new CityTraffic();
    const [map, gltf] = await Promise.all([
      fetch(assetUrl('models/tracks/racing-city.map.json')).then(response => { if (!response.ok) throw new Error(`City map failed: ${response.status}`); return response.json() as Promise<{ paths: RoadPath[] }>; }),
      loader.loadAsync(assetUrl('models/traffic/traffic-cars.glb')),
    ]);
    traffic.buildSignals(venue);
    traffic.buildLanes(map.paths);
    traffic.buildKinds(gltf.scene);
    traffic.buildLamps();
    for (let i = 0; i < CAR_COUNT; i++) { const car = traffic.spawn(i, player, 60, KEEP_NEAR); if (car) traffic.cars.push(car); else traffic.waiting.push(i); }
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
        intersections.set(root, { center, offset: this.random() * CYCLE });
      }
    }
    const reference = new Map<Intersection, THREE.Vector3>();
    this.signals = poles.map((pole, i) => {
      const intersection = intersections.get(find(i))!, axisOf = reference.get(intersection) ?? (reference.set(intersection, pole.direction), pole.direction);
      return { intersection, axis: Math.abs(pole.direction.dot(axisOf)) > .7 ? 0 : 1, matrix: pole.matrix, direction: pole.direction };
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
          const built: Lane = { road: path.name, closed: path.closed, speed: DISTRICT_SPEED[path.district] ?? 15, length: s[samples - 1], siblings: group, points, s, stops: [], zones: [], cars: [] };
          group.push(built); this.lanes.push(built);
        }
      }
    }
    // Stop lines: a signal controls a lane passing within 20 m of its pole in the signal's direction of travel.
    for (const lane of this.lanes) {
      for (const signal of this.signals) {
        const pole = this.v3.setFromMatrixPosition(signal.matrix), nearest = this.nearest(lane, pole);
        if (nearest.distance > 20 || this.direction(lane, nearest.s).dot(signal.direction) < .8) continue;
        const s = nearest.s - 4;
        if (!lane.stops.some(stop => stop.signal.intersection === signal.intersection && Math.abs(stop.s - s) < 30)) lane.stops.push({ s, signal });
      }
      lane.stops.sort((a, b) => a.s - b.s);
    }
    this.buildZones();
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

  private buildKinds(scene: THREE.Object3D) {
    scene.updateMatrixWorld(true);
    for (const vehicle of scene.children) {
      let geometry: THREE.BufferGeometry | undefined, material: THREE.Material | undefined;
      vehicle.traverse(object => { if (object instanceof THREE.Mesh && !geometry) { geometry = object.geometry.clone().applyMatrix4(object.matrixWorld); material = object.material as THREE.Material; } });
      if (!geometry || !material) continue;
      geometry.computeBoundingBox();
      const box = geometry.boundingBox!, size = box.getSize(new THREE.Vector3());
      const mesh = new THREE.InstancedMesh(geometry, material, CAR_COUNT);
      mesh.name = `traffic-${vehicle.name}`; mesh.count = 0; mesh.frustumCulled = false; mesh.castShadow = false; mesh.receiveShadow = true;
      this.group.add(mesh);
      const heavy = /truck|delivery|van/.test(vehicle.name);
      this.kinds.push({ name: vehicle.name, mesh, front: box.max.z, rear: box.min.z, halfWidth: size.x / 2, lampY: box.min.y + size.y * .38,
        body: { widthM: size.x, heightM: size.y, lengthM: size.z, massKg: heavy ? 2600 : 1450 } });
    }
  }

  private buildLamps() {
    const lampCount = CAR_COUNT * 2;
    this.heads = new THREE.InstancedMesh(new THREE.PlaneGeometry(.5, .32), new THREE.MeshBasicMaterial({ color: 0xfff3dc, toneMapped: false }), lampCount);
    this.tails = new THREE.InstancedMesh(new THREE.PlaneGeometry(.5, .26).rotateY(Math.PI), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), lampCount);
    const poolMaterial = glow(0xfff0d0, .32, this.texture);
    poolMaterial.polygonOffset = true; poolMaterial.polygonOffsetFactor = -2; poolMaterial.polygonOffsetUnits = -2;
    this.pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), poolMaterial, CAR_COUNT);
    for (const mesh of [this.heads, this.tails, this.pools]) { mesh.frustumCulled = false; mesh.count = 0; this.group.add(mesh); }
    this.tails.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(lampCount * 3), 3);
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

  /** Places a car on a random lane between `near` and `far` metres from the player, clear of other cars. */
  private spawn(id: number, player: THREE.Vector3, near: number, far: number, kind?: Kind): Car | undefined {
    const at = new THREE.Vector3();
    for (let attempt = 0; attempt < 240; attempt++) {
      const lane = this.lanes[Math.floor(this.random() * this.lanes.length)], s = this.random() * lane.length;
      const index = this.sample(lane, s, 0, at), distance = at.distanceTo(player);
      if (distance < near || distance > far) continue;
      if (lane.cars.some(other => Math.abs(other.s - s) < 30)) continue;
      if (lane.stops.some(stop => Math.abs(stop.s - s) < 12) || lane.zones.some(zone => s > zone.enter - 4 && s < zone.leave)) continue;
      const car: Car = { id, kind: kind ?? this.kinds[Math.floor(this.random() * this.kinds.length)], lane, s, v: lane.speed * .7, cruise: lane.speed * (.85 + this.random() * .25),
        index, braking: false, position: at.clone(), heading: this.direction(lane, s), zones: new Set(), obstacle: false, blocked: 0, drift: new THREE.Vector3() };
      lane.cars.push(car);
      return car;
    }
    return undefined;
  }
  private remove(car: Car) {
    car.lane.cars.splice(car.lane.cars.indexOf(car), 1);
    for (const zone of car.zones) { zone.cars.delete(car); if (!zone.cars.size) zone.road = undefined; }
    car.zones.clear();
  }

  // ------------------------------------------------------------------ signals
  /** 0 green, 1 yellow, 2 red, for one signal at the current time. */
  private state(signal: Signal) {
    const t = (this.time + signal.intersection.offset) % CYCLE, phase = signal.axis === 0 ? t : (t + CYCLE / 2) % CYCLE;
    return phase < GREEN ? 0 : phase < GREEN + YELLOW ? 1 : 2;
  }

  // ------------------------------------------------------------------ update
  /** Advances signals and cars by dt seconds and keeps the nearby cars solid in the player's simulation. */
  update(dt: number, sim: Simulation, player: THREE.Vector3, playerVelocity: THREE.Vector3) {
    dt = Math.min(dt, .1);
    this.time += dt;
    for (const lane of this.lanes) lane.cars.sort((a, b) => a.s - b.s);
    if (dt > 0) for (const car of [...this.cars]) this.drive(car, dt, player, playerVelocity);
    // Cars that ended their road or fell far behind are placed again near the player, out of sight distance.
    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i];
      const ended = !car.lane.closed && car.s >= car.lane.length - 1;
      if (!ended && car.position.distanceTo(player) <= KEEP_NEAR) continue;
      this.remove(car); this.release(car, sim);
      const next = this.spawn(car.id, player, 220, KEEP_NEAR * .9, car.kind);
      if (next) this.cars[i] = next; else { this.waiting.push(car.id); this.cars.splice(i, 1); i--; }
    }
    // A couple of waiting cars try again each frame, out of sight distance.
    for (let tries = 0; tries < 2 && this.waiting.length; tries++) {
      const car = this.spawn(this.waiting[0], player, 220, KEEP_NEAR * .9);
      if (!car) break;
      this.waiting.shift(); this.cars.push(car);
    }
    this.solid(sim, player);
    this.render();
  }

  private drive(car: Car, dt: number, player: THREE.Vector3, playerVelocity: THREE.Vector3) {
    const lane = car.lane, v = car.v;
    let accel = ACCEL * (1 - Math.pow(v / car.cruise, 4));
    const follow = (gap: number, leaderSpeed: number, standstill = STANDSTILL) => {
      const desired = standstill + v * HEADWAY + v * (v - leaderSpeed) / (2 * Math.sqrt(ACCEL * BRAKE));
      accel = Math.min(accel, ACCEL * (1 - Math.pow(v / car.cruise, 4) - Math.pow(Math.max(desired, 0) / Math.max(gap, .1), 2)));
    };
    // The car ahead in this lane (round a loop, the first car is behind the last one).
    const index = lane.cars.indexOf(car), ahead = lane.cars[index + 1] ?? (lane.closed && lane.cars.length > 1 ? lane.cars[0] : undefined);
    if (ahead && ahead !== car) {
      const gap = (ahead.s - car.s + (ahead.s < car.s ? lane.length : 0)) - (car.kind.front - ahead.kind.rear);
      if (gap < 150) follow(gap, ahead.v);
    }
    // Red lights, and yellow ones it can still stop for.
    const stopping = v * v / (2 * BRAKE);
    for (const stop of lane.stops) {
      const distance = stop.s - car.s - car.kind.front;
      if (distance < -1 || distance > 90) continue;
      const state = this.state(stop.signal);
      if (state === 2 || (state === 1 && distance > stopping * .8)) { follow(Math.max(distance, 0), 0, .5); break; }
    }
    // Unsignalised crossings: enter only when the crossing is empty or in use by this road.
    for (const entry of lane.zones) {
      const distance = entry.enter - car.s - car.kind.front;
      if (car.s > entry.leave) { if (car.zones.delete(entry.zone)) { entry.zone.cars.delete(car); if (!entry.zone.cars.size) entry.zone.road = undefined; } continue; }
      if (car.zones.has(entry.zone) || distance > Math.max(10, stopping + 6)) continue;
      if (!entry.zone.cars.size || entry.zone.road === lane.road) { entry.zone.road = lane.road; entry.zone.cars.add(car); car.zones.add(entry.zone); }
      else follow(Math.max(distance, 0), 0, .5);
      break;
    }
    // The player: a car (or anything) in this lane ahead is followed like any other car.
    const toPlayer = this.v3.copy(player).sub(car.position), along = toPlayer.x * car.heading.x + toPlayer.z * car.heading.z;
    const across = Math.abs(toPlayer.x * car.heading.z - toPlayer.z * car.heading.x);
    const playerAhead = along > 0 && along < 60 && across < car.kind.halfWidth + 1.6 && Math.abs(toPlayer.y) < 4;
    if (playerAhead) follow(along - car.kind.front - 2.3, Math.max(0, playerVelocity.x * car.heading.x + playerVelocity.z * car.heading.z));
    // Held up by a stopped player for a few seconds: move over to another lane going the same way, if it is clear.
    car.blocked = playerAhead && v < 1 && playerVelocity.length() < 1 ? car.blocked + dt : 0;
    if (car.blocked > 3) { car.blocked = 0; this.changeLane(car); }
    accel = Math.max(accel, -9);
    car.braking = accel < -1 || (v < .5 && accel <= 0);
    car.v = Math.max(0, v + accel * dt);
    car.s += car.v * dt;
    if (lane.closed && car.s >= lane.length) car.s -= lane.length;
    car.index = this.sample(car.lane, car.s, car.index, car.position);
    car.drift.multiplyScalar(Math.exp(-dt / .7)); car.position.add(car.drift);
    const look = this.v3, ahead2 = car.lane; this.sample(ahead2, Math.min(ahead2.closed ? car.s + 3 : ahead2.length, car.s + 3), car.index, look);
    if (ahead2.closed && car.s + 3 >= ahead2.length) this.sample(ahead2, car.s + 3 - ahead2.length, 0, look);
    const heading = look.sub(car.position); if (heading.lengthSq() > 1e-4) car.heading.copy(heading.normalize());
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
    if (this.registered !== sim) { this.registered = sim; for (const car of this.cars) car.obstacle = false; }
    for (const car of this.cars) {
      const near = car.position.distanceTo(player) < SOLID_WITHIN;
      if (!near) { this.release(car, sim); continue; }
      const h = car.kind.body.heightM, yaw = Math.atan2(car.heading.x, car.heading.z), pitch = -Math.asin(THREE.MathUtils.clamp(car.heading.y, -1, 1));
      this.q.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
      sim.setObstacle(`traffic-${car.id}`, car.kind.body, {
        p: { x: car.position.x, y: car.position.y + .25 + h * .32, z: car.position.z },
        q: { x: this.q.x, y: this.q.y, z: this.q.z, w: this.q.w },
        v: { x: car.heading.x * car.v, y: car.heading.y * car.v, z: car.heading.z * car.v },
      });
      car.obstacle = true;
    }
  }
  private release(car: Car, sim: Simulation) {
    if (car.obstacle && this.registered === sim) sim.setObstacle(`traffic-${car.id}`, car.kind.body, undefined);
    car.obstacle = false;
  }

  // ------------------------------------------------------------------ drawing
  private render() {
    const counts = new Map<Kind, number>(), m = this.matrix, q = this.q, up = new THREE.Vector3(0, 1, 0);
    let lamp = 0, pool = 0;
    for (const car of this.cars) {
      const yaw = Math.atan2(car.heading.x, car.heading.z), pitch = -Math.asin(THREE.MathUtils.clamp(car.heading.y, -1, 1));
      q.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
      const n = counts.get(car.kind) ?? 0; counts.set(car.kind, n + 1);
      car.kind.mesh.setMatrixAt(n, m.compose(car.position, q, this.scale.set(1, 1, 1)));
      const k = car.kind, x = k.halfWidth * .62;
      for (const side of [-1, 1]) {
        this.heads!.setMatrixAt(lamp, m.compose(this.v3.set(side * x, k.lampY, k.front + .03).applyQuaternion(q).add(car.position), q, this.scale));
        this.tails!.setMatrixAt(lamp, m.compose(this.v3.set(side * x, k.lampY + .1, k.rear - .03).applyQuaternion(q).add(car.position), q, this.scale));
        this.tails!.setColorAt(lamp, this.color.setRGB(car.braking ? 4 : 1.1, car.braking ? .12 : .03, car.braking ? .08 : .02));
        lamp++;
      }
      this.pools!.setMatrixAt(pool++, m.compose(this.v3.set(0, .06, k.front + 7).applyQuaternion(q).add(car.position), this.q.setFromAxisAngle(up, yaw), this.scale.set(5.5, 1, 12)));
      this.scale.set(1, 1, 1);
    }
    for (const kind of this.kinds) { kind.mesh.count = counts.get(kind) ?? 0; kind.mesh.instanceMatrix.needsUpdate = true; }
    for (const mesh of [this.heads!, this.tails!]) { mesh.count = lamp; mesh.instanceMatrix.needsUpdate = true; }
    this.tails!.instanceColor!.needsUpdate = true;
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
    this.group.traverse(object => { if (object instanceof THREE.Mesh) { object.geometry.dispose(); (object.material as THREE.Material).dispose(); } });
    this.texture.dispose();
    this.group.removeFromParent();
  }
}

/** Small seeded generator, so traffic starts the same way each visit. */
function mulberry(seed: number) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
