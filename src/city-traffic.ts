import * as THREE from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { assetUrl } from '../shared/assets';
import type { Simulation } from '../shared/physics';
import type { Track } from '../shared/tracks';
import type { RaceCar } from '../shared/race-traffic';
import { CITY_ROADS, CITY_SIGNAL_POLES } from '../shared/city.data';
import { TrafficSim, type Car as SimCar, type Driver, type SimKind } from '../shared/city-traffic-sim';
import { CityProps } from './city-props';
import { CityRaceScene } from './city-race';

/**
 * City traffic in the game: draws the cars and signals of a traffic simulation (shared/city-traffic-sim.ts) and makes
 * the cars near the player solid in the player's physics world. Alone, this machine runs the simulation; in a city
 * party the server runs it (shared/city-party-traffic.ts) and this one follows its updates (`follow`), carrying the
 * cars on between them and easing out the differences, and reports the cars the player knocks.
 *
 * Everything is drawn as instanced batches: per vehicle kind, one per body material, one each for its head and brake
 * lamps (self-lit, brake lamps brightening per car) and one per wheel material for its front and rear wheels, which
 * spin with the distance driven and steer with the lane's curve. Lamp pools, signal bulbs and glows are one batch each.
 */

/** Where a wheel sits on its car, and whether it steers and which side it is on (right wheels are the left one turned round). */
type WheelSlot = { at: THREE.Vector3; front: boolean; right: boolean };
type Kind = SimKind & {
  /** Instanced batches: body parts, lamps (with a per-car colour) and front/rear wheels; and the far version, a
   * simplified body with its wheels fixed in place. */
  parts: THREE.InstancedMesh[]; heads: THREE.InstancedMesh[]; tails: THREE.InstancedMesh[]; frontWheels: THREE.InstancedMesh[]; rearWheels: THREE.InstancedMesh[];
  far: THREE.InstancedMesh[];
  slots: WheelSlot[];
};
type Car = SimCar & { kind: Kind };
/** A car the player knocked, as reported to the city party server: its id and its stand-in's pose and motion. */
export type TrafficKnock = { id: number; p: { x: number; z: number }; q: { x: number; y: number; z: number; w: number }; v: { x: number; z: number }; w: { y: number } };
/** What the party server sends: when (server clock), the cars near this driver, the signals; `handoff` when it stops. */
export type TrafficPacket = { at: number; cars: number[][]; signals: number[]; handoff?: boolean; seed?: boolean };
/** How often each kind turns up, relative to an ordinary car. */
const KIND_WEIGHT: Record<string, number> = { 'lct-3000-07': .45, 'lightbody-90-md-utility': .7 };
const KIND_MASS: Record<string, number> = { 'lct-3000-07': 4200, 'lightbody-90-md-utility': 2400 };
/** Cars further than this, or off screen, are not drawn. */
const DRAW_WITHIN = 480;
/** Cars nearer than this are drawn in full (spinning, steering wheels); further ones as a simplified shell. */
const DETAIL_WITHIN = 75;
/** Upper bound on cars across the whole city (and the size of each instanced batch). */
const MAX_CARS = 460;
/** Only cars this close are solid to the player's car. */
const SOLID_WITHIN = 110;
/** A hit that changes a car's speed by more than this (m/s) knocks it out of its lane. */
const WRECK_HIT = 2.2;
/** A city party car the server stops mentioning (out of range) is taken away after this long (s). */
const FORGET_AFTER = 1.5;

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
  /** The traffic simulation: run here alone, or following the city party server's. */
  traffic!: TrafficSim;
  private kinds: Kind[] = [];
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
  /** City party: following the server's traffic (since the last packet), and the knocks to report to it. */
  private networked = false;
  private knocks: TrafficKnock[] = [];

  private constructor() { this.group.name = 'apex-city-traffic'; }

  /** Loads the vehicles, builds the traffic from the road data and places the cars. */
  static async create(venue: THREE.Object3D, loader: GLTFLoader, player: THREE.Vector3) {
    const traffic = new CityTraffic();
    const [gltf, simplifier, police] = await Promise.all([
      loader.loadAsync(assetUrl('models/traffic/traffic-cars.glb')),
      import('meshoptimizer').then(async ({ MeshoptSimplifier }) => { await MeshoptSimplifier.ready; return MeshoptSimplifier.supported ? MeshoptSimplifier : undefined; }).catch(() => undefined),
      loader.loadAsync(assetUrl('models/traffic/police-cars.glb')).catch(error => { console.warn('Police cars unavailable.', error); return undefined; }),
    ]);
    traffic.props = new CityProps(venue); traffic.group.add(traffic.props.group);
    traffic.buildKinds(gltf.scene, simplifier);
    traffic.traffic = new TrafficSim(CITY_ROADS, CITY_SIGNAL_POLES, traffic.kinds);
    traffic.traffic.seen = at => traffic.visible(at);
    traffic.traffic.onRetire = car => { if (traffic.registered) traffic.release(car as Car, traffic.registered); };
    if (police) traffic.race.build(police.scene);
    traffic.group.add(traffic.race.group);
    traffic.buildLamps();
    traffic.traffic.populate([{ position: player, velocity: new THREE.Vector3() }]);
    traffic.render();
    return traffic;
  }
  private get cars() { return this.traffic.cars as Car[]; }
  private get signals() { return this.traffic.signals; }
  /** Counters for tuning (see TrafficSim). */
  get wrecks() { return this.traffic.wrecks; }

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

  private get eye() { return this.camera ? this.eyePosition.setFromMatrixPosition(this.camera.matrixWorld) : this.eyePosition; }
  private eyePosition = new THREE.Vector3();
  /** Whether a point could be on screen: within drawing range and in the camera's view. */
  private visible(at: THREE.Vector3) { return !!this.camera && at.distanceTo(this.eye) < DRAW_WITHIN && this.frustum.intersectsSphere(new THREE.Sphere(at, 5)); }
  // ------------------------------------------------------------------ update
  /** Advances signals and cars by dt seconds and keeps the nearby cars solid in the player's simulation. */
  update(dt: number, sim: Simulation, player: THREE.Vector3, playerVelocity: THREE.Vector3) {
    dt = Math.min(dt, .1);
    const street = sim.track.kind === 'street' ? sim.track : undefined;
    if (street !== this.closedFor) this.close(street, sim);
    this.race.update(dt, this.camera ? this.eye : undefined);
    if (this.camera) { this.camera.updateMatrixWorld(); this.frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse)); }
    // Following the party server: cars carry on between its updates (no cars added or taken away here).
    this.traffic.spawning = !this.networked;
    const drivers: Driver[] = [{ position: player, velocity: playerVelocity }];
    this.traffic.step(dt, drivers);
    if (this.networked) this.traffic.forget(this.traffic.time - FORGET_AFTER);
    this.solid(sim, player);
    if (dt > 0) this.props?.update(dt, sim, player);
    this.syncPuppets(sim);
    this.race.showGates(sim, this.camera ? this.eye : undefined);
    this.render();
  }

  // ------------------------------------------------------------------ city party
  /**
   * A city party server update: from now on this machine follows the server's traffic, until a `handoff` (the party
   * is down to this driver), when it carries on running it alone from where it is. `age` is how old the packet is (s).
   */
  follow(packet: TrafficPacket, age: number) {
    if (packet.handoff) { this.networked = false; return; }
    this.networked = true;
    for (const record of packet.cars) this.traffic.apply(record, Math.max(0, Math.min(1, age)));
    if (packet.signals.length) this.traffic.applySignals(packet.signals);
  }
  /** Runs the traffic here again (away from a city party's server for a while). */
  standalone() { this.networked = false; }
  /** Whether this machine is following a party server's traffic. */
  get following() { return this.networked; }
  /** The cars near the player, to start the party server's traffic from (so nothing changes when it takes over). */
  seed(player: THREE.Vector3, within = 350) { return this.cars.filter(car => car.position.distanceTo(player) < within).map(car => this.traffic.record(car)); }
  /** Knocks to report to the party server since the last call. */
  takeKnocks() { return this.knocks.splice(0); }

  /** Registers nearby cars as stand-ins in the player's physics world, and removes the rest. */
  private solid(sim: Simulation, player: THREE.Vector3) {
    // A street race's simulation has its own traffic; free-roam cars there are scenery, never solid (replays must
    // not depend on them), and recovery goes back to the last checkpoint.
    if (sim.track.kind === 'street') { if (this.registered !== sim) { this.registered = sim; for (const car of this.cars) car.obstacle = false; } return; }
    if (this.registered !== sim) { this.registered = sim; for (const car of this.cars) car.obstacle = false; sim.recoverPoint = at => this.traffic.roadside(at); }
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
   * Whether the player just hit this car: its stand-in in the physics world moving well off the speed it was given.
   * The physics has already shared out the momentum by mass, so the stand-in's velocity is the shove (see
   * TrafficSim.applyKnock). In a city party the knock is shown at once and reported to the server.
   */
  private knocked(car: Car, sim: Simulation, player: THREE.Vector3) {
    // Only with the player's car against it (the stand-in also strays a little on its own as it is steered).
    const to = this.v3.copy(player).sub(car.position), along = Math.abs(to.x * car.heading.x + to.z * car.heading.z), across = Math.abs(to.x * car.heading.z - to.z * car.heading.x);
    if (along > car.kind.body.lengthM / 2 + 3 || across > car.kind.halfWidth + 2.2 || (car.wreck && this.traffic.time - car.wreck.hitAt < .3)) return;
    const state = sim.obstacleState(`traffic-${car.id}`); if (!state) return;
    const given = car.wreck ? car.wreck.velocity : this.v3.copy(car.heading).multiplyScalar(car.v);
    if (Math.hypot(state.v.x - given.x, state.v.z - given.z) < WRECK_HIT) return;
    this.traffic.applyKnock(car, state);
    if (this.networked && this.knocks.length < 8) this.knocks.push({ id: car.id, p: { x: state.p.x, z: state.p.z }, q: { x: state.q.x, y: state.q.y, z: state.q.z, w: state.q.w }, v: { x: state.v.x, z: state.v.z }, w: { y: state.w.y } });
  }
  /** Closes a street race's route to free-roam traffic, or opens it again (see TrafficSim.close). */
  private close(race: Track | undefined, sim: Simulation) {
    this.closedFor = race; this.race.show(race); this.puppets.clear();
    // The simulation changed with it (the old one is gone): its stand-ins went with it, and solid() registers anew.
    if (this.registered !== sim) for (const car of this.cars) car.obstacle = false;
    this.traffic.close(race?.street);
  }
  /** The race's own cars (shared/race-traffic.ts), copied into drawable cars each frame. */
  private syncPuppets(sim: Simulation) {
    const cars = sim.raceTraffic?.cars; if (!cars) return;
    for (const raceCar of cars) {
      let car = this.puppets.get(raceCar);
      if (raceCar.parked) { if (car) this.puppets.delete(raceCar); continue; }
      const kind = this.kinds.find(k => k.name === raceCar.kind.id); if (!kind) continue;
      if (!car) {
        car = { id: -1 - raceCar.id, kind, lane: this.traffic.lanes[0], s: 0, v: 0, index: 0, braking: false, temper: 1, position: new THREE.Vector3(), heading: new THREE.Vector3(), zones: new Set(), obstacle: false,
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
      const hazard = car.wreck && Math.floor(this.traffic.time * 2.6) % 2 === 0;
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
      const lit = 2 - this.traffic.state(signal); // bulb 0 red (top), 1 yellow, 2 green
      for (let bulb = 0; bulb < 3; bulb++) this.bulbs!.setColorAt(i * 3 + bulb, this.color.copy(colors[bulb]).multiplyScalar(bulb === lit ? 1 : dim));
      this.bulbGlows!.setColorAt(i, this.color.copy(colors[lit]).multiplyScalar(.35));
      this.v3.set(-1.58, 3.88 - lit * .27, .25).applyMatrix4(signal.matrix);
      this.bulbGlows!.setMatrixAt(i, m.compose(this.v3, q.setFromRotationMatrix(new THREE.Matrix4().extractRotation(signal.matrix)), this.scale.set(1.6, 1.6, 1.6)));
      this.scale.set(1, 1, 1);
    });
    this.bulbs.instanceColor!.needsUpdate = true; this.bulbGlows.instanceColor!.needsUpdate = true; this.bulbGlows.instanceMatrix.needsUpdate = true;
  }

  /** Signal states for the map: position and 0 green, 1 yellow, 2 red. */
  signalStates() { return this.signals.map(signal => ({ at: new THREE.Vector3().setFromMatrixPosition(signal.matrix), state: this.traffic.state(signal) })); }

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
