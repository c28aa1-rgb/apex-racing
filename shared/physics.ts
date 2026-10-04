import { assetUrl } from './assets';
import RAPIER from '@dimforge/rapier3d-compat';
import { direction, orientation, spawnGate, type Track, type Gate, type Vec3, type Quat } from './tracks';
import { buildRoadMesh } from './road';
import { fittedGates, insideGate, type FittedGate } from './gates';
import { carById, DEFAULT_CAR, type CarDefinition, type CarId } from './cars';
import { engineState, automaticGear, TRANSMISSIONS } from './transmission';
import { CONE_PENALTY_MS, CONE_RADIUS, type LotLayout } from './lot';

import { DT, MAX_TICKS } from './physics-version';
export { PHYSICS_VERSION, DT, MAX_TICKS } from './physics-version';
/** Where a Cone Attack run begins: wherever the car stopped inside the start box. Part of the run, so replays start in the same place. */
export type RunOrigin = { x: number; z: number; heading: number };
export const Input = { Throttle: 1, Brake: 2, Left: 4, Right: 8, Drift: 16, Respawn: 32, Flip: 64, ShiftUp:128, ShiftDown:256 } as const;
let ready: Promise<void> | undefined;
type CollisionMesh = { vertices: Float32Array; indices: Uint32Array; surfaces: Uint8Array };
const collisionMeshes = new Map<string, CollisionMesh>();
const collisionLoads = new Map<string, Promise<void>>();
const supportSkinCache = new WeakMap<Track,{route:string;vertices:Float32Array;indices:Uint32Array}>();
/** Smooth wheel-support skin: how far it extends past the authored lane, its lateral resolution, and the along-road smoothing radius (metres). */
const SKIN = { margin: 9, step: 2.2, radius: 24, lift: .07 };
/**
 * Collision groups (membership << 16 | filter). Where the smooth skin exists, the chassis ignores the raw
 * venue floor and rests instead on a smooth solid copy of the skin (chassisFloor), so the body can never
 * dig into seams or the crease where banking meets flat asphalt. Walls and everything off the skin are unchanged.
 */
