import * as THREE from 'three';
import type { Simulation } from '../shared/physics';
import { averageTexture, ParticlePool } from './car-damage';
import { propHits, type PropMaterial } from './race-audio';

/**
 * Breakable street props in the city: driven through, a prop is knocked flying instead of stopping the car like a
 * wall. Their solid collision is left out of the city build (design/build-city.ts, BREAKABLE there too), so here the
 * hit is found by overlap with the player's car, the placed copy is hidden, and a loose copy tumbles away under
 * gravity, settles and sinks out of sight. The car loses a little speed for each, by the prop's weight. Broken props
 * are put back after a while, only once the player is well away. Each hit also throws sparks or chips, a struck
 * hydrant gushes water for a few seconds, and the audio plays a sound for the material (propHits in race-audio).
 */

/** Which instanced venue meshes break, roughly what each weighs (kg) and what it is made of. */
const KINDS: { match: RegExp; mass: number; material: PropMaterial }[] = [
  { match: /FireHydrant/, mass: 120, material: 'water' }, { match: /UtilityBox/, mass: 90, material: 'metal' }, { match: /IndustrialBarrel/, mass: 60, material: 'metal' },
  { match: /Streetscape_TrashCan/, mass: 25, material: 'plastic' }, { match: /Streetscape_Crate/, mass: 30, material: 'wood' }, { match: /Streetscape_Container/, mass: 35, material: 'plastic' },
  { match: /Streetscape_FencePanel/, mass: 30, material: 'metal' }, { match: /Streetscape_FencePost/, mass: 15, material: 'metal' }, { match: /Streetscape_StopSign/, mass: 20, material: 'metal' },
  { match: /PP_Bench/, mass: 45, material: 'wood' }, { match: /SlalomCone/, mass: 4, material: 'plastic' },
];
const RESTORE_AFTER = 120, RESTORE_AWAY = 160, DEBRIS_LIFE = 6, MAX_DEBRIS = 40, CELL = 16;
/** Seconds a struck hydrant keeps gushing. */
const GUSH = 4.5;

type Prop = { meshes: THREE.InstancedMesh[]; index: number; matrix: THREE.Matrix4; at: THREE.Vector3; radius: number; top: number; mass: number; material: PropMaterial; color: THREE.Color; brokenAt?: number };
type Debris = { group: THREE.Group; velocity: THREE.Vector3; spin: THREE.Vector3; floor: number; age: number; sink: number };

export class CityProps {
  readonly group = new THREE.Group();
  private props: Prop[] = [];
  private grid = new Map<string, Prop[]>();
  private debris: Debris[] = [];
  private time = 0;
  private hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  /** Sparks off metal; chips of wood and plastic, and hydrant water (normal blending). */
  private sparks = new ParticlePool(160, true, -9.8, .8);
  private chips = new ParticlePool(220, false, -9.8, .6);
  private water = new ParticlePool(360, false, -9.8, .25);
  private gushes: { at: THREE.Vector3; until: number; due: number }[] = [];
  broken = 0;

  constructor(venue: THREE.Object3D) {
    this.group.name = 'apex-city-props';
    this.group.add(this.sparks.points, this.chips.points, this.water.points);
    venue.updateMatrixWorld(true);
    // A glTF node with several materials becomes a group of instanced meshes sharing one instance order.
    const owners = new Map<THREE.Object3D, THREE.InstancedMesh[]>();
    venue.traverse(object => {
      if (!(object instanceof THREE.InstancedMesh)) return;
      const prop = (o: THREE.Object3D | null) => !!o && KINDS.some(kind => kind.match.test(o.name));
      if (!prop(object) && !prop(object.parent)) return;
      const owner = prop(object.parent) ? object.parent! : object;
      (owners.get(owner) ?? owners.set(owner, []).get(owner)!).push(object);
    });
    const box = new THREE.Box3(), local = new THREE.Matrix4(), size = new THREE.Vector3(), scale = new THREE.Vector3(), q = new THREE.Quaternion();
    for (const [owner, meshes] of owners) {
      const { mass, material } = KINDS.find(kind => kind.match.test(owner.name))!;
      // Chip colour: the main material's colour, times its texture's average when it has one.
      const surface = meshes[0].material as THREE.MeshStandardMaterial, color = (surface.color?.clone() ?? new THREE.Color(.5, .5, .5));
      const average = surface.map && averageTexture(surface.map); if (average) color.multiply(average);
      box.makeEmpty(); for (const mesh of meshes) { mesh.geometry.computeBoundingBox(); box.union(mesh.geometry.boundingBox!); }
      box.getSize(size);
      for (let i = 0; i < meshes[0].count; i++) {
        meshes[0].getMatrixAt(i, local);
        const matrix = local.clone().premultiply(meshes[0].matrixWorld), at = new THREE.Vector3();
        matrix.decompose(at, q, scale);
        const prop: Prop = { meshes, index: i, matrix, at, radius: Math.max(size.x * scale.x, size.z * scale.z) / 2, top: at.y + box.max.y * scale.y, mass, material, color };
        this.props.push(prop);
        const key = `${Math.floor(at.x / CELL)},${Math.floor(at.z / CELL)}`;
        (this.grid.get(key) ?? this.grid.set(key, []).get(key)!).push(prop);
      }
    }
  }
  get count() { return this.props.length; }

