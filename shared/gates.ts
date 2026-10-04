import { orientation, type Gate, type Track, type Vec3 } from './tracks';

export type GateMesh = { vertices: Float32Array; indices: Uint32Array; surfaces: Uint8Array };
/**
 * A timing gate measured against the physical venue. Lateral offsets run along
 * `side` (forward rotated a quarter turn clockwise), relative to `position`.
 * The trigger spans every drivable metre between barriers; the painted line
 * covers the hard racing surface.
 */
export type FittedGate = Gate & {
  side: Vec3; left: number; right: number; roadLeft: number; roadRight: number;
  /** Surface height relative to position.y, sampled every GATE_STEP metres from `left`. */
  heights: number[];
  /** Absolute surface height at a point `along` forward and `lateral` across the gate. */
  heightAt: (along: number, lateral: number) => number;
};

export const GATE_STEP = .5;
/** Trigger reach either side of the gate when no barrier stops it first. */
const REACH = 40, CELL = 2, MIN_ROAD = 6, MAX_ROAD = 23, BODY = .5, OVERHANG = 1.5;
type Hit = { y: number; surface: number; normalY: number };
type Sample = { lateral: number; y: number; surface: number };

/** Ray queries against only the venue triangles near one gate. */
function localSurface(mesh: GateMesh, center: Vec3) {
  const { vertices: v, indices, surfaces } = mesh, extent = REACH + 12, size = Math.ceil(extent * 2 / CELL) + 1;
  const minX = center.x - extent, minZ = center.z - extent, cells = new Map<number, number[]>();
  for (let triangle = 0; triangle < surfaces.length; triangle++) {
    const a = indices[triangle*3]*3, b = indices[triangle*3+1]*3, c = indices[triangle*3+2]*3;
    const x0 = Math.min(v[a], v[b], v[c]), x1 = Math.max(v[a], v[b], v[c]);
    const z0 = Math.min(v[a+2], v[b+2], v[c+2]), z1 = Math.max(v[a+2], v[b+2], v[c+2]);
    if (x1 < minX || z1 < minZ || x0 > center.x + extent || z0 > center.z + extent) continue;
    const y0 = Math.min(v[a+1], v[b+1], v[c+1]), y1 = Math.max(v[a+1], v[b+1], v[c+1]);
    if (y1 < center.y - 40 || y0 > center.y + 40) continue;
    const cx0 = Math.max(0, Math.floor((x0-minX)/CELL)), cx1 = Math.min(size-1, Math.floor((x1-minX)/CELL));
    const cz0 = Math.max(0, Math.floor((z0-minZ)/CELL)), cz1 = Math.min(size-1, Math.floor((z1-minZ)/CELL));
    for (let cx = cx0; cx <= cx1; cx++) for (let cz = cz0; cz <= cz1; cz++) {
      const key = cx*size + cz, list = cells.get(key);
      if (list) list.push(triangle); else cells.set(key, [triangle]);
    }
  }
  const cell = (x: number, z: number) => {
    const cx = Math.floor((x-minX)/CELL), cz = Math.floor((z-minZ)/CELL);
    return cx < 0 || cz < 0 || cx >= size || cz >= size ? undefined : cells.get(cx*size + cz);
  };
  /** Every surface directly above or below a point. */
  const down = (x: number, z: number): Hit[] => {
    const hits: Hit[] = [];
    for (const triangle of cell(x, z) ?? []) {
      const a = indices[triangle*3]*3, b = indices[triangle*3+1]*3, c = indices[triangle*3+2]*3;
      const abx = v[b]-v[a], abz = v[b+2]-v[a+2], acx = v[c]-v[a], acz = v[c+2]-v[a+2];
      const det = abx*acz - abz*acx;
      if (Math.abs(det) < 1e-9) continue;
      const px = x-v[a], pz = z-v[a+2], s = (px*acz - pz*acx)/det, t = (abx*pz - abz*px)/det;
      if (s < -1e-6 || t < -1e-6 || s + t > 1 + 1e-6) continue;
      const aby = v[b+1]-v[a+1], acy = v[c+1]-v[a+1];
      const nx = aby*acz - abz*acy, ny = abz*acx - abx*acz, nz = abx*acy - aby*acx;
      hits.push({ y: v[a+1] + s*aby + t*acy, surface: surfaces[triangle], normalY: Math.abs(ny) / (Math.hypot(nx, ny, nz) || 1) });
    }
    return hits;
  };
  /** Whether a horizontal segment (a car body moving sideways) passes through any face. */
  const blocked = (from: Vec3, to: Vec3) => {
    const dx = to.x-from.x, dz = to.z-from.z;
    const candidates = new Set([...cell(from.x, from.z) ?? [], ...cell(to.x, to.z) ?? []]);
    for (const triangle of candidates) {
      const a = indices[triangle*3]*3, b = indices[triangle*3+1]*3, c = indices[triangle*3+2]*3;
      const e1x = v[b]-v[a], e1y = v[b+1]-v[a+1], e1z = v[b+2]-v[a+2], e2x = v[c]-v[a], e2y = v[c+1]-v[a+1], e2z = v[c+2]-v[a+2];
      // Möller–Trumbore with a horizontal direction (dx, 0, dz).
      const px = -dz*e2y, py = dz*e2x - dx*e2z, pz = dx*e2y;
      const det = e1x*px + e1y*py + e1z*pz;
      if (Math.abs(det) < 1e-9) continue;
      const tx = from.x-v[a], ty = from.y-v[a+1], tz = from.z-v[a+2];
      const u = (tx*px + ty*py + tz*pz)/det;
      if (u < 0 || u > 1) continue;
      const qx = ty*e1z - tz*e1y, qy = tz*e1x - tx*e1z, qz = tx*e1y - ty*e1x;
      const w = (dx*qx + dz*qz)/det;
      if (w < 0 || u + w > 1) continue;
      const t = (e2x*qx + e2y*qy + e2z*qz)/det;
      if (t >= 0 && t <= 1) return true;
    }
    return false;
  };
  return { down, blocked };
}
type Query = ReturnType<typeof localSurface>;

