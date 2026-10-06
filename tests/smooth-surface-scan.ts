// Lane surface scan (geometry gate). Sweeps every circuit's driving lane (saved drive trace, derived centreline,
// or authored route; the same routes as tests/smooth-audit.ts) with downward rays on a fine grid and reports what
// a tyre or chassis would feel:
//   holes   cracks: rays inside the lane that find no surface within 3 m, with road again just beyond (a tyre ray
//           falls in); 'edges' (no road beyond: the end of the drivable surface) are reported but not gated
//   kinks   second difference of surface height above 1.5 cm along world x or z on a 0.25 m grid: seams, steps,
//           risers; a plane (any banking) reads zero and a smooth crest, sag or banking fillet stays below this
//   steep   first surface hit is a near-vertical face (|n.y| < 0.6) within the lane: a wall the chassis would hit
//
//   node --max-old-space-size=6144 --import tsx tests/smooth-surface-scan.ts [--track=id,...] [--lane=0.9] [--out=work/smooth-audit/<name>.json]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import RAPIER from '@dimforge/rapier3d-compat';
import { Simulation, initPhysics } from '../shared/physics';
import { TRACKS, type Vec3 } from '../shared/tracks';
import { applyFinishPlacement, applyRoadWidthOverrides, applyStartPlacement } from '../src/dev-spawns';
import { VENUE_TRACKS, buildRoute, parseCenterline } from './smooth-route';