  /** Breaks props the player's car overlaps, flies the debris, and puts back old breaks the player cannot see. */
  update(dt: number, sim: Simulation, player: THREE.Vector3) {
    this.time += dt;
    const car = sim.car, v = car.linvel(), speed = Math.hypot(v.x, v.z);
    if (speed > 1.5) {
      const r = car.rotation(), q = new THREE.Quaternion(r.x, r.y, r.z, r.w).invert(), d = sim.carSpec.dimensions;
      const halfLength = d.lengthM / 2, halfWidth = d.bodyWidthM / 2, local = new THREE.Vector3();
      const cx = Math.floor(player.x / CELL), cz = Math.floor(player.z / CELL);
      for (let x = cx - 1; x <= cx + 1; x++) for (let z = cz - 1; z <= cz + 1; z++) for (const prop of this.grid.get(`${x},${z}`) ?? []) {
        if (prop.brokenAt !== undefined) continue;
        local.copy(prop.at).sub(player).applyQuaternion(q);
        if (Math.abs(local.x) > halfWidth + prop.radius || Math.abs(local.z) > halfLength + prop.radius) continue;
        if (prop.top < player.y - 1.2 || prop.at.y > player.y + 1.5) continue;
        this.smash(prop, new THREE.Vector3(v.x, v.y, v.z), sim);
      }
    }
    // Put back props broken long ago, once the player is far enough not to see it happen.
    for (const prop of this.props) {
      if (prop.brokenAt === undefined || this.time - prop.brokenAt < RESTORE_AFTER || prop.at.distanceTo(player) < RESTORE_AWAY) continue;
      prop.brokenAt = undefined;
      for (const mesh of prop.meshes) { mesh.setMatrixAt(prop.index, prop.matrix); mesh.instanceMatrix.needsUpdate = true; }
    }
    this.fly(dt);
  }

  private smash(prop: Prop, carVelocity: THREE.Vector3, sim: Simulation) {
    prop.brokenAt = this.time; this.broken++;
    for (const mesh of prop.meshes) { mesh.setMatrixAt(prop.index, this.hidden); mesh.instanceMatrix.needsUpdate = true; }
    // The car pays for the hit in proportion to the prop's weight against its own - not in a street race, whose
    // replays (ghost, leaderboard, server check) cannot see the props.
    const share = Math.min(.25, prop.mass / sim.carSpec.physics.massKg * 1.6);
    if (sim.track.kind !== 'street') sim.car.setLinvel({ x: carVelocity.x * (1 - share), y: carVelocity.y, z: carVelocity.z * (1 - share) }, true);
    if (propHits.length < 16) propHits.push({ material: prop.material, speed: carVelocity.length() });
    this.bits(prop, carVelocity);
    if (this.debris.length >= MAX_DEBRIS) this.remove(this.debris.shift()!);
    const group = new THREE.Group(), at = new THREE.Vector3(), q = new THREE.Quaternion(), scale = new THREE.Vector3();
    prop.matrix.decompose(at, q, scale);
    for (const mesh of prop.meshes) { const piece = new THREE.Mesh(mesh.geometry, mesh.material); piece.castShadow = false; group.add(piece); }
    group.position.copy(at); group.quaternion.copy(q); group.scale.copy(scale);
    const light = Math.max(.6, 1.8 - prop.mass / 120), random = () => Math.random() * 2 - 1;
    const velocity = carVelocity.clone().setY(0).multiplyScalar((1.05 + Math.random() * .35) * light).add(new THREE.Vector3(random() * 2.5, 2.5 + Math.random() * 3.5 * light, random() * 2.5));
    this.debris.push({ group, velocity, spin: new THREE.Vector3(random(), random(), random()).multiplyScalar(6 * light), floor: at.y, age: 0, sink: 0 });
    this.group.add(group);
  }