/** The floor closest to `reference`, ignoring bridges overhead and tunnels below. */
function floor(hits: Hit[], reference: number, up: number, below: number) {
  let best: Hit | undefined;
  for (const hit of hits) {
    const dy = hit.y - reference;
    if (dy > up || dy < -below || hit.normalY < .55) continue;
    if (!best || Math.abs(dy) < Math.abs(best.y - reference)) best = hit;
  }
  return best;
}

const horizontal = (value: Vec3): Vec3 => { const length = Math.hypot(value.x, value.z) || 1; return { x: value.x/length, y: 0, z: value.z/length }; };
const sideOf = (forward: Vec3): Vec3 => ({ x: forward.z, y: 0, z: -forward.x });
const at = (origin: Vec3, forward: Vec3, along: number, side: Vec3, lateral: number, y = origin.y): Vec3 =>
  ({ x: origin.x + forward.x*along + side.x*lateral, y, z: origin.z + forward.z*along + side.z*lateral });

/** Walks sideways from the gate until a barrier, a drop or the reach limit. */
function walk(query: Query, origin: Vec3, side: Vec3, start: Hit) {
  const samples: Sample[] = [{ lateral: 0, y: start.y, surface: start.surface }];
  for (const direction of [1, -1]) {
    let previous = start.y, last = 0, misses = 0;
    for (let index = 1; index * GATE_STEP <= REACH; index++) {
      const lateral = direction * index * GATE_STEP, point = at(origin, side, 0, side, lateral);
      const lastPoint = at(origin, side, 0, side, last * direction);
      if (query.blocked({ ...lastPoint, y: previous + BODY }, { ...point, y: previous + BODY })) break;
      const hits = query.down(point.x, point.z);
      // A face just above the floor is the top of a barrier, tyre wall or kerb block.
      if (hits.some(hit => hit.y - previous > .4 && hit.y - previous < 2.5)) break;
      const hit = floor(hits, previous, .4, 1.2);
      if (!hit) { if (++misses > 3) break; continue; }
      misses = 0; previous = hit.y; last = index * GATE_STEP;
      samples.push({ lateral, y: hit.y, surface: hit.surface });
    }
  }
  return samples.sort((a, b) => a.lateral - b.lateral);
}

