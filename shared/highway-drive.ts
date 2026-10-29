/**
 * The Endless Highway inside the simulation: streams the road's colliders in and out around the car, keeps the
 * physics world near the origin, runs the traffic, measures the distance driven and decides when a run has crashed.
 * Everything happens at fixed points in the tick from the run's state alone, so a run replays exactly.
 *
 * Floating origin: Rapier works in 32-bit floats, which lose millimetres a few kilometres out. The simulation works
 * in a local frame; `origin` (absolute, float64) is where that frame's zero is. When the car is more than SHIFT_AT
 * metres from it, everything in the world moves back by a whole multiple of 256 m (exact in float32) and
 * `originVersion` counts up, so the renderer can follow.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { CHUNK, HighwayRoad, LANE_INNER, LANE_OUTER, LANE_WIDTH, MEDIAN_HALF, MEDIAN_HEIGHT, RAIL, RAIL_HEIGHT, ROAD_EDGE, SAMPLES, STEP, laneCentre, pointOn, type HighwaySample } from './highway';
import { HighwayTraffic, type HighwayConfig, type TrafficHost } from './highway-traffic';
import type { Gate, Quat, Vec3 } from './tracks';

/** Chunks kept loaded behind and ahead of the car's chunk. */
const KEEP_BEHIND = 2, KEEP_AHEAD = 5;
const SHIFT_AT = 3000, SHIFT_GRID = 256;
/** Ground the physics needs beside the road: the verge and a strip of desert, in case a car goes over the rail. */
const TERRAIN_COLUMNS = [RAIL + 1.5, RAIL + 4, RAIL + 7, RAIL + 12, RAIL + 20, RAIL + 32, RAIL + 50];
/**
 * Crash rule (survival): after a hit, the run is over if, within CRASH_SPEED_TICKS, the car's speed along the road
 * fell by both CRASH_LOSS_SHARE of what it was and CRASH_LOSS_MPS; or if within CRASH_WINDOW_TICKS it was turned more
 * than CRASH_TURN from the road's direction, or rolled past CRASH_UP. A skim along a rail or a car barely slows it.
 */
export const CRASH_LOSS_SHARE = .4, CRASH_LOSS_MPS = 12, CRASH_TURN = 70 * Math.PI / 180, CRASH_UP = .35;
const CRASH_SPEED_TICKS = 24, CRASH_WINDOW_TICKS = 72;
/**
 * Too slow (survival): traffic always gives way to the player, so crawling along would be safe for ever. Once the rule
 * is armed - the car first reaching SLOW_ARM_MPS, or SLOW_ARM_TICKS after the start or a recovery - running below
 * SLOW_MPS along the road (40 mph; backwards counts) for SLOW_LIMIT_TICKS ends the run.
 */
export const SLOW_MPS = 40 * .44704, SLOW_LIMIT_TICKS = 5 * 60;
const SLOW_ARM_MPS = 45 * .44704, SLOW_ARM_TICKS = 15 * 60;

/** Group masks, as the simulation sets them (see GROUP in shared/physics.ts). */
export type HighwayGroups = { floor: number; wall: number };
type Host = TrafficHost & {
  world: RAPIER.World; car: RAPIER.RigidBody;
  /** Collider handle → surface (0 road, 2 sand) for tyre grip and audio. */
  colliderSurfaces: Map<number, number>;
  /** Moves a physics stand-in (traffic, party cars) by the origin shift. */
  shiftObstacles(dx: number, dy: number, dz: number): void;
};
type Chunk = { index: number; body: RAPIER.RigidBody; origin: Vec3 };

const yawQuat = (yaw: number): Quat => ({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) });