const arg = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const trackIds = arg('track')?.split(',').filter(Boolean) ?? VENUE_TRACKS;
const laneShare = Number(arg('lane') ?? .9), outPath = arg('out') ?? 'work/smooth-audit/surface-scan.json';
const config = JSON.parse(readFileSync(arg('saved') ?? 'work/smooth-audit/circuit-config.json', 'utf8'));
// --collision-dir=work/smooth-audit/orig-collision scans other collision binaries (e.g. the pre-bake ones).
const collisionDir = arg('collision-dir');
for (const track of TRACKS) {
  if (collisionDir && track.collision) track.collision = `../../../${collisionDir}/${track.collision.split('/').pop()}`;
  applyStartPlacement(track, config.starts?.[track.id]); applyFinishPlacement(track, config.finishes?.[track.id]);
  applyRoadWidthOverrides(track, config.roads?.[track.id]); track.mapPath = config.maps?.[track.id];
}
const TARGETS = { holesPerKm: 0, kinksPerKm: 2, steepPerKm: 0 };
type Finding = { kind: 'hole' | 'edge' | 'kink-across' | 'kink-along' | 'steep'; x: number; y: number; z: number; distanceM: number; lateralM: number; cm: number };
const results: unknown[] = [];
let failed = 0;
for (const id of trackIds) {
  const track = TRACKS.find(t => t.id === id)!, mpu = track.metersPerUnit;
  await initPhysics(track);
  const sim = new Simulation(track), started = Date.now();
  const file = `work/smooth-audit/${id}-centerline.json`;
  const centerline = !track.mapPath?.length && existsSync(file) ? parseCenterline(JSON.parse(readFileSync(file, 'utf8'))) : undefined;
  const route = buildRoute(track, centerline);
  // Material class per collider (0 road, 1 grass, 2 gravel): the lane ends where the asphalt does.
  const surfaces = (sim as unknown as { colliderSurfaces: Map<number, number> }).colliderSurfaces;
  const findings: Finding[] = [], acrossStep = .25 / mpu, alongStep = .5 / mpu;
  const cast = (x: number, y: number, z: number) => {
    const hit = sim.world.castRayAndGetNormal(new RAPIER.Ray({ x, y: y + 3 / mpu, z }, { x: 0, y: -1, z: 0 }), 6 / mpu, false,
      RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC | RAPIER.QueryFilterFlags.EXCLUDE_SENSORS);
    return hit ? { y: y + 3 / mpu - hit.timeOfImpact, ny: Math.abs(hit.normal.y), road: surfaces.get(hit.collider.handle) === 0 } : undefined;
  };
  // Lane cells on a fixed world grid (0.25 m): the walk from the route outward only discovers which cells are
  // lane and the road height to look for; kinks are then second differences along world x and z, so a plane
  // (any banking) reads zero no matter how the driving line wanders across it.
  const cell = .25 / mpu, grid = new Map<string, { y: number; x: number; z: number; distanceM: number; lateralM: number }>();
  let samples = 0;
  const n = route.points.length, edges = route.closed ? n : n - 1;
  for (let i = 0; i < edges; i++) {
    const a = route.points[i], b = route.points[(i + 1) % n], length = Math.hypot(b.x - a.x, b.z - a.z); if (!length) continue;
    const fx = (b.x - a.x) / length, fz = (b.z - a.z) / length, half = route.halfWidth[i] * laneShare;
    for (let d = 0; d < length; d += alongStep) {
      const cx = a.x + fx * d, cz = a.z + fz * d, cy = a.y + (b.y - a.y) * d / length, distanceM = (route.s[i] + d) * mpu;
      const centre = cast(cx, cy, cz);
      if (!centre) { findings.push({ kind: 'hole', x: cx, y: cy, z: cz, distanceM, lateralM: 0, cm: 0 }); continue; }
      for (const direction of [-1, 1]) {
        let near = centre.y;
        for (let lateral = 0; lateral <= half; lateral += acrossStep) {
          const px = cx + fz * lateral * direction, pz = cz - fx * lateral * direction;
          const ix = Math.round(px / cell), iz = Math.round(pz / cell), key = `${ix},${iz}`, x = ix * cell, z = iz * cell;
          const known = grid.get(key); if (known) { near = known.y; continue; }
          const hit = cast(x, near, z); samples++;
          if (!hit) {
            // A crack has road again just beyond it (a tyre ray can fall in); otherwise this is the edge of the drivable surface.
            const beyond = [.25, .5, 1].some(extra => { const far = cast(px + fz * extra / mpu * direction, near, pz - fx * extra / mpu * direction); return !!far && far.road && Math.abs(far.y - near) < .1 / mpu; });
            findings.push({ kind: beyond ? 'hole' : 'edge', x, y: near, z, distanceM, lateralM: lateral * direction * mpu, cm: 0 }); break;
          }
          // A face rising more than 30 cm is the lane edge (wall, barrier, footpath), not road.
          if (hit.y - near > .3 / mpu || near - hit.y > 1 / mpu) break;
          if (hit.ny < .6 && hit.y - near > .02 / mpu) { findings.push({ kind: 'steep', x, y: hit.y, z, distanceM, lateralM: lateral * direction * mpu, cm: (hit.y - near) * mpu * 100 }); break; }
          if (!hit.road) break;
          grid.set(key, { y: hit.y, x, z, distanceM, lateralM: lateral * direction * mpu }); near = hit.y;
        }
      }
    }
  }
  for (const [key, here] of grid) {
    const [ix, iz] = key.split(',').map(Number);
    for (const [dx, dz, kind] of [[1, 0, 'kink-x'], [0, 1, 'kink-z']] as const) {
      const before = grid.get(`${ix - dx},${iz - dz}`), after = grid.get(`${ix + dx},${iz + dz}`);
      if (!before || !after) continue;
      const second = Math.abs(after.y - 2 * here.y + before.y) * mpu * 100;
      if (second > 1.5) findings.push({ kind: kind === 'kink-x' ? 'kink-across' : 'kink-along', x: here.x, y: here.y, z: here.z, distanceM: here.distanceM, lateralM: here.lateralM, cm: second });
    }
  }
  sim.dispose();
  // Neighbouring rays see the same defect: count distinct places (2 m cells) rather than rays.
  const places = (kind: string) => new Set(findings.filter(f => f.kind.startsWith(kind)).map(f => `${Math.round(f.x * mpu / 2)},${Math.round(f.z * mpu / 2)}`)).size;
  const km = route.length * mpu / 1000;
  const summary = {
    track: id, source: route.source, km: +km.toFixed(2), samples,
    holes: places('hole'), edges: places('edge'), kinks: places('kink'), steep: places('steep'),
    holesPerKm: +(places('hole') / km).toFixed(2), kinksPerKm: +(places('kink') / km).toFixed(2), steepPerKm: +(places('steep') / km).toFixed(2),
    worst: (['hole', 'edge', 'steep', 'kink'] as const).flatMap(kind => findings.filter(f => f.kind.startsWith(kind)).sort((p, q) => q.cm - p.cm).slice(0, 20)).map(f => ({ ...f, x: +f.x.toFixed(2), y: +f.y.toFixed(3), z: +f.z.toFixed(2), distanceM: +f.distanceM.toFixed(1), lateralM: +f.lateralM.toFixed(2), cm: +f.cm.toFixed(2) })),
  };
  const violations = (Object.keys(TARGETS) as (keyof typeof TARGETS)[]).filter(k => summary[k] > TARGETS[k]);
  if (violations.length) failed++;
  results.push({ ...summary, violations });
  console.log(`${id.padEnd(13)} ${summary.source.padEnd(10)} ${String(summary.km).padStart(5)} km  cracks ${String(summary.holes).padStart(4)}  edges ${String(summary.edges).padStart(4)}  kinks ${String(summary.kinks).padStart(5)} (${summary.kinksPerKm}/km)  steep ${String(summary.steep).padStart(4)}  ${violations.length ? 'FAIL' : 'pass'}  (${((Date.now() - started) / 1000).toFixed(0)} s)`);
}
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({ targets: TARGETS, laneShare, results }, null, 1));
console.log(`${failed ? 'FAIL' : 'PASS'}: ${trackIds.length - failed}/${trackIds.length} circuits. Report: ${outPath}`);
process.exitCode = failed ? 1 : 0;
export type { Vec3 };