/** The hard-surface run nearest the gate, bridging painted lines and small seams. */
function roadRun(samples: Sample[], routeWidth: number) {
  const runs: [number, number][] = [];
  let begin: number | undefined, end = 0;
  for (const sample of samples) {
    if (sample.surface !== 0) continue;
    if (begin !== undefined && sample.lateral - end <= 1.5) end = sample.lateral;
    else { if (begin !== undefined) runs.push([begin, end]); begin = end = sample.lateral; }
  }
  if (begin !== undefined) runs.push([begin, end]);
  const distance = ([a, b]: [number, number]) => a <= 0 && b >= 0 ? 0 : Math.min(Math.abs(a), Math.abs(b));
  const run = runs.filter(([a, b]) => b - a >= MIN_ROAD).sort((p, q) => distance(p) - distance(q))[0];
  if (!run) return;
  // Paved run-off, a gravel trap modelled as hard ground or an open pit lane
  // can continue past the circuit edge. Paint the route width around the
  // driven line instead of the whole slab.
  if (run[1] - run[0] > MAX_ROAD) {
    const half = Math.min(routeWidth, MAX_ROAD)/2, middle = Math.max(run[0] + half, Math.min(run[1] - half, 0));
    return [middle - half, middle + half] as [number, number];
  }
  return run;
}

function startFloor(query: Query, gate: Gate) {
  // Driven placements sit on the road; authored routes can be metres off it.
  const hits = query.down(gate.position.x, gate.position.z);
  return floor(hits, gate.position.y, 2.5, 2.5) ?? floor(hits, gate.position.y, 15, 15);
}

/** Fallback for tracks without physical geometry: the original route-width gate. */
function unfitted(gate: Gate): FittedGate {
  const forward = horizontal(gate.forward), half = gate.width/2 + .8;
  return { ...gate, forward, side: sideOf(forward), left: -half, right: half, roadLeft: -gate.width/2, roadRight: gate.width/2,
    heights: [0, 0], heightAt: () => gate.position.y };
}