export class HighwayDrive {
  readonly road: HighwayRoad;
  traffic: HighwayTraffic;
  /** Absolute position of the physics world's zero, and a counter bumped on every shift. */
  readonly origin = { x: 0, y: 0, z: 0 };
  originVersion = 0;
  /**
   * Where the car is along the road and across it; the furthest point it has reached; and the metres counted towards
   * the run. Survival counts only new ground covered with the car's centre in a lane: the shoulders (out by the
   * guardrail, or the strip by the median) are free of traffic, so ground gained on them never counts, even after
   * moving back into a lane. Cruise counts everything (it is an odometer).
   */
  s: number; lat = 0; private startS: number; private furthest: number; private counted = 0;
  /** The car's centre is on a shoulder, outside the lanes (Survival is not counting). */
  onShoulder = false;
  /** Speed along the road (m/s; negative driving the wrong way). */
  along = 0;
  /** Survival: the tick the run crashed (undefined while it goes on), and why. */
  crashedAt?: number; crashReason?: 'impact' | 'spin' | 'roll' | 'slow';
  /** Survival: ticks spent below SLOW_MPS since the rule armed (0 when quick enough); see SLOW_LIMIT_TICKS. */
  slowTicks = 0;
  private slowArmed = false; private graceFrom = 0; private seenRespawns = 0;
  private chunks = new Map<number, Chunk>();
  /** Recent speeds along the road, newest last, for the speed before a hit. */
  private speeds: number[] = [];
  private seenHits = 0; private hitTick = -Infinity; private hitSpeed = 0;

  private startLane: number;
  constructor(readonly config: HighwayConfig, private groups: HighwayGroups) {
    this.road = new HighwayRoad(config.seed);
    const startS = config.start?.s ?? 120; this.startLane = config.start?.lane ?? 1;
    this.s = this.startS = this.furthest = startS;
    const p = this.road.lanePose(startS, this.startLane);
    this.traffic = new HighwayTraffic(this.road, config, { s: startS, lat: laneCentre(this.startLane), x: p.x, y: p.y, z: p.z, along: 0 });
  }
  get distance() { return this.counted; }
  get survival() { return this.config.mode === 'survival'; }

  /** The run's start: the middle lane facing along the road. */
  spawnGate(): Gate {
    const pose = this.road.lanePose(this.startS, this.startLane), forward = { x: Math.sin(pose.heading), y: 0, z: Math.cos(pose.heading) };
    return { position: { x: pose.x - this.origin.x, y: pose.y - this.origin.y, z: pose.z - this.origin.z }, forward, rotation: yawQuat(pose.heading), width: LANE_WIDTH, segment: 0 };
  }
  /** Where a car in trouble is put back: its own carriageway's nearest lane, at the same distance along. */
  recoverGate(at: Vec3): Gate {
    const absolute = this.road.project(at.x + this.origin.x, at.z + this.origin.z, this.s, 80);
    const lane = absolute.lat >= 0 ? (absolute.lat > laneCentre(2) ? 2 : absolute.lat > laneCentre(1) - LANE_WIDTH / 2 ? 1 : 0) : (absolute.lat < laneCentre(5) ? 5 : absolute.lat < laneCentre(4) + LANE_WIDTH / 2 ? 4 : 3);
    const pose = this.road.lanePose(absolute.s, lane), forward = { x: Math.sin(pose.heading), y: 0, z: Math.cos(pose.heading) };
    return { position: { x: pose.x - this.origin.x, y: pose.y - this.origin.y, z: pose.z - this.origin.z }, forward, rotation: yawQuat(pose.heading), width: LANE_WIDTH, segment: 0 };
  }