const GROUP = { floor: 0x0002, chassis: 0x0004, chassisFloor: 0x0008 };
const groups = (member: number, filter: number) => ((member << 16) | filter) >>> 0;
/** Every scene query ignores the chassis-only floor. */
const QUERY_GROUPS = groups(0xffff, 0xffff & ~GROUP.chassisFloor);
/** Ride: suspension spring and damping per wheel, and how much vertical/tilt chatter the chassis filter removes on the road. */
const RIDE = { stiffness: 19, compression: 11.5, relaxation: 13, vertical: .82, tilt: .82 };
// One layout at a time: a venue snapshot is tens of megabytes.
let staticWorld: { key: string; snapshot: Uint8Array; surfaces: [number, number][]; support: number[]; route: Track['segments'] } | undefined;
/** Everything the static colliders are built from. */
const staticWorldKey = (track: Track) => JSON.stringify([track.id, !!collisionMeshes.get(track.id), track.segments, track.spawn ?? null, track.mapPath ?? null]);
async function loadCollision(track: Track) {
  if (!track.collision || collisionMeshes.has(track.id)) return;
  const existing = collisionLoads.get(track.id); if (existing) return existing;
  const loading = (async () => {
    let buffer: ArrayBuffer;
    if (typeof window !== 'undefined') {
      const response = await fetch(assetUrl(`models/tracks/${track.collision}`));
      if (!response.ok) throw new Error(`Could not load collision mesh for ${track.name}.`);
      buffer = await response.arrayBuffer();
    } else {
      const moduleName = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ moduleName);
      // Keep the public asset lookup relative to this module without making
      // Vite treat the server-only collision binaries as client bundle assets.
      const projectRoot = new URL(/* @vite-ignore */ '../', import.meta.url);
      const bytes = await readFile(new URL(`public/models/tracks/${track.collision}`, projectRoot));
      buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    }
    const view = new DataView(buffer);
    if (new TextDecoder().decode(new Uint8Array(buffer, 0, 8)) !== 'APEXCOL2') throw new Error(`Invalid collision mesh for ${track.name}. Rebuild model collisions.`);
    const vertexCount = view.getUint32(8, true), indexCount = view.getUint32(12, true);
    const vertices = new Float32Array(buffer, 16, vertexCount * 3);
    const sourceIndices = new Uint32Array(buffer, 16 + vertexCount * 12, indexCount);
    const surfaces = new Uint8Array(buffer, 16 + vertexCount * 12 + indexCount * 4, indexCount / 3);
    collisionMeshes.set(track.id, { vertices, indices: sourceIndices, surfaces });
  })();
  collisionLoads.set(track.id, loading);
  try { await loading; } finally { collisionLoads.delete(track.id); }
}
export async function initPhysics(tracks?: Track | Track[]) {
  await (ready ??= RAPIER.init());
  if (tracks) await Promise.all((Array.isArray(tracks) ? tracks : [tracks]).map(loadCollision));
}
export async function collisionGeometry(track: Track) {
  await loadCollision(track);
  const geometry = collisionMeshes.get(track.id);
  if (!geometry) throw new Error(`Missing physical geometry for ${track.name}.`);
  return geometry;
}
export type Frame = { p: Vec3; q: Quat };
export function rotate(q: Quat, a: Vec3): Vec3 {
  const tx = 2 * (q.y * a.z - q.z * a.y), ty = 2 * (q.z * a.x - q.x * a.z), tz = 2 * (q.x * a.y - q.y * a.x);
  return { x: a.x + q.w * tx + q.y * tz - q.z * ty, y: a.y + q.w * ty + q.z * tx - q.x * tz, z: a.z + q.w * tz + q.x * ty - q.y * tx };
}
export function steeringLock(steerAngle: number, speedMps: number, wheelbaseM=2.7, corneringAcceleration=14) {
  const speedBlend = Math.max(0, Math.min(1, (speedMps - 5) / 45));
  const easedSpeed = speedBlend * speedBlend * (3 - 2 * speedBlend);
  const precisionLock=steerAngle * (.58 + (.10 - .58) * easedSpeed);
  // Full keyboard lock must describe a wider radius as speed rises. The former
  // constant high-speed angle demanded ever-increasing lateral acceleration.
  const gripLock=Math.atan(wheelbaseM*corneringAcceleration/Math.max(1,speedMps*speedMps));
  const lock=precisionLock/Math.pow(1+Math.pow(precisionLock/gripLock,4),.25);
  return { lock, speedBlend: easedSpeed };
}
/** Load-based rear breakaway; Shift adds slip, not an abrupt wheel lock. */
export function rearSlipDemand(speedMps:number,steeringLoad:number,throttle:number,brake:number,manual:boolean,driftStrength=1) {
  const load=Math.max(0,Math.min(1,steeringLoad));
  const amount=Math.max(0,Math.min(2,driftStrength));
  const cornerDemand=Math.min(.78,Math.max(0,(speedMps-9)/40))*Math.pow(load,.85)*(.8+throttle*.2)*(1-brake*.8)*amount;
  const speed=Math.max(0,Math.min(1,(speedMps-4)/24));
  const extra=manual?.42*amount*speed*speed*(3-2*speed)*Math.pow(load,1.15)*(1-brake*.85):0;
  // A small automatic tail movement remains at speed. Deliberate, large-angle
  // slides are reserved for Shift; switching modes still uses the shared ramp.
  // Keep tire coefficients positive even at the maximum drift slider setting.
  return manual?Math.min(1,cornerDemand+extra):cornerDemand*.2;
}
export class Simulation {
  maxTicks = MAX_TICKS;
  world: RAPIER.World;
  car: RAPIER.RigidBody;
  vehicle: RAPIER.DynamicRayCastVehicleController;
  ticks = 0; checkpoint = 0; finished = false; steering = 0; steeringStrength = 1; throttle = 0; reverse = 0; brake = 0; grounded = false; boosting = false; drifting = false; offRoad = false;
  autoDrift = 0;
  /**
   * Read-only audio signals; nothing here feeds back into the simulation, so replays are unaffected.
   * wheelSurface: collider class under each wheel (0 road, 1 grass, 2 gravel/sand, -1 airborne).
   * wallSpeed / carHit: strongest sideways chassis contact this tick as a speed change in m/s, and whether it was another driver's car.
   * wallContact: the chassis touched a wall or barrier this tick. suspensionJolt: largest sudden wheel-travel change this tick, in metres (kerbs and rough ground).
   */
  wheelSurface: number[] = [-1, -1, -1, -1]; wallSpeed = 0; carHit = false; wallContact = false; suspensionJolt = 0;
  /** Rising-edge wall/car hits: hitCount increments once per impact (frames can span several ticks); lastHitSpeed is the speed change in m/s (about 6 for a bump, 20+ for a crash), lastHitWithCar says whether it was another driver's car. */
  hitCount = 0; lastHitSpeed = 0; lastHitWithCar = false;
  private lastSuspension: number[] = [0, 0, 0, 0]; private quietTicks = 20;
  finishTicks = 0;
  driftStrength = 1;
  manual=false;gear=1;private shiftTicks=0;
  /** Counts downshifts refused because the lower gear would over-rev; the HUD flashes a warning when it changes. */
  blockedShifts=0;
  /** True once the gearbox can accept the next shift. */
  get shiftReady(){return this.shiftTicks<=1;}  // the countdown ticks once before the shift check
  get engine(){return engineState(this.carSpec,Math.abs(this.forwardSpeed)*this.track.metersPerUnit,this.gear,this.throttle);}
  private steerHold = 0;
  respawns = 0; splits: number[] = []; previousInput = 0;
  /** Training Grounds only: tick each cone was knocked (-1 standing), and touched cones on the timed course. */
  coneHits: Int32Array; penalties = 0;
  /** Cone Attack: times the car left the course (each also counted in penalties), and the tick of the last one. */
  offCourse = 0; private lastOffCourse = -999;
  readonly carSpec: CarDefinition;
  readonly recoveryFloor: number;
  private colliderSurfaces = new Map<number, number>();
  private wheelSupportHandles = new Set<number>();
  private smoothRouteSegments: Track['segments'];
  private gateSource?: { checkpoints: Gate[]; finish: Gate; gates: { checkpoints: FittedGate[]; finish: FittedGate } };
  /** Timing gates measured across the full physical road and run-off. */
  get gates() {
    const { checkpoints, finish } = this.track;
    if (this.gateSource?.checkpoints !== checkpoints || this.gateSource.finish !== finish)
      this.gateSource = { checkpoints, finish, gates: fittedGates(this.track, collisionMeshes.get(this.track.id)) };
    return this.gateSource.gates;
  }
  /** Pose the car starts from, and returns to when it is respawned before the first checkpoint. */
  readonly spawnPoint: Gate;
  constructor(public track: Track, carId: CarId = DEFAULT_CAR.id, origin?: RunOrigin) {
    this.carSpec = carById(carId);
    if (origin) {
      const forward = { x: Math.sin(origin.heading), y: 0, z: Math.cos(origin.heading) };
      this.spawnPoint = { position: { x: origin.x, y: 0, z: origin.z }, forward, rotation: orientation(forward), width: 4, segment: 0 };
    } else this.spawnPoint = spawnGate(track);
    this.coneHits = new Int32Array(track.lot?.cones.length ?? 0).fill(-1);
    this.recoveryFloor = Math.min(...track.segments.flatMap(segment=>[segment.start.y,segment.end.y])) - 12;
    // Building the venue colliders (hundreds of thousands of triangles with
    // internal-edge topology) dominates construction. Every restart, ghost and
    // replay of the same layout restores a snapshot of that finished static
    // world instead; Rapier snapshots carry the complete solver state, so the
    // restored world steps bit-identically to a freshly built one.
    const staticKey = staticWorldKey(track), cached = staticWorld?.key === staticKey ? staticWorld : undefined;
    if (cached) {
      this.world = RAPIER.World.restoreSnapshot(cached.snapshot);
      this.colliderSurfaces = new Map(cached.surfaces); this.wheelSupportHandles = new Set(cached.support); this.smoothRouteSegments = cached.route;
    } else {
    this.world = new RAPIER.World({ x: 0, y: -22, z: 0 });
    this.world.timestep = DT;
    // A developer-placed grid may sit before the old timing route. Join that
    // visible starting position back into the smooth lane so the opening
    // straight receives the same filtered wheel contact as the rest of a lap.
    const mappedRoute = track.mapPath && track.mapPath.length > 1 ? (() => {
      const width=Math.max(10,track.segments.reduce((sum,segment)=>sum+segment.width,0)/track.segments.length);
      return track.mapPath!.slice(0,-1).map((start,index)=>({
        id:`${track.id}-driven-${index}`,next:index<track.mapPath!.length-2?`${track.id}-driven-${index+1}`:null,
        start,end:track.mapPath![index+1],width,surface:'road' as const,rails:false,
      }));
    })() : track.segments;
    this.smoothRouteSegments = track.spawn ? (() => {
      const width=Math.max(track.spawn!.width,mappedRoute[0].width);
      const behind={x:track.spawn!.position.x-track.spawn!.forward.x*12,y:track.spawn!.position.y-track.spawn!.forward.y*12,z:track.spawn!.position.z-track.spawn!.forward.z*12};
      // If a grid was placed before an older hand-authored route, keep the
      // opening lane straight in the direction printed on the grid, then join
      // the closest forward point of that route. The previous direct diagonal
      // connection could leave the visible main straight after only a few
      // seconds, putting tires back on the bumpy source mesh.
      if(!track.mapPath?.length){
        let rejoin:{segment:number;t:number;along:number;lateral:number}|undefined;
        mappedRoute.forEach((segment,segmentIndex)=>{
          for(let step=0;step<=20;step++){
            const t=step/20,point={x:segment.start.x+(segment.end.x-segment.start.x)*t,z:segment.start.z+(segment.end.z-segment.start.z)*t};
            const dx=point.x-track.spawn!.position.x,dz=point.z-track.spawn!.position.z;
            const along=dx*track.spawn!.forward.x+dz*track.spawn!.forward.z,lateral=Math.abs(dx*track.spawn!.forward.z-dz*track.spawn!.forward.x);
            if(along<35||along>450)continue;
            const score=lateral+along*.025;
            const current=rejoin?rejoin.lateral+rejoin.along*.025:Infinity;
            if(score<current)rejoin={segment:segmentIndex,t,along,lateral};
          }
        });
        if(rejoin&&rejoin.lateral<width*1.4){
          const matched=mappedRoute[rejoin.segment],join={x:matched.start.x+(matched.end.x-matched.start.x)*rejoin.t,y:matched.start.y+(matched.end.y-matched.start.y)*rejoin.t,z:matched.start.z+(matched.end.z-matched.start.z)*rejoin.t};
          const straightEnd={x:track.spawn!.position.x+track.spawn!.forward.x*rejoin.along,y:track.spawn!.position.y+track.spawn!.forward.y*rejoin.along,z:track.spawn!.position.z+track.spawn!.forward.z*rejoin.along};
          const remainder=[{...matched,id:`${track.id}-spawn-rejoin`,start:join},...mappedRoute.slice(rejoin.segment+1)];
          return [
            {id:`${track.id}-spawn-runup`,next:`${track.id}-spawn-straight`,start:behind,end:track.spawn!.position,width,surface:'road' as const,rails:false},
            {id:`${track.id}-spawn-straight`,next:`${track.id}-spawn-link`,start:track.spawn!.position,end:straightEnd,width,surface:'road' as const,rails:false},
            {id:`${track.id}-spawn-link`,next:remainder[0].id,start:straightEnd,end:join,width,surface:'road' as const,rails:false},
            ...remainder,
          ];
        }
      }
      const approachDistance=Math.hypot(track.spawn!.position.x-mappedRoute[0].start.x,track.spawn!.position.y-mappedRoute[0].start.y,track.spawn!.position.z-mappedRoute[0].start.z);
      return [{id:`${track.id}-spawn-runup`,next:approachDistance>1?`${track.id}-spawn-approach`:mappedRoute[0].id,start:behind,end:track.spawn!.position,width,surface:'road' as const,rails:false},
        ...(approachDistance>1?[{id:`${track.id}-spawn-approach`,next:mappedRoute[0].id,start:track.spawn!.position,end:mappedRoute[0].start,width,surface:'road' as const,rails:false}]:[]),
        ...mappedRoute];
    })() : mappedRoute;
    const road = buildRoadMesh(track);
    const supportRoad = this.smoothRouteSegments === track.segments ? road : buildRoadMesh({ ...track, segments: this.smoothRouteSegments });
    const nativeCollision = collisionMeshes.get(track.id);
    if (nativeCollision) {
      const covered = this.skinCoverage(track, supportRoad, nativeCollision);
      for (const surface of [0, 1, 2]) for (const underSkin of [false, true]) {
        const indices: number[] = [];
        nativeCollision.surfaces.forEach((kind, triangle) => { if (kind === surface && covered[triangle] === +underSkin) indices.push(...nativeCollision.indices.subarray(triangle * 3, triangle * 3 + 3)); });
        if (!indices.length) continue;
        const desc = RAPIER.ColliderDesc.trimesh(nativeCollision.vertices, new Uint32Array(indices), RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES).setFriction(surface === 0 ? .84 : .45);
        // Floor under the skin: wheels and queries still see it; the chassis does not.
        if (underSkin) desc.setCollisionGroups(groups(GROUP.floor, 0xffff & ~GROUP.chassis));
        const collider = this.world.createCollider(desc);
        this.colliderSurfaces.set(collider.handle, surface);
      }
      // A non-solid support skin follows the authored visible racing asphalt.
      // Wheel rays see its continuous surface before the source model's tiny
      // seams and grooves; the chassis does not collide with it, so every wall,
      // kerb, grass area and obstacle still comes from visible venue geometry.
      this.world.step();
      const {vertices:supportVertices,indices:supportIndices}=this.buildSupportSkin(track,supportRoad);
      const support=this.world.createCollider(RAPIER.ColliderDesc.trimesh(supportVertices,supportIndices,RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES).setSensor(true));
      this.colliderSurfaces.set(support.handle,0);this.wheelSupportHandles.add(support.handle);
      // The chassis never touches ground under the skin while driving (the tyres hold it up); this solid copy 60 cm lower only catches a crashed or upside-down car.
      const floorVertices=supportVertices.slice();for(let i=1;i<floorVertices.length;i+=3)floorVertices[i]-=(SKIN.lift+.55)/track.metersPerUnit;
      this.world.createCollider(RAPIER.ColliderDesc.trimesh(floorVertices,supportIndices,RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES).setFriction(.3).setCollisionGroups(groups(GROUP.chassisFloor,GROUP.chassis)));
    } else if (track.lot) {
      this.buildLot(track.lot);
    } else {
    // A wider, lower ribbon follows the model elevation outside the asphalt.
    // It supplies continuous grass/run-off contact without covering the visible
    // venue or creating duplicate coplanar rendered surfaces.
    const terrainTrack: Track = { ...track, segments: track.segments.map(segment=>({...segment,width:segment.width+150})) };
    const terrain = buildRoadMesh(terrainTrack), terrainVertices=terrain.vertices.slice();
    for(let i=1;i<terrainVertices.length;i+=3)terrainVertices[i]-=.28;
    this.world.createCollider(RAPIER.ColliderDesc.trimesh(terrainVertices,terrain.indices).setFriction(.38));
    // A thin, invisible driving ribbon closes microscopic seams between source
    // meshes while the complete venue collider supplies kerbs, walls, banking
    // and scenery impacts. Its points are sampled directly from the model road.
    const sealedRoad = road.vertices.slice(); for(let i=1;i<sealedRoad.length;i+=3)sealedRoad[i]+=.035;
    this.world.createCollider(RAPIER.ColliderDesc.trimesh(sealedRoad, road.indices).setFriction(0.84));
    }
    // Do not add route-edge "rails" here. Those were invisible vertical walls,
    // so they could catch the car where the player saw open space. Visible venue
    // meshes supply fixture collisions; the ribbons above only follow rendered
    // road and terrain contact surfaces.
    this.world.step();
    staticWorld = { key: staticKey, snapshot: this.world.takeSnapshot(), surfaces: [...this.colliderSurfaces], support: [...this.wheelSupportHandles], route: this.smoothRouteSegments };
    // Canonicalize the first world too: restored query/arena bookkeeping must
    // match ghosts and server replays constructed from the cache.
    this.world.free();
    this.world = RAPIER.World.restoreSnapshot(staticWorld.snapshot);
    }
    const spawn = this.spawnPoint;
    const spawnPosition = this.surfaceSpawn(spawn.position);
    this.car = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawnPosition.x, spawnPosition.y, spawnPosition.z)
      .setRotation(spawn.rotation).setLinearDamping(0.015).setAngularDamping(.6).setCanSleep(false)
      // Hard CCD shape-casts repeatedly stop on Daytona's dense bank seams.
      // Soft prediction retains nearby wall contact without freezing motion.
      .setCcdEnabled(track.id!=='daytona').setSoftCcdPrediction(track.id==='daytona'?.25:0));
    const dimensions = this.carSpec.dimensions;
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(dimensions.bodyWidthM * .43, Math.max(.22, dimensions.heightM * .24), dimensions.lengthM * .42).setTranslation(0,-0.18,0)
      .setMass(this.carSpec.physics.massKg).setFriction(0.08).setRestitution(0).setCollisionGroups(groups(GROUP.chassis, 0xffff & ~GROUP.floor)), this.car);
    this.vehicle = this.createVehicle();
    // Build the scene query acceleration structures before the first wheel raycast.
    for (let i = 0; i < 30; i++) { this.updateWheelContacts(); this.world.step(); }
    // Those settling frames are useful for compressing the suspension onto the
    // imported surface, but they can leave a tiny yaw/roll impulse queued for
    // the first playable tick. A countdown must begin from a completely quiet
    // chassis, not from an almost-settled simulation.
    this.car.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.car.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }
  /** Extra rate (1/s) at which the chassis keeps turning to match the road plane after contacts: zero at low speed, firmer at speed so banking is followed. */
  private restoreGain(speedMps:number) { return Math.min(7,Math.max(0,speedMps-25)*.12); }
  get timeMs() { return Math.round(this.ticks * DT * 1000) + this.penalties * CONE_PENALTY_MS; }
  /** One flat slab plus solid boxes. Every collider is labelled road, so the whole lot has full grip. */
  private buildLot(lot: LotLayout) {
    const ground = this.world.createCollider(RAPIER.ColliderDesc.cuboid(lot.half + 60, 1, lot.half + 60).setTranslation(0, -1, 0).setFriction(.84));
    this.colliderSurfaces.set(ground.handle, 0);
    for (const box of lot.boxes) {
      const collider = this.world.createCollider(RAPIER.ColliderDesc.cuboid(box.w / 2, box.h / 2, box.l / 2).setTranslation(box.x, box.h / 2, box.z)
        .setRotation({ x: 0, y: Math.sin(box.yaw / 2), z: 0, w: Math.cos(box.yaw / 2) }).setFriction(box.kind === 'island' ? .84 : .3));
      this.colliderSurfaces.set(collider.handle, 0);
    }
  }
  /**
   * Cones are not rigid bodies: a footprint test against the chassis knocks
   * them over, scrubs a little speed, and on the timed course adds a penalty.
   * It is plain arithmetic on the car pose, so server replays match exactly.
   */
  /** The car's centre crossing a course edge costs a penalty; at most one every half second, so riding the line is not punished repeatedly. */
  private crossEdges(lot: LotLayout, a: Vec3, b: Vec3) {
    if (this.ticks - this.lastOffCourse < 30) return;
    const mx = b.x - a.x, mz = b.z - a.z;
    for (const edge of lot.edges) for (let i = 0; i < edge.points.length - 1; i++) {
      const [px, pz] = edge.points[i], [qx, qz] = edge.points[i + 1], ex = qx - px, ez = qz - pz;
      const denominator = mx * ez - mz * ex; if (!denominator) continue;
      const t = ((px - a.x) * ez - (pz - a.z) * ex) / denominator, u = ((px - a.x) * mz - (pz - a.z) * mx) / denominator;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1) { this.penalties++; this.offCourse++; this.lastOffCourse = this.ticks; return; }
    }
  }
  private hitCones(lot: LotLayout) {
    const p = this.car.translation();
    const forward = rotate(this.car.rotation(), { x: 0, y: 0, z: 1 }), length = Math.hypot(forward.x, forward.z) || 1;
    const fx = forward.x / length, fz = forward.z / length, dimensions = this.carSpec.dimensions;
    const reach = dimensions.lengthM / 2 + CONE_RADIUS, side = dimensions.bodyWidthM / 2 + CONE_RADIUS;
    for (let i = 0; i < lot.cones.length; i++) {
      const cone = lot.cones[i], dx = cone.x - p.x, dz = cone.z - p.z;
      if (this.coneHits[i] >= 0) {
        // Free roam stands knocked cones back up once the car has moved on.
        if (this.track.kind === 'lot' && this.ticks - this.coneHits[i] > 480 && dx * dx + dz * dz > 400) this.coneHits[i] = -1;
        continue;
      }
      // Free roam keeps only the east section standing; the long loop appears in a run.
      if (this.track.kind === 'lot' && !cone.free) continue;
      if (p.y > 2.4 || Math.abs(dx) > 8 || Math.abs(dz) > 8) continue;
      if (Math.abs(dx * fx + dz * fz) < reach && Math.abs(dx * fz - dz * fx) < side) {
        this.coneHits[i] = this.ticks;
        if (this.track.kind === 'cones') this.penalties++;
        const velocity = this.car.linvel();
        this.car.setLinvel({ x: velocity.x * .985, y: velocity.y, z: velocity.z * .985 }, true);
      }
    }
  }
  get speed() { const vel = this.car.linvel(); return Math.hypot(vel.x, vel.y, vel.z); }
  get forwardSpeed() { const vel = this.car.linvel(), forward = rotate(this.car.rotation(), { x: 0, y: 0, z: 1 }); return vel.x*forward.x + vel.y*forward.y + vel.z*forward.z; }
  frame(): Frame { return { p: { ...this.car.translation() }, q: { ...this.car.rotation() } }; }
  /**
   * The surface every tyre actually rolls on. Heights are sampled from the venue
   * across the lane plus run-off, then smoothed along the road (over ~24 m) and
   * across it, so kerbs, seams and triangle-level texture vanish while real hills,
   * crests and banking remain. Wheels read only this skin wherever it reaches.
   */
  /** 1 for each upward-facing venue triangle inside the skin's footprint (same reach as buildSupportSkin), else 0. */
  private skinCoverage(track:Track,road:ReturnType<typeof buildRoadMesh>,mesh:CollisionMesh) {
    const mpu=track.metersPerUnit,points=road.points;
    const halfWidth=Math.max(...points.map(p=>Math.hypot(p.right.x-p.left.x,p.right.z-p.left.z)/2));
    const reach=halfWidth+(SKIN.margin-1)/mpu,cell=Math.max(reach,10/mpu),grid=new Map<string,number[]>();
    points.forEach((p,i)=>{const key=`${Math.floor(p.center.x/cell)},${Math.floor(p.center.z/cell)}`;const list=grid.get(key)??[];list.push(i);grid.set(key,list);});
    const v=mesh.vertices,covered=new Uint8Array(mesh.indices.length/3);
    for(let t=0;t<covered.length;t++){
      const a=mesh.indices[t*3]*3,b=mesh.indices[t*3+1]*3,c=mesh.indices[t*3+2]*3;
      const ux=v[b]-v[a],uy=v[b+1]-v[a+1],uz=v[b+2]-v[a+2],wx=v[c]-v[a],wy=v[c+1]-v[a+1],wz=v[c+2]-v[a+2];
      const nx=uy*wz-uz*wy,ny=uz*wx-ux*wz,nz=ux*wy-uy*wx;if(Math.abs(ny)<.6*Math.hypot(nx,ny,nz))continue;
      const x=(v[a]+v[b]+v[c])/3,y=(v[a+1]+v[b+1]+v[c+1])/3,z=(v[a+2]+v[b+2]+v[c+2])/3,gx=Math.floor(x/cell),gz=Math.floor(z/cell);
      search:for(let i=-1;i<=1;i++)for(let j=-1;j<=1;j++)for(const k of grid.get(`${gx+i},${gz+j}`)??[]){
        const p=points[k],f=p.forward,dx=x-p.center.x,dz=z-p.center.z;
        // Within reach sideways, within a row spacing along, and near the road's height (not a bridge above or tunnel below).
        if(Math.abs(dx*f.z-dz*f.x)<reach&&Math.abs(dx*f.x+dz*f.z)<4.5/mpu&&Math.abs(y-p.center.y)<4/mpu){covered[t]=1;break search;}
      }
    }
    return covered;
  }
  private buildSupportSkin(track:Track,road:ReturnType<typeof buildRoadMesh>) {
    const key=road.vertices.join(','),cached=supportSkinCache.get(track);
    if(cached?.route===key)return cached;
    const mpu=track.metersPerUnit,points=road.points;
    const halfWidth=Math.max(...points.map(p=>Math.hypot(p.right.x-p.left.x,p.right.z-p.left.z)/2));
    const reach=halfWidth+SKIN.margin/mpu,columns=Math.max(5,Math.ceil(reach*2*mpu/SKIN.step)+1);
    const offset=(c:number)=>-reach+reach*2*c/(columns-1);
    const at=(p:typeof points[number],c:number)=>{const r={x:p.forward.z,z:-p.forward.x},o=offset(c);return {x:p.center.x+r.x*o,y:p.center.y,z:p.center.z+r.z*o};};
    // Raw heights: start at the lane centre, then walk outward column by column, each sample taken
    // relative to its neighbour, so the profile follows the real surface up and down banking instead of
    // jumping to platforms, fences or the infield. Steps steeper than ~37 degrees count as walls.
    const banked=track.id==='daytona';
    const raw=points.map(p=>{
      const lane=Math.hypot(p.right.x-p.left.x,p.right.z-p.left.z)/2,step=reach*2/(columns-1);
      const center=Math.floor((columns-1)/2),row=new Array<number>(columns);
      row[center]=this.nearestSurfaceY(at(p,center),true,banked?2:1.5,banked);
      for(const direction of [-1,1])for(let c=center+direction;c>=0&&c<columns;c+=direction){
        const previous=row[c-direction],inLane=Math.abs(offset(c))<=lane;
        const y=this.nearestSurfaceY({...at(p,c),y:previous},true,inLane?.9:.6);
        const rise=(inLane?.75:.35)*step+.15/mpu;
        row[c]=Math.max(previous-rise,Math.min(previous+rise,y));
      }
      return row;
    });
    /** Along the road: triangle-weighted average over a radius, using real distances (bend samples cluster). */
    const alongRoad=(radiusM:number,source:ArrayLike<number>[]=raw,lateral=3)=>{const radius=radiusM/mpu;return points.map((p,i)=>{
      const row=new Float64Array(columns);let weight=0,first=i;
      while(first>0&&p.distance-points[first-1].distance<radius)first--;
      for(let j=first;j<points.length&&points[j].distance-p.distance<radius;j++){
        const spacing=(points[Math.min(points.length-1,j+1)].distance-points[Math.max(0,j-1)].distance)/2;
        const w=(1-Math.abs(points[j].distance-p.distance)/radius)*Math.max(spacing,1e-3);
        for(let c=0;c<columns;c++)row[c]+=source[j][c]*w;weight+=w;
      }
      for(let c=0;c<columns;c++)row[c]/=weight;
      // Across the road: three [1,2,1] passes take out kerb-sized steps but keep banking.
      for(let pass=0;pass<lateral;pass++){const copy=row.slice();for(let c=0;c<columns;c++)row[c]=(copy[Math.max(0,c-1)]+2*copy[c]+copy[Math.min(columns-1,c+1)])/4;}
      return row;
    });};
    // Long smoothing removes everything bump-sized. A short along-road average (no sideways blur) is the
    // reference for the real surface: the skin may sit at most 3 cm under it (never scrape over a crest or
    // into banking) and 15 cm over it (where it bridges a dip). Bounded twice, around a final light smoothing.
    const tight=alongRoad(8,raw,0),bound=(rows:ArrayLike<number>[])=>rows.map((row,i)=>Array.from(row,(y,c)=>Math.max(tight[i][c]-.03/mpu,Math.min(tight[i][c]+.15/mpu,y))));
    const along=bound(alongRoad(10,bound(alongRoad(SKIN.radius)),0));
    const vertices=new Float32Array(points.length*columns*3),triangles:number[]=[];
    points.forEach((p,i)=>{for(let c=0;c<columns;c++){
      const position=at(p,c),v=(i*columns+c)*3;
      vertices[v]=position.x;vertices[v+1]=along[i][c]+SKIN.lift/mpu;vertices[v+2]=position.z;
      if(i&&c){const a=(i-1)*columns+c-1,b=i*columns+c-1;triangles.push(a,b,a+1,a+1,b,b+1);}
    }});
    const built={route:key,vertices,indices:new Uint32Array(triangles)};supportSkinCache.set(track,built);return built;
  }
  private nearestSurfaceY(position:Vec3,preferRoadTop=false,roadTopRange=1.5,roadOnly=false) {
    // Old placements may be a few metres below the imported road. Choose the
    // closest physical floor, not the top of a grandstand or bridge overhead.
    let floor = position.y, closest = Infinity;const candidates:number[]=[];
    if (this.colliderSurfaces.size) {
      let top = position.y + 5;
      for (let attempt = 0; attempt < 12 && top > position.y - 5; attempt++) {
        const hit = this.world.castRayAndGetNormal(new RAPIER.Ray({ x: position.x, y: top, z: position.z }, { x: 0, y: -1, z: 0 }), top - position.y + 5, false, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC, QUERY_GROUPS, undefined, undefined, collider=>roadOnly?this.colliderSurfaces.get(collider.handle)===0:!this.wheelSupportHandles.has(collider.handle));
        if (!hit) break;
        const y = top - hit.timeOfImpact, distance = Math.abs(y - position.y);
        if (Math.abs(hit.normal.y) > .5) { candidates.push(y);if (distance < closest) { floor = y; closest = distance; } }
        top = y - .03;
      }
    }
    if(preferRoadTop){const upper=candidates.filter(y=>y>=position.y-.1&&y<=position.y+roadTopRange);if(upper.length)floor=Math.max(...upper);}
    return floor;
  }
  private surfaceSpawn(position: Vec3): Vec3 {
    return { x: position.x, y: this.nearestSurfaceY(position) + 1.05, z: position.z };
  }
  private createVehicle() {
    const vehicle = this.world.createVehicleController(this.car);
    vehicle.indexUpAxis = 1; vehicle.setIndexForwardAxis = 2;
    const tuning = this.carSpec.physics;
    const dimensions = this.carSpec.dimensions;
    for (let i = 0; i < 4; i++) {
      vehicle.addWheel({ x: i % 2 ? dimensions.trackM / 2 : -dimensions.trackM / 2, y: 0, z: i < 2 ? dimensions.wheelbaseM / 2 : -dimensions.wheelbaseM / 2 }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, 0.58, dimensions.wheelRadiusM);
      // A compliant, well-damped road-car setup filters sub-model detail while
      // retaining the larger kerbs and elevation changes of each real circuit.
      vehicle.setWheelSuspensionStiffness(i, RIDE.stiffness);
      vehicle.setWheelSuspensionCompression(i, RIDE.compression);
      vehicle.setWheelSuspensionRelaxation(i, RIDE.relaxation);
      vehicle.setWheelMaxSuspensionForce(i, tuning.massKg * 18);
      vehicle.setWheelMaxSuspensionTravel(i, 0.42);
      vehicle.setWheelFrictionSlip(i, tuning.grip);
      vehicle.setWheelSideFrictionStiffness(i, tuning.sideGrip * .3);
    }
    return vehicle;
  }
  /** Venue material class (0 road, 1 grass, 2 gravel) directly below a point, ignoring the smooth skin. */
  private materialUnder(point:Vec3|null) {
    if(!point)return 0;
    const hit=this.world.castRay(new RAPIER.Ray({x:point.x,y:point.y+.6,z:point.z},{x:0,y:-1,z:0}),1.8,true,
      RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC|RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC|RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,QUERY_GROUPS);
    return hit?(this.colliderSurfaces.get(hit.collider.handle)??0):0;
  }
  wheelUsesSmoothSupport(index:number) { const ground=this.vehicle.wheelGroundObject(index);return !!ground&&this.wheelSupportHandles.has(ground.handle); }
  /** Visible floor beneath a rendered tire, excluding the smoothed support skin. */
  visibleGroundAt(position: Vec3): number | undefined {
    const top=position.y+.65;
    const hit=this.world.castRayAndGetNormal(new RAPIER.Ray({x:position.x,y:top,z:position.z},{x:0,y:-1,z:0}),1.8,false,
      RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC|RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC|RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,QUERY_GROUPS);
    return hit&&Math.abs(hit.normal.y)>.55?top-hit.timeOfImpact:undefined;
  }
  roadHeightAt(position:Vec3):number|undefined {
    const hit=this.world.castRayAndGetNormal(new RAPIER.Ray({x:position.x,y:position.y+2,z:position.z},{x:0,y:-1,z:0}),6,false,
      RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC|RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC|RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,QUERY_GROUPS);
    return hit&&Math.abs(hit.normal.y)>.6&&(this.colliderSurfaces.get(hit.collider.handle)??0)===0?position.y+2-hit.timeOfImpact:undefined;
  }
  /** Camera helper: true when nothing static stands between two points. Read-only; replays are unaffected. */
  lineOfSight(from:Vec3,to:Vec3):boolean {
    const dx=to.x-from.x,dy=to.y-from.y,dz=to.z-from.z,length=Math.hypot(dx,dy,dz);if(length<.01)return true;
    const hit=this.world.castRay(new RAPIER.Ray(from,{x:dx/length,y:dy/length,z:dz/length}),length-2.5,true,
      RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC|RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC|RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,QUERY_GROUPS);
    return !hit;
  }
  roadEdgeDistance(position:Vec3,direction:Vec3):number {
    const hit=this.world.castRay(new RAPIER.Ray(position,direction),40,false,
      RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC|RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC|RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,QUERY_GROUPS);
    return hit?.timeOfImpact??40;
  }
  private updateWheelContacts() {
    // Rapier returns the first surface reached by each suspension ray. The
    // imported visual mesh can therefore win over the support skin wherever a
    // groove or triangle sits a few millimetres higher, which reintroduces the
    // exact chatter the skin is meant to remove. While the chassis is on the
    // authored racing lane, make wheel suspension read only the smooth skin.
    // Outside that lane (grass, paved runoff and pit areas), read only visible
    // venue geometry so those materials and elevations continue to behave as
    // modelled.
    // The skin covers the lane and run-off, so use it wherever at least three tyres are over it.
    let useSmoothSupport = this.wheelSupportHandles.size > 0;
    if(useSmoothSupport){
      const position=this.car.translation(),rotation=this.car.rotation(),down=rotate(rotation,{x:0,y:-1,z:0}),dimensions=this.carSpec.dimensions;
      // A crest may unload one tire. Keep the supported axle on the smooth
      // road instead of switching every tire onto the source mesh for one tick.
      // Fewer than three supported rays still falls back at the ribbon edge.
      let supported=0;
      for(let i=0;i<4;i++){
        const axle=rotate(rotation,{x:(i%2?1:-1)*dimensions.trackM/2,y:0,z:(i<2?1:-1)*dimensions.wheelbaseM/2});
        const hit=this.world.castRay(new RAPIER.Ray({x:position.x+axle.x,y:position.y+axle.y,z:position.z+axle.z},down),.58+dimensions.wheelRadiusM,false,
          RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC|RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC,QUERY_GROUPS,undefined,undefined,collider=>this.wheelSupportHandles.has(collider.handle));
        if(hit)supported++;
      }
      useSmoothSupport=supported>=3;
    }
    this.vehicle.updateVehicle(
      DT,
      // Kinematic bodies are other party drivers' cars: solid to the chassis, never a road surface for the tires.
      RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC,
      QUERY_GROUPS,
      collider => useSmoothSupport
        ? this.wheelSupportHandles.has(collider.handle)
        : !this.wheelSupportHandles.has(collider.handle),
    );
  }
  private approach(value: number, target: number, amount: number) {
    return value < target ? Math.min(target, value + amount) : Math.max(target, value - amount);
  }
  private roadDistance(position: Vec3) {
    let nearest = Infinity;
    for (const segment of this.smoothRouteSegments) {
      const dx = segment.end.x - segment.start.x, dz = segment.end.z - segment.start.z;
      const length2 = dx * dx + dz * dz;
      const t = length2 ? Math.max(0, Math.min(1, ((position.x-segment.start.x)*dx + (position.z-segment.start.z)*dz) / length2)) : 0;
      nearest = Math.min(nearest, Math.hypot(position.x - (segment.start.x + dx*t), position.z - (segment.start.z + dz*t)) - segment.width/2);
    }
    return nearest;
  }
  step(input: number) {
    this.integrate(input);
  }
  stepFinish(steering:number,speed:number) {
    if(this.finished)this.integrate(0,{steering,speed});
  }
  private integrate(input:number,cruise?:{steering:number;speed:number}) {
    if (!cruise && (this.finished || this.ticks >= this.maxTicks)) return;
    this.shiftTicks=Math.max(0,this.shiftTicks-1);
    if(this.manual&&!cruise){
      const up=!!(input&Input.ShiftUp)&&!(this.previousInput&Input.ShiftUp),down=!!(input&Input.ShiftDown)&&!(this.previousInput&Input.ShiftDown);
      if(up!==down&&!this.shiftTicks){const next=Math.max(1,Math.min(TRANSMISSIONS[this.carSpec.id].gears,this.gear+(up?1:-1)));
        if(next!==this.gear&&engineState(this.carSpec,Math.abs(this.forwardSpeed)*this.track.metersPerUnit,next).load<1.08){this.gear=next;this.shiftTicks=11;}
        else if(down&&next!==this.gear)this.blockedShifts++;
      }
    }else this.gear=automaticGear(this.carSpec,this.speed*this.track.metersPerUnit);
    if ((input & Input.Respawn) && !(this.previousInput & Input.Respawn)) this.respawn();
    if ((input & Input.Flip) && !(this.previousInput & Input.Flip)) this.flipCar();
    this.previousInput = input;
    const before = { ...this.car.translation() };
    const velocityBefore={...this.car.linvel()},angularBefore={...this.car.angvel()};
    const speed = this.speed, forwardSpeed = this.forwardSpeed, speedMps=speed*this.track.metersPerUnit;
    const tuning = this.carSpec.physics;
    // Contacted material controls traction everywhere, including pit lanes and
    // paved runoff. Route traces are irrelevant to tire grip on imported venues.
    const wheelOffRoad = [0,1,2,3].map(i => {
      const ground = this.vehicle.wheelGroundObject(i);
      let surface = ground ? (this.colliderSurfaces.get(ground.handle) ?? 0) : -1;
      // On the smooth skin, grip still comes from the venue material under the tyre (grass, gravel).
      if (ground && this.wheelSupportHandles.has(ground.handle)) surface = this.materialUnder(this.vehicle.wheelContactPoint(i));
      this.wheelSurface[i] = surface;
      return this.colliderSurfaces.size ? !!ground && surface > 0 : this.roadDistance(before) > 1.1;
    });
    this.offRoad = wheelOffRoad.filter(Boolean).length >= 2;
    // Keyboard input is converted into analog pedal and steering positions. A tap
    // now builds force over time instead of instantly commanding 100% throttle,
    // brake, or lock.
    const wantsForward = !!(input & Input.Throttle), wantsBack = !!(input & Input.Brake);
    const throttleTarget = cruise?Math.max(0,Math.min(1,.35+(cruise.speed-forwardSpeed)*.65)):wantsForward && !wantsBack && forwardSpeed > -.25 ? 1 : 0;
    const reverseTarget = wantsBack && !wantsForward && forwardSpeed < .25 ? 1 : 0;
    const brakeTarget = cruise?Math.max(0,Math.min(1,(forwardSpeed-cruise.speed-1)*.25)):(wantsBack && wantsForward) || (wantsBack && forwardSpeed >= .25) || (wantsForward && forwardSpeed <= -.25) ? 1 : 0;
    this.throttle = this.approach(this.throttle, throttleTarget, (throttleTarget ? 1.55 : 3.5) * DT);
    this.reverse = this.approach(this.reverse, reverseTarget, (reverseTarget ? 1.35 : 3.8) * DT);
    this.brake = this.approach(this.brake, brakeTarget, (brakeTarget ? 1.85 : 4.6) * DT);
    const steeringInput = cruise?Math.sign(cruise.steering):(input & Input.Left ? 1 : 0) - (input & Input.Right ? 1 : 0);
    // Separate low-speed parking lock from high-speed precision. A smoothstep
    // blend avoids the abrupt steering change previously felt near a speed cap.
    // High speed retains enough lock for a long bend, but takes longer to build.
    const arcadeGrip=6*Math.max(0,Math.min(1,(speedMps-25)/35));
    const { lock: speedSteering, speedBlend: easedSpeed } = steeringLock(tuning.steerAngle, speedMps,this.carSpec.dimensions.wheelbaseM,11+tuning.downforce*5+arcadeGrip);
    const offRoadSteer = this.offRoad ? .85 : 1;
    this.steerHold=steeringInput&&Math.sign(this.steering)===steeringInput?Math.min(1.2,this.steerHold+DT):0;
    const holdBoost=1+(!(input&Input.Drift)?1:0)*.45*(1-Math.exp(-this.steerHold*3));
    const target = cruise?Math.max(-tuning.steerAngle,Math.min(tuning.steerAngle,cruise.steering)):steeringInput * speedSteering * offRoadSteer * this.steeringStrength * holdBoost;
    const counterSteering = steeringInput && Math.sign(steeringInput) !== Math.sign(this.steering);
    const response = cruise?9:steeringInput ? (counterSteering ? 2.15+this.autoDrift*4 : 4.2 + (1.35 - 4.2) * easedSpeed) : 4.5;
    this.steering += (target - this.steering) * (1 - Math.exp(-response * DT));
    // Keep a released car planted on its grid spot. Imported circuits are not
    // mathematically flat, so gravity and tiny left/right suspension differences
    // can otherwise make a stationary car creep, rotate, and then roll backward.
    // A stopped car may steer its wheels without releasing the hold.
    const parkingHold = !cruise && !wantsForward && !wantsBack && speedMps < .05;
    const steeringLoad = Math.min(1, Math.abs(this.steering) / Math.max(.005, speedSteering * .72));
    // Loaded corners loosen the rear naturally. Left Shift increases that
    // breakaway according to actual smoothed wheel lock and road speed. Both
    // engagement and release share the ramp, so there is no binary rear lock.
    const autoTarget = !cruise && this.grounded && !this.offRoad && forwardSpeed>0 && steeringInput
      ? rearSlipDemand(speedMps,steeringLoad,this.throttle,this.brake,!!(input&Input.Drift),this.driftStrength) : 0;
    this.autoDrift += (autoTarget-this.autoDrift)*(1-Math.exp(-DT*(autoTarget>this.autoDrift?2.4:this.autoDrift>.2?2.2:3.8)));
    const topSpeed = tuning.topSpeedKph / 3.6 / this.track.metersPerUnit;
    const speedRatio = Math.min(speed / topSpeed, 1.2);
    const torqueCurve = Math.max(0, 1 - Math.pow(Math.max(0, (speedRatio - .32) / .68), 1.45));
    const drivenWheels = tuning.drivetrain === 'AWD' ? 4 : 2;
    const engineForce = tuning.massKg * (27.78 / tuning.zeroToHundred) * 1.16 / drivenWheels / this.track.metersPerUnit;
    // Engine force must still balance resistance at the configured top speed.
    // The old curve reached zero there, causing cars to plateau far below it.
    const highSpeedForce=(tuning.drag*topSpeed*topSpeed+tuning.massKg*.015*topSpeed)/drivenWheels;
    const brakeDeceleration = 27.78 * 27.78 / (2 * tuning.brakeDistance) / this.track.metersPerUnit;
    const brakeImpulse = tuning.massKg * brakeDeceleration * DT / 4;
    // Manual gearbox: lifting off drags the car through the driven wheels, harder at high revs, so a downshift slows it.
    // Total drag reaches about 25% of full braking at the red line; clutch-in during a shift releases it.
    const engineRev=this.manual&&!cruise&&this.forwardSpeed>.5&&this.shiftTicks<=3?Math.min(1.1,engineState(this.carSpec,Math.abs(this.forwardSpeed)*this.track.metersPerUnit,this.gear).load):0;
    const engineBrakeShare=engineRev*engineRev*(1-this.throttle)*.25;
    // Manual gearbox pull: an engine below about half its rev range is lugging, so power falls away steeply; a slipping clutch
    // only helps in 1st and 2nd, and a gear taller than the best one for this speed pulls proportionally less. Auto is unchanged.
    let manualPull=1;
    if(this.manual&&!cruise){
      const rev0=this.engine.load,lug=Math.min(1,Math.pow(rev0/.5,1.4)),clutch=Math.max(0,.7-(this.gear-1)*.4);
      const bestGear=automaticGear(this.carSpec,speedMps),tall=Math.pow(Math.min(1,bestGear/this.gear),.8);
      manualPull=Math.max(lug,clutch,.02)*tall;
    }
    for (let i = 0; i < 4; i++) {
      this.vehicle.setWheelSteering(i, i < 2 ? this.steering : 0);
      const driven = tuning.drivetrain === 'AWD' || i >= 2;
      const reverseTopSpeed = 12.5 / this.track.metersPerUnit;
      const traction = wheelOffRoad[i] ? .48 : 1;
      const rev=this.engine.load;
      const transmission=this.manual&&!cruise?(this.shiftTicks>3?.12:1)*manualPull*Math.max(0,Math.min(1,(1.04-rev)/.1)):1;
      const forwardForce = (engineForce*torqueCurve+highSpeedForce*Math.min(1,speedRatio*speedRatio)*Math.max(0,2-speedRatio))*this.throttle*traction*transmission;
      const reverseForce = forwardSpeed > -reverseTopSpeed ? -engineForce * .52 * this.reverse * Math.max(.2, 1 - Math.abs(forwardSpeed) / reverseTopSpeed) : 0;
      this.vehicle.setWheelEngineForce(i, driven ? forwardForce + reverseForce : 0);
      const driftBrake=i>=2?tuning.driftBrake*this.autoDrift*(1-this.throttle)*Number(!!(input&Input.Drift)):0;
      this.vehicle.setWheelBrake(i, brakeImpulse * (this.brake + (parkingHold ? 2.5 : 0) + (driven ? engineBrakeShare * 4 / drivenWheels : 0)) + driftBrake);
      if (i >= 2) {
        this.vehicle.setWheelFrictionSlip(i, (tuning.grip+(tuning.driftGrip-tuning.grip)*this.autoDrift) * (wheelOffRoad[i] ? .62 : 1));
        this.vehicle.setWheelSideFrictionStiffness(i, tuning.sideGrip * .3 * Math.max(.035,1 - this.autoDrift * 1.45) * (wheelOffRoad[i] ? .58 : 1));
      } else {
        this.vehicle.setWheelFrictionSlip(i, tuning.grip * (wheelOffRoad[i] ? .68 : 1));
        // Build a little more front-axle authority progressively at speed while
        // steering. The rear axle remains softer as its cornering load builds.
        const corneringAssist=1+Math.abs(steeringInput)*easedSpeed*.1;
        this.vehicle.setWheelSideFrictionStiffness(i, tuning.sideGrip * .3 * corneringAssist * (wheelOffRoad[i] ? .66 : 1));
      }
    }
    // Progressive springs (rising rate plus bump rubber): each wheel stiffens up to 7x over its last 15 cm
    // of travel. Linear springs alone hold only ~1.5 g, so banking plus downforce at 150+ mph
    // crushed them and slammed the floor into the track, throwing the car into the air.
    for (let i = 0; i < 4; i++) {
      const squeeze = Math.max(0, Math.min(1, (.31 - (this.vehicle.wheelSuspensionLength(i) ?? .58)) / .15));
      this.vehicle.setWheelSuspensionStiffness(i, RIDE.stiffness * (1 + 6 * squeeze * squeeze));
    }
    this.updateWheelContacts();
    this.grounded = [0,1,2,3].some(i => this.vehicle.wheelIsInContact(i));
    const velocity = this.car.linvel(), planarSpeed = Math.hypot(velocity.x, velocity.z);
    if (this.grounded && planarSpeed > .1) {
      const aerodynamicDrag = tuning.drag * planarSpeed * planarSpeed + tuning.massKg*.15/this.track.metersPerUnit;
      // Use a per-tick impulse. Rapier's accumulated force API persists, which
      // would otherwise make drag grow every frame and eventually pull a car backward.
      this.car.applyImpulse({ x: -velocity.x / planarSpeed * aerodynamicDrag * DT, y: -tuning.downforce * planarSpeed * planarSpeed * DT, z: -velocity.z / planarSpeed * aerodynamicDrag * DT }, true);
      // The real venue meshes have fine surface variation. Above road speeds,
      // take the nervous side-to-side chatter out of the chassis without
      // affecting low-speed rotation or the intended rear-axle breakaway.
      {
        const right = rotate(this.car.rotation(), { x: 1, y: 0, z: 0 });
        const lateralSpeed = velocity.x * right.x + velocity.y * right.y + velocity.z * right.z;
        const stability = Math.max(0, Math.min(1, (speedMps - 8) / 42)) * (steeringInput ? 2.2 : 5.5)*Math.max(0,1-this.autoDrift*3);
        const correctedLateral=Math.max(-4,Math.min(4,lateralSpeed));
        this.car.applyImpulse({ x: -right.x * correctedLateral * tuning.massKg * stability * DT, y: -right.y * correctedLateral * tuning.massKg * stability * DT, z: -right.z * correctedLateral * tuning.massKg * stability * DT }, true);
      }
      if (this.offRoad) {
        const scrub = tuning.massKg * Math.min(9, 2.1 + planarSpeed * .14) * DT;
        this.car.applyImpulse({ x: -velocity.x / planarSpeed * scrub, y: 0, z: -velocity.z / planarSpeed * scrub }, true);
      }
    }
    this.boosting = false;
    if (this.grounded) {
      for (const s of this.track.segments) if (s.surface === 'boost') {
        const d = direction(s.start, s.end), rel = { x: before.x - s.start.x, y: before.y - s.start.y, z: before.z - s.start.z };
        const along = rel.x * d.x + rel.y * d.y + rel.z * d.z;
        const length = Math.hypot(s.end.x-s.start.x,s.end.y-s.start.y,s.end.z-s.start.z);
        if (along > 0 && along < length && Math.abs(rel.x * d.z - rel.z * d.x) < s.width/2 && Math.abs(rel.y - d.y * along) < 2) {
          this.boosting = true;
          if (speed < topSpeed * 1.08 && this.brake < .1) this.car.applyImpulse({ x: d.x * tuning.massKg * .45, y: d.y * tuning.massKg * .45, z: d.z * tuning.massKg * .45 }, true);
        }
      }
    } else {
      const turn = (input & Input.Left ? 1 : 0) - (input & Input.Right ? 1 : 0);
      this.car.applyTorqueImpulse({ x: 0, y: turn * 6, z: 0 }, true);
    }
    if(this.grounded){
      // Bound tire forces BEFORE collision resolution. Raycast lateral impulses
      // otherwise have effectively unlimited grip and can demand 10+ g. Actual
      // walls and impacts are resolved afterward and retain their full response.
      const q=this.car.rotation(),up=rotate(q,{x:0,y:1,z:0});
      const turnAssist=1+Math.max(0,this.steeringStrength-1.35)*2*holdBoost;
      const gripAcceleration=Math.min(28,(12+tuning.downforce*4+arcadeGrip)*turnAssist)*(this.offRoad?.48:1)/this.track.metersPerUnit;
      // Acceleration, braking and cornering share one traction budget.
      const v=this.car.linvel(),dx=v.x-velocityBefore.x,dz=v.z-velocityBefore.z;
      const tractionScale=Math.min(1,gripAcceleration*DT/Math.max(.0001,Math.hypot(dx,dz)));
      let vx=velocityBefore.x+dx*tractionScale,vz=velocityBefore.z+dz*tractionScale;
      // A coasting slide must dissipate energy. The steering assist cannot act
      // like a hidden engine by repeatedly adding lateral speed.
      const previousSpeed=Math.hypot(velocityBefore.x,velocityBefore.z),nextSpeed=Math.hypot(vx,vz);
      if(this.throttle<.001&&this.reverse<.001&&nextSpeed>previousSpeed&&nextSpeed>.01){vx*=previousSpeed/nextSpeed;vz*=previousSpeed/nextSpeed;}
      this.car.setLinvel({x:vx,y:v.y,z:vz},true);
      const angular=this.car.angvel(),yaw=angular.x*up.x+angular.y*up.y+angular.z*up.z;
      const previousYaw=angularBefore.x*up.x+angularBefore.y*up.y+angularBefore.z*up.z;
      const yawLimit=gripAcceleration/Math.max(5,speed)*(1+this.autoDrift*.18);
      // Bicycle-model steering keeps the response tied to wheelbase, actual
      // wheel lock and travel direction, including countersteering and reverse.
      const requestedYaw=forwardSpeed*Math.tan(this.steering)/this.carSpec.dimensions.wheelbaseM*(1+this.autoDrift*.2);
      const targetYaw=Math.max(-yawLimit,Math.min(yawLimit,requestedYaw));
      const limitedYaw=this.approach(previousYaw,targetYaw,1.8*DT);
      const normals=[0,1,2,3].filter(i=>this.vehicle.wheelIsInContact(i)).map(i=>this.vehicle.wheelContactNormal(i)!).filter(Boolean);
      if(normals.length>=3&&up.y>.6){
        // Suspension forces were slowly winding pitch/roll into the road until
        // the chassis nose caught even a perfectly flat floor. Restore toward
        // the supported road plane, while allowing real banking and yaw.
        const normal=normals.reduce((a,n)=>({x:a.x+n.x,y:a.y+n.y,z:a.z+n.z}),{x:0,y:0,z:0});
        const length=Math.hypot(normal.x,normal.y,normal.z)||1;normal.x/=length;normal.y/=length;normal.z/=length;
        const restore={x:up.y*normal.z-up.z*normal.y,y:up.z*normal.x-up.x*normal.z,z:up.x*normal.y-up.y*normal.x},gain=5;
        this.car.setAngvel({x:up.x*limitedYaw+restore.x*gain+(angular.x-up.x*yaw)*.025,
          y:up.y*limitedYaw+restore.y*gain+(angular.y-up.y*yaw)*.025,
          z:up.z*limitedYaw+restore.z*gain+(angular.z-up.z*yaw)*.025},true);
      }else this.car.setAngvel({x:angular.x+up.x*(limitedYaw-yaw),y:angular.y+up.y*(limitedYaw-yaw),z:angular.z+up.z*(limitedYaw-yaw)},true);
    }
    this.world.step();
    this.readAudioSignals();
    const lateral=rotate(this.car.rotation(),{x:1,y:0,z:0}),motion=this.car.linvel();
    const slip=Math.atan2(Math.abs(motion.x*lateral.x+motion.y*lateral.y+motion.z*lateral.z),Math.max(1,Math.abs(this.forwardSpeed)));
    this.drifting=this.grounded&&speedMps>7&&slip>.1;
    if (this.grounded) {
      // At a near-complete stop (under 0.12 mph), remove residual planar solver
      // velocity. Normal coasting is not caught by this stationary hold.
      if (parkingHold) {
        const settled = this.car.linvel();
        if (Math.hypot(settled.x, settled.z) * this.track.metersPerUnit < .08) {
          this.car.setLinvel({ x: 0, y: settled.y, z: 0 }, true);
          this.car.setAngvel({ x: 0, y: 0, z: 0 }, true);
        }
      }
      // Follow the averaged road plane instead of preserving every tiny
      // triangle-to-triangle vertical impulse. This keeps the chassis moving
      // naturally up a hill while rejecting the sharp upward/downward kicks
      // that made smooth asphalt feel like a row of kerbs.
      const normals=[0,1,2,3].filter(i=>this.vehicle.wheelIsInContact(i)).map(i=>this.vehicle.wheelContactNormal(i)).filter((normal):normal is {x:number;y:number;z:number}=>!!normal);
      let roadSmoothing=0,surfaceNormal:Vec3|undefined;
      if(normals.length>=3){
        const normal=normals.reduce((sum,value)=>({x:sum.x+value.x,y:sum.y+value.y,z:sum.z+value.z}),{x:0,y:0,z:0});
        const length=Math.hypot(normal.x,normal.y,normal.z)||1;normal.x/=length;normal.y/=length;normal.z/=length;surfaceNormal=normal;
        const velocity=this.car.linvel(), slopeVelocity=-(velocity.x*normal.x+velocity.z*normal.z)/Math.max(.25,normal.y);
        // Filter small road chatter, not a launch or hard landing. A tire ray
        // may still reach the floor at takeoff; that must not cancel momentum.
        const separationSpeed=Math.abs((velocity.y-slopeVelocity)*normal.y)*this.track.metersPerUnit;
        const blend=Math.max(0,Math.min(1,(separationSpeed-1)/2));
        roadSmoothing=1-blend*blend*(3-2*blend);
        this.car.setLinvel({x:velocity.x,y:slopeVelocity+(velocity.y-slopeVelocity)*(1-RIDE.vertical*roadSmoothing),z:velocity.z},true);
      }
      // Triangle-level road detail can inject rapid pitch/roll impulses into a
      // raycast chassis even while every tire remains in contact. Remove most
      // of that high-frequency tilt velocity after contact resolution, while
      // preserving rotation around the car's up axis so steering remains free.
      const angular = this.car.angvel(), up = rotate(this.car.rotation(), { x: 0, y: 1, z: 0 });
      const yawVelocity = angular.x*up.x + angular.y*up.y + angular.z*up.z;
      // With no steering command, suppress yaw introduced by tiny left/right
      // suspension or mesh differences. Holding throttle alone must preserve
      // the driver's heading instead of slowly accumulating an unintended turn.
      const commandedYaw=steeringInput?yawVelocity:yawVelocity*Math.exp(-9*DT*roadSmoothing);
      const yaw = { x: up.x*commandedYaw, y: up.y*commandedYaw, z: up.z*commandedYaw };
      const tiltRetention=1-RIDE.tilt*roadSmoothing;
      // Filter only tilt that does not follow the road: the rotation that lines the car up with the
      // surface (banking, crests) is kept, everything else (chatter) is mostly removed.
      // Roll only (about the car's length): banking needs it; crests like Eau Rouge are pitch and stay damped.
      const gain=this.restoreGain(speed*this.track.metersPerUnit),length=rotate(this.car.rotation(),{x:0,y:0,z:1});
      const restore=surfaceNormal?{x:up.y*surfaceNormal.z-up.z*surfaceNormal.y,y:up.z*surfaceNormal.x-up.x*surfaceNormal.z,z:up.x*surfaceNormal.y-up.y*surfaceNormal.x}:{x:0,y:0,z:0};
      const roll=Math.max(-.7,Math.min(.7,(restore.x*length.x+restore.y*length.y+restore.z*length.z)*gain)),follow={x:length.x*roll,y:length.y*roll,z:length.z*roll};
      this.car.setAngvel({ x: yaw.x + follow.x + (angular.x-yaw.x-follow.x)*tiltRetention, y: yaw.y + follow.y + (angular.y-yaw.y-follow.y)*tiltRetention, z: yaw.z + follow.z + (angular.z-yaw.z-follow.z)*tiltRetention }, true);
    }
    if(this.track.id==='daytona'){
      // Without CCD, triangle seams no longer halt a 200 mph car. Bound the
      // occasional contact impulse around pitch/roll, not steering yaw.
      const angular=this.car.angvel(),up=rotate(this.car.rotation(),{x:0,y:1,z:0});
      const yaw=angular.x*up.x+angular.y*up.y+angular.z*up.z;
      const tilt={x:angular.x-up.x*yaw,y:angular.y-up.y*yaw,z:angular.z-up.z*yaw};
      const length=Math.hypot(tilt.x,tilt.y,tilt.z);
      // Tyres cannot turn a car faster than its grip allows (about 28 m/s^2
      // over its speed), so a larger yaw rate at speed is a seam or wall impulse.
      const yawCap=Math.max(1.5,36/Math.max(5,speedMps));
      const boundedYaw=Math.max(-yawCap,Math.min(yawCap,yaw));
      const scale=length>3?3/length:1;
      if(length>3||boundedYaw!==yaw)this.car.setAngvel({x:up.x*boundedYaw+tilt.x*scale,y:up.y*boundedYaw+tilt.y*scale,z:up.z*boundedYaw+tilt.z*scale},true);
    }
    // Continue authoritative tire, gravity and wall contact without scoring a second lap.
    if(cruise){this.finishTicks++;return;}
    this.ticks++;
    if (this.track.lot) this.hitCones(this.track.lot);
    const after = this.car.translation();
    if (this.track.kind === 'cones') this.crossEdges(this.track.lot!, before, after);
    // Free roam never scores a gate.
    if (this.track.kind === 'lot') { if (after.y < this.recoveryFloor) this.respawn(); return; }
    const gates = this.gates, gate = gates.checkpoints[this.checkpoint] ?? gates.finish;
    if (this.crossed(before, after, gate)) {
      if (this.checkpoint < this.track.checkpoints.length) { this.checkpoint++; this.splits.push(this.timeMs); }
      else this.finished = true;
    }
    if (after.y < this.recoveryFloor || Math.abs(after.x) > 10000 || Math.abs(after.z) > 10000) this.respawn();
  }
  private crossed(a: Vec3, b: Vec3, gate: FittedGate) {
    // Gates are vertical planes across the whole drivable width, so no line
    // past the barriers or over the grass can skip one.
    const f = gate.forward, p = gate.position;
    const da = (a.x-p.x)*f.x + (a.z-p.z)*f.z;
    const db = (b.x-p.x)*f.x + (b.z-p.z)*f.z;
    if (da > 0 || db <= 0) return false;
    const t = -da / (db-da);
    return insideGate(gate, { x: a.x + (b.x-a.x)*t, y: a.y + (b.y-a.y)*t, z: a.z + (b.z-a.z)*t });
  }
  respawn() {
    this.gear=1;this.shiftTicks=0;
    const gate = this.checkpoint ? this.gates.checkpoints[this.checkpoint - 1] : this.spawnPoint;
    this.world.removeVehicleController(this.vehicle);
    this.car.setTranslation(this.surfaceSpawn({ x: gate.position.x + gate.forward.x * 3, y: gate.position.y, z: gate.position.z + gate.forward.z * 3 }), true);
    this.car.setRotation(gate.rotation, true); this.car.setLinvel({ x: 0, y: 0, z: 0 }, true); this.car.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.vehicle = this.createVehicle();
    this.steering = 0; this.steerHold = 0; this.throttle = 0; this.reverse = 0; this.brake = 0; this.autoDrift = 0; this.drifting = false; this.respawns++;
  }
  flipCar() {
    if (this.speed * this.track.metersPerUnit * 3.6 > 25) return false;
    const q = this.car.rotation();
    const yaw = Math.atan2(2*(q.w*q.y + q.x*q.z), 1 - 2*(q.x*q.x + q.y*q.y));
    const p = this.car.translation(), velocity = this.car.linvel();
    this.car.setTranslation({ x: p.x, y: p.y + 1.05, z: p.z }, true);
    this.car.setRotation({ x: 0, y: Math.sin(yaw/2), z: 0, w: Math.cos(yaw/2) }, true);
    this.car.setLinvel({ x: velocity.x*.35, y: Math.max(0, velocity.y), z: velocity.z*.35 }, true);
    this.car.setAngvel({ x: 0, y: 0, z: 0 }, true);
    return true;
  }
  private obstacles=new Map<string,RAPIER.RigidBody>();
  /**
   * Party racing: places another driver's car as a solid kinematic box. Call every frame with its displayed pose;
   * Rapier derives its velocity from the move, so contact pushes this car realistically. Pass undefined to remove it.
   * The other car is never pushed here; each client is authoritative for its own car.
   */
  setObstacle(id:string,carId:CarId,pose?:{p:Vec3;q:Quat},dt=DT) {
    let body=this.obstacles.get(id);
    if(!pose){if(body){this.world.removeRigidBody(body);this.obstacles.delete(id);}return;}
    if(!body){
      const d=carById(carId).dimensions;
      body=this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(pose.p.x,pose.p.y,pose.p.z).setRotation(pose.q));
      this.world.createCollider(RAPIER.ColliderDesc.cuboid(d.bodyWidthM*.45,Math.max(.3,d.heightM*.32),d.lengthM*.46).setTranslation(0,-.1,0).setFriction(.08).setRestitution(.15),body);
      this.obstacles.set(id,body);return;
    }
    const now=body.translation();
    // A respawn or network jump teleports instead of sweeping through everything in between:
    // anything faster than 95 m/s (212 mph) is not a real car's motion and must not hit with that speed.
    if(Math.hypot(pose.p.x-now.x,pose.p.y-now.y,pose.p.z-now.z)>95/this.track.metersPerUnit*Math.max(dt,DT)){body.setTranslation(pose.p,true);body.setRotation(pose.q,true);}
    else{body.setNextKinematicTranslation(pose.p);body.setNextKinematicRotation(pose.q);}
  }
  /** Reads chassis contacts and suspension travel after a step, for sound only. */
  private readAudioSignals() {
    let impulse = 0, withCar = false, touching = false;
    const chassis = this.car.collider(0);
    this.world.contactPairsWith(chassis, other => {
      const kinematic = other.parent()?.isKinematic() ?? false;
      this.world.contactPair(chassis, other, manifold => {
        const upright = Math.abs(manifold.normal().y);
        // Floor and road contacts are ignored; only sideways and frontal contacts count as hits.
        if (upright > .6) return;
        let sum = 0;
        for (let i = 0; i < manifold.numContacts(); i++) sum += manifold.contactImpulse(i);
        if (manifold.numContacts() > 0) touching = true;
        if (sum > impulse) { impulse = sum; withCar = kinematic; }
      });
    });
    const speed = impulse / this.carSpec.physics.massKg * this.track.metersPerUnit;
    this.wallSpeed = speed; this.carHit = withCar; this.wallContact = touching;
    // A bounce re-touches within a few ticks; only count a new hit after about a third of a second of calm contact.
    if (speed > 2 && this.quietTicks >= 20) { this.hitCount++; this.lastHitSpeed = speed; this.lastHitWithCar = withCar; }
    this.quietTicks = speed < .5 ? this.quietTicks + 1 : 0;
    let jolt = 0;
    for (let i = 0; i < 4; i++) {
      const length = this.vehicle.wheelIsInContact(i) ? this.vehicle.wheelSuspensionLength(i) : null;
      if (length !== null) { jolt = Math.max(jolt, Math.abs(length - this.lastSuspension[i])); this.lastSuspension[i] = length; }
    }
    this.suspensionJolt = jolt * this.track.metersPerUnit;
  }
  dispose() { this.world.free(); }
}