export function fitGate(gate: Gate, mesh?: GateMesh): FittedGate {
  if (!mesh) return unfitted(gate);
  const query = localSurface(mesh, gate.position), start = startFloor(query, gate);
  if (!start) return unfitted(gate);
  const origin: Vec3 = { ...gate.position, y: start.y };
  let forward = horizontal(gate.forward), side = sideOf(forward);
  let samples = walk(query, origin, side, start), road = roadRun(samples, gate.width);
  // A checkpoint dropped mid-slide carries the car's yaw, not the road's.
  // Align with the road when both asphalt edges agree on its direction.
  if (road) {
    const middle = (road[0] + road[1])/2;
    const edges = [-5, 5].map(along => {
      const point = at(origin, forward, along, side, middle), hit = floor(query.down(point.x, point.z), start.y, 2, 2);
      const run = hit && roadRun(walk(query, { ...point, y: hit.y }, side, hit), gate.width);
      return run && [at(point, side, 0, side, run[0]), at(point, side, 0, side, run[1])];
    });
    if (edges[0] && edges[1]) {
      const [[l0, r0], [l1, r1]] = edges as Vec3[][];
      const leftDirection = horizontal({ x: l1.x-l0.x, y: 0, z: l1.z-l0.z }), rightDirection = horizontal({ x: r1.x-r0.x, y: 0, z: r1.z-r0.z });
      const average = horizontal({ x: leftDirection.x + rightDirection.x, y: 0, z: leftDirection.z + rightDirection.z });
      const turn = average.x*forward.x + average.z*forward.z;
      if (leftDirection.x*rightDirection.x + leftDirection.z*rightDirection.z > Math.cos(8 * Math.PI/180) && turn > Math.cos(35 * Math.PI/180) && turn < Math.cos(Math.PI/180)) {
        forward = average; side = sideOf(forward);
        samples = walk(query, origin, side, start); road = roadRun(samples, gate.width) ?? road;
      }
    }
  }
  const [roadA, roadB] = road ?? [Math.max(samples[0].lateral, -gate.width/2), Math.min(samples.at(-1)!.lateral, gate.width/2)];
  // Centre the gate on the asphalt so checkpoint recovery lands mid-track.
  const middle = (roadA + roadB)/2, center = samples.reduce((best, sample) => Math.abs(sample.lateral - middle) < Math.abs(best.lateral - middle) ? sample : best);
  const position = at(origin, forward, 0, side, middle, center.y);
  // The car body overhangs its centre, so extend past the last floor sample.
  const left = Math.min(samples[0].lateral - OVERHANG, roadA - 3) - middle, right = Math.max(samples.at(-1)!.lateral + OVERHANG, roadB + 3) - middle;
  const heights: number[] = [];
  for (let index = 0; left + index * GATE_STEP <= right + 1e-6; index++) {
    const lateral = left + index * GATE_STEP + middle;
    const nearest = samples.reduce((best, sample) => Math.abs(sample.lateral - lateral) < Math.abs(best.lateral - lateral) ? sample : best);
    heights.push(nearest.y - center.y);
  }
  const heightAt = (along: number, lateral: number) => {
    const point = at(position, forward, along, side, lateral);
    const index = Math.max(0, Math.min(heights.length - 1, Math.round((lateral - left) / GATE_STEP)));
    return floor(query.down(point.x, point.z), center.y + heights[index], .6, .6)?.y ?? center.y + heights[index];
  };
  return { position, forward, rotation: orientation(forward), width: right - left, segment: gate.segment, side, left, right,
    roadLeft: roadA - middle, roadRight: roadB - middle, heights, heightAt };
}

/** Whether a point where the car crosses a gate plane lies inside the gate. */
export function insideGate(gate: FittedGate, point: Vec3) {
  const dx = point.x - gate.position.x, dz = point.z - gate.position.z;
  const lateral = dx*gate.side.x + dz*gate.side.z;
  if (lateral < gate.left || lateral > gate.right) return false;
  const position = (lateral - gate.left) / GATE_STEP, index = Math.max(0, Math.min(gate.heights.length - 2, Math.floor(position)));
  const t = Math.min(1, position - index), surface = gate.heights[index] + (gate.heights[index + 1] - gate.heights[index]) * t;
  const clearance = point.y - gate.position.y - surface;
  return clearance > -2 && clearance < 7;
}

const fitted = new Map<string, FittedGate>();
/** Fitted gates are cached by venue and placement, so restarts are free. */
export function fittedGate(track: Track, gate: Gate, mesh?: GateMesh) {
  const key = `${track.id}|${mesh ? 1 : 0}|${gate.position.x},${gate.position.y},${gate.position.z},${gate.forward.x},${gate.forward.z},${gate.width}`;
  let result = fitted.get(key);
  if (!result) { result = fitGate(gate, mesh); fitted.set(key, result); }
  return result;
}
export const fittedGates = (track: Track, mesh?: GateMesh) =>
  ({ checkpoints: track.checkpoints.map(gate => fittedGate(track, gate, mesh)), finish: fittedGate(track, track.finish, mesh) });