  /** Start of a tick, before the car's forces: shift the origin if due, and stream chunks around the car. */
  prepare(host: Host) {
    const p = host.car.translation();
    if (Math.abs(p.x) > SHIFT_AT || Math.abs(p.z) > SHIFT_AT) this.shift(host, Math.round(p.x / SHIFT_GRID) * SHIFT_GRID, Math.round(p.z / SHIFT_GRID) * SHIFT_GRID);
    this.stream(host);
  }
  /** Loads the chunks around the car's position along the road and unloads the rest. */
  stream(host: Host) {
    const centre = this.road.indexOf(this.s);
    for (const [index, chunk] of this.chunks) if (index < centre - KEEP_BEHIND || index > centre + KEEP_AHEAD) {
      for (let i = chunk.body.numColliders() - 1; i >= 0; i--) host.colliderSurfaces.delete(chunk.body.collider(i).handle);
      host.world.removeRigidBody(chunk.body); this.chunks.delete(index);
    }
    for (let index = centre - KEEP_BEHIND; index <= centre + KEEP_AHEAD; index++) if (!this.chunks.has(index)) this.build(host, index);
    this.road.release(centre - KEEP_BEHIND - 2, centre + KEEP_AHEAD + 10);
  }
  /** Traffic for this tick (before the world steps), from where the car is along the road. */
  stepTraffic(host: Host) {
    const p = host.car.translation(), v = host.car.linvel(), x = p.x + this.origin.x, z = p.z + this.origin.z;
    const at = this.road.project(x, z, this.s, 40);
    this.s = at.s; this.lat = at.lat;
    const h = this.road.heading(at.s);
    this.along = v.x * Math.sin(h) + v.z * Math.cos(h);
    if (this.traffic.config.traffic.density > 0 || this.survival || this.traffic.settings.density > 0)
      this.traffic.step(host, { s: at.s, lat: at.lat, x, y: p.y + this.origin.y, z, along: this.along }, this.origin, this.distance);
  }
  /**
   * End of a tick, after the world stepped: the furthest point reached, and (survival) whether a hit has ended the run.
   * Returns true when the car has fallen far below the road and must be recovered.
   */
  finish(host: Host & { hitCount: number; ticks: number; respawns: number }) {
    const p = host.car.translation();
    const across = Math.abs(this.lat);
    this.onShoulder = across < LANE_INNER || across > LANE_OUTER;
    if (this.s > this.furthest) { if (!this.survival || !this.onShoulder) this.counted += this.s - this.furthest; this.furthest = this.s; }
    this.speeds.push(this.along); if (this.speeds.length > 12) this.speeds.shift();
    if (this.survival && this.crashedAt === undefined) {
      if (host.hitCount !== this.seenHits) {
        this.seenHits = host.hitCount; this.hitTick = host.ticks;
        // The speed just before the contact: the fastest of the last few ticks (the hit may land a tick before it counts).
        this.hitSpeed = this.speeds.slice(0, -1).reduce((fastest, speed) => Math.abs(speed) > Math.abs(fastest) ? speed : fastest, this.speeds[0]);
      }
      const since = host.ticks - this.hitTick;
      if (since <= CRASH_WINDOW_TICKS) {
        const lost = (this.hitSpeed - this.along) * Math.sign(this.hitSpeed);
        const q = host.car.rotation(), up = 1 - 2 * (q.x * q.x + q.z * q.z);
        const forwardX = 2 * (q.x * q.z + q.w * q.y), forwardZ = 1 - 2 * (q.x * q.x + q.y * q.y);
        const h = this.road.heading(this.s), off = Math.abs(Math.atan2(Math.sin(Math.atan2(forwardX, forwardZ) - h), Math.cos(Math.atan2(forwardX, forwardZ) - h)));
        const facing = this.hitSpeed >= 0 ? off : Math.PI - off;
        if (since <= CRASH_SPEED_TICKS && lost >= CRASH_LOSS_MPS && lost >= Math.abs(this.hitSpeed) * CRASH_LOSS_SHARE) this.crash(host.ticks, 'impact');
        else if (up < CRASH_UP) this.crash(host.ticks, 'roll');
        else if (facing > CRASH_TURN && Math.abs(this.hitSpeed) > 8) this.crash(host.ticks, 'spin');
      }
      // A recovery puts the car back at a standstill: the slow rule waits again until it is up to speed.
      if (host.respawns !== this.seenRespawns) { this.seenRespawns = host.respawns; this.slowArmed = false; this.graceFrom = host.ticks; this.slowTicks = 0; }
      if (!this.slowArmed && (this.along >= SLOW_ARM_MPS || host.ticks - this.graceFrom >= SLOW_ARM_TICKS)) this.slowArmed = true;
      this.slowTicks = this.slowArmed && this.along < SLOW_MPS ? this.slowTicks + 1 : 0;
      if (this.crashedAt === undefined && this.slowTicks >= SLOW_LIMIT_TICKS) this.crash(host.ticks, 'slow');
    }
    return p.y + this.origin.y < this.road.ground(this.s, this.lat) - 15;
  }
  private crash(tick: number, reason: NonNullable<HighwayDrive['crashReason']>) { this.crashedAt = tick; this.crashReason = reason; }

  /** Moves the physics world back by (dx, 0, dz): the car, the road's chunks and every stand-in. */
  private shift(host: Host, dx: number, dz: number) {
    const p = host.car.translation();
    host.car.setTranslation({ x: p.x - dx, y: p.y, z: p.z - dz }, true);
    for (const chunk of this.chunks.values()) { const t = chunk.body.translation(); chunk.body.setTranslation({ x: t.x - dx, y: t.y, z: t.z - dz }, true); }
    host.shiftObstacles(dx, 0, dz);
    this.origin.x += dx; this.origin.z += dz; this.originVersion++;
  }