  /** The spray thrown off at the hit: sparks from metal, chips from wood and plastic, and a hydrant starts to gush. */
  private bits(prop: Prop, carVelocity: THREE.Vector3) {
    const { x, z } = prop.at, y = prop.at.y + (prop.top - prop.at.y) * .5, speed = Math.min(30, carVelocity.length()), spread = () => (Math.random() - .5) * 2;
    const metal = prop.material === 'metal' || prop.material === 'water';
    for (let i = 0; i < 8 + speed * (metal ? 1.4 : .9); i++) {
      const s = .3 + Math.random() * .6, vx = carVelocity.x * s + spread() * 3.5, vy = 1 + Math.random() * 4.5, vz = carVelocity.z * s + spread() * 3.5;
      if (metal) this.sparks.emit(x, y, z, vx, vy, vz, .25 + Math.random() * .4, .08, .03, 1, .6 + Math.random() * .3, .22, 1);
      else {
        const c = prop.color, shade = .7 + Math.random() * .5;
        this.chips.emit(x + spread() * .2, y, z + spread() * .2, vx * .8, vy * .8, vz * .8, .7 + Math.random() * .8, .09 + Math.random() * .08, .07, c.r * shade, c.g * shade, c.b * shade, 1);
      }
    }
    if (prop.material === 'water') this.gushes.push({ at: new THREE.Vector3(x, prop.at.y + .3, z), until: this.time + GUSH, due: 0 });
  }

  private fly(dt: number) {
    // Hydrant jets: a column of spray, falling back as it runs out.
    for (let i = this.gushes.length - 1; i >= 0; i--) {
      const gush = this.gushes[i], left = (gush.until - this.time) / GUSH;
      if (left <= 0) { this.gushes.splice(i, 1); continue; }
      for (gush.due += dt * 70; gush.due >= 1; gush.due--) {
        const lift = (5 + Math.random() * 4) * (.4 + .6 * left), a = Math.random() * Math.PI * 2, out = .4 + Math.random() * .9;
        this.water.emit(gush.at.x, gush.at.y, gush.at.z, Math.cos(a) * out, lift, Math.sin(a) * out, .9 + Math.random() * .6, .12, .45, .72, .8, .88, .5);
      }
    }
    this.sparks.update(dt); this.chips.update(dt); this.water.update(dt);
    const turn = new THREE.Quaternion(), axis = new THREE.Vector3();
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const piece = this.debris[i]; piece.age += dt;
      if (piece.age > DEBRIS_LIFE) {
        // Settled: sink into the ground, then go.
        piece.sink += dt * .6; piece.group.position.y -= dt * .6;
        if (piece.sink > 1.5) { this.remove(piece); this.debris.splice(i, 1); }
        continue;
      }
      piece.velocity.y -= 9.81 * dt;
      piece.group.position.addScaledVector(piece.velocity, dt);
      if (piece.group.position.y < piece.floor) {
        // Ground contact: bounce a little, scrub speed and spin.
        piece.group.position.y = piece.floor;
        piece.velocity.y = Math.abs(piece.velocity.y) * .28;
        piece.velocity.x *= .72; piece.velocity.z *= .72; piece.spin.multiplyScalar(.6);
        if (Math.abs(piece.velocity.y) < .4) piece.velocity.y = 0;
      }
      const rate = piece.spin.length();
      if (rate > .05) { turn.setFromAxisAngle(axis.copy(piece.spin).divideScalar(rate), rate * dt); piece.group.quaternion.premultiply(turn); }
    }
  }
  private remove(piece: Debris) { this.group.remove(piece.group); }

  dispose() { this.group.removeFromParent(); this.debris = []; this.sparks.dispose(); this.chips.dispose(); this.water.dispose(); }
}