  /**
   * One chunk's colliders on a fixed body at the chunk's first sample: the paved road out to the rails, the verge and
   * desert either side, the guardrails and the median barrier as solid boxes.
   */
  private build(host: Host, index: number) {
    const chunk = this.road.chunk(index), first = chunk.samples[0];
    const origin = { x: first.x, y: first.y, z: first.z };
    const body = host.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(origin.x - this.origin.x, origin.y - this.origin.y, origin.z - this.origin.z));
    const local = (sample: HighwaySample, lat: number, y?: number) => {
      const p = pointOn(sample, lat);
      return [p.x - origin.x, (y ?? p.y) - origin.y, p.z - origin.z];
    };
    const ribbon = (columns: number[], height?: (sample: HighwaySample, lat: number) => number) => {
      const vertices = new Float32Array(SAMPLES * columns.length * 3), indices: number[] = [];
      chunk.samples.forEach((sample, k) => columns.forEach((lat, c) => vertices.set(local(sample, lat, height?.(sample, lat)), (k * columns.length + c) * 3)));
      for (let k = 0; k < SAMPLES - 1; k++) for (let c = 0; c < columns.length - 1; c++) {
        const a = k * columns.length + c, b = a + columns.length;
        indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
      return { vertices, indices: new Uint32Array(indices) };
    };
    const floor = (mesh: { vertices: Float32Array; indices: Uint32Array }, surface: number, friction: number) => {
      // Winding: every face must point up for the wheel rays; flip any that do not (the columns' order decides it).
      const collider = host.world.createCollider(RAPIER.ColliderDesc.trimesh(mesh.vertices, upward(mesh.vertices, mesh.indices), RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES)
        .setFriction(friction).setCollisionGroups(this.groups.floor), body);
      host.colliderSurfaces.set(collider.handle, surface);
    };
    floor(ribbon([-RAIL - 1.5, -ROAD_EDGE, 0, ROAD_EDGE, RAIL + 1.5]), 0, .84);
    for (const side of [-1, 1]) floor(ribbon(TERRAIN_COLUMNS.map(lat => side * lat), (sample, lat) => this.road.ground(sample.s, lat)), 2, .45);
    // Rails and median: boxes along the chords between samples two apart (10 m), overlapping a little at the joints.
    const wall = (sample: HighwaySample, next: HighwaySample, lat: number, halfWidth: number, height: number, sink: number) => {
      const a = local(sample, lat), b = local(next, lat), length = Math.hypot(b[0] - a[0], b[2] - a[2]);
      const yaw = Math.atan2(b[0] - a[0], b[2] - a[2]), mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      host.world.createCollider(RAPIER.ColliderDesc.cuboid(halfWidth, (height + sink) / 2, length / 2 + .15).setTranslation(mid[0], mid[1] + (height - sink) / 2, mid[2])
        .setRotation(yawQuat(yaw)).setFriction(.3).setRestitution(0).setCollisionGroups(this.groups.wall), body);
    };
    for (let k = 0; k + 2 < SAMPLES; k += 2) {
      const a = chunk.samples[k], b = chunk.samples[k + 2];
      wall(a, b, 0, MEDIAN_HALF, MEDIAN_HEIGHT, .3);
      // The rails' boxes reach out behind the beam, so a car glancing off one meets a wide face, not an edge.
      for (const side of [-1, 1]) wall(a, b, side * (RAIL + .25), .3, RAIL_HEIGHT, .3);
    }
    this.chunks.set(index, { index, body, origin });
  }
}

/** Index buffer with every triangle turned to face up (+y). */
function upward(vertices: Float32Array, indices: Uint32Array) {
  const out = indices.slice();
  for (let i = 0; i < out.length; i += 3) {
    const a = out[i] * 3, b = out[i + 1] * 3, c = out[i + 2] * 3;
    const ux = vertices[b] - vertices[a], uz = vertices[b + 2] - vertices[a + 2], wx = vertices[c] - vertices[a], wz = vertices[c + 2] - vertices[a + 2];
    if (uz * wx - ux * wz < 0) { out[i + 1] = indices[i + 2]; out[i + 2] = indices[i + 1]; }
  }
  return out;
}
export { STEP, CHUNK };
