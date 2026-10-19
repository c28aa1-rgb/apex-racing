// Bakes a racing line for every circuit into shared/racing-lines.ts.
//
//   node --max-old-space-size=4096 --import tsx design/build-racing-lines.ts [--track=id[,id]] [--map=work/racing-line]
//
// 1. The shipped drive trace (track.mapPath, grid to finish) is the reference for where the circuit runs.
// 2. The venue's collision mesh is rasterised (CELL units) near the trace: asphalt, grass, gravel and walls
//    standing over half a metre, at the trace's level (bridges above and tunnels below are ignored). Where the
//    venue's textures show clearly what a cell is (design/surfaces, from design/build-venue-surface.ts), that
//    replaces the collision label, which is wrong in places.
// 3. The trace is redrawn as the cheapest path along it over that raster (asphalt cheap, grass affordable, gravel
//    dear, walls closed, all dearer away from the trace), so it follows the road where the driver ran wide. Where
//    the trace passes through a wall, the line follows the trace and the bake says so.
// 4. Drivable = labelled asphalt within REACH of that reference plus grass within TRUST of it, connected to it.
//    A signed distance field to its edge (WALL_MARGIN from walls, MARGIN from anything else) is built.
// 5. A minimum-curvature band is relaxed from the reference, coarse to fine: each station moves along its normal
//    towards the point that minimises the squared second difference with its neighbours, never through a wall,
//    then is pushed along its normal until it is clear of the edge.
// 6. Every segment is checked against the field; --map writes an overhead BMP per circuit for a visual check.
//    tests/racing-line-audit.ts then drives every line, and /tests/racing-line-inspection.html draws it over
//    the textured venue.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';
import { collisionGeometry } from '../shared/physics';
import { TRACKS, type Track, type Vec3 } from '../shared/tracks';
import type { BakedLine } from '../shared/racing-line';

/** Metres between final stations, car-centre clearance from the edge, ribbon half width (m). */
const STEP = 4, MARGIN = 1.7, RIBBON = .45;
/** Car-centre clearance from a solid wall (m): more than from a grass or gravel edge. */
const WALL_MARGIN = 2.8;
/**
 * Raster cell (native units); how far from the trace the line may use labelled asphalt, and the corridor along the
 * trace it may use over any other floor (m). The venue's surface labels are wrong in places both ways (atlas
 * textures: real road labelled grass, gravel traps and run-off labelled asphalt), so the trace decides where the
 * circuit runs and the labels only widen it nearby.
 */
const CELL = .5, REACH = 8, TRUST = 2.5;
/** How far from the trace the least-cost path may look for the road (m). */
const SEARCH = 30;
const arg = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const only = arg('track')?.split(','), mapDir = arg('map');

type P = { x: number; y: number; z: number };
const wrap = (i: number, n: number) => ((i % n) + n) % n;

const lapLength = (points: P[]) => points.reduce((sum, p, i) => { const q = points[wrap(i + 1, points.length)]; return sum + Math.hypot(q.x - p.x, q.z - p.z); }, 0);

/** `count` points evenly spaced along a polyline, around it when `closed`. */
function resample(points: P[], count: number, closed = true): P[] {
  const n = points.length, edges = closed ? n : n - 1, lengths: number[] = [];
  for (let i = 0; i < edges; i++) { const a = points[i], b = points[(i + 1) % n]; lengths.push(Math.hypot(b.x - a.x, b.z - a.z)); }
  const out: P[] = [], spacing = lengths.reduce((sum, l) => sum + l, 0) / (closed ? count : count - 1);
  let i = 0, walked = 0;
  for (let k = 0; k < count; k++) {
    const target = k * spacing;
    while (i < edges - 1 && walked + lengths[i] < target) walked += lengths[i++];
    const a = points[i], b = points[(i + 1) % n], t = lengths[i] ? Math.min(1, (target - walked) / lengths[i]) : 0;
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
  }
  return out;
}

function smooth(values: P[], sigma: number, closed = true): P[] {
  const n = values.length, reach = Math.ceil(sigma * 3);
  return values.map((_, i) => {
    let total = 0, x = 0, y = 0, z = 0;
    for (let k = -reach; k <= reach; k++) {
      if (!closed && (i + k < 0 || i + k >= n)) continue;
      const g = Math.exp(-k * k / (2 * sigma * sigma)), v = values[wrap(i + k, n)]; total += g; x += v.x * g; y += v.y * g; z += v.z * g;
    }
    return { x: x / total, y: y / total, z: z / total };
  });
}

/** Exact Euclidean distance (cells) to the nearest feature cell (Felzenszwalb & Huttenlocher). */
function distanceTransform(feature: Uint8Array, W: number, H: number): Float32Array {
  const INF = 1e20, d = new Float64Array(W * H), size = Math.max(W, H);
  const f = new Float64Array(size), out = new Float64Array(size), v = new Int32Array(size), z = new Float64Array(size + 1);
  const pass = (length: number) => {
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < length; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < length; q++) { while (z[k + 1] < q) k++; out[q] = (q - v[k]) ** 2 + f[v[k]]; }
  };
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) f[y] = feature[y * W + x] ? 0 : INF;
    pass(H); for (let y = 0; y < H; y++) d[y * W + x] = out[y];
  }
  const result = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) f[x] = d[y * W + x];
    pass(W); for (let x = 0; x < W; x++) result[y * W + x] = Math.sqrt(out[x]);
  }
  return result;
}

/** Surface classes in the raster: the collision labels, then no floor and wall. */
const ASPHALT = 0, GRASS = 1, NONE = 3, WALL = 4;

/** A circuit's visual surface map (design/surfaces/<id>.bin.gz), if built. */
function loadSurface(id: string) {
  const file = `design/surfaces/${id}.bin.gz`;
  if (!existsSync(file)) return undefined;
  const bytes = gunzipSync(readFileSync(file)), header = new Int32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + 20));
  return { x0: header[0] / 100, z0: header[1] / 100, cell: header[2] / 1000, width: header[3], height: header[4], cells: bytes.subarray(20) };
}

async function bake(track: Track) {
  const mpu = track.metersPerUnit, margin = MARGIN / mpu;
  const { vertices: v, indices, surfaces, walls } = await collisionGeometry(track);
  // The trace as driven (grid to finish, open), every 2 m: it places the raster and the road's level.
  const driven = track.mapPath!.map(p => ({ ...p }));
  // Lap in race direction: the timing gates only count when crossed along their forward direction, and a trace
  // recorded the other way round would put every braking zone on the wrong side of its corner.
  const along = [...track.checkpoints, track.finish].reduce((sum, gate) => {
    let best = Infinity, at = 1;
    for (let i = 1; i < driven.length - 1; i++) { const d = Math.hypot(driven[i].x - gate.position.x, driven[i].z - gate.position.z); if (d < best) { best = d; at = i; } }
    const dx = driven[at + 1].x - driven[at - 1].x, dz = driven[at + 1].z - driven[at - 1].z;
    return sum + (dx * gate.forward.x + dz * gate.forward.z) / (Math.hypot(dx, dz) || 1);
  }, 0);
  if (along < 0) { driven.reverse(); console.warn(`  the drive trace runs against the timing gates: reversed`); }
  const drivenLength = driven.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - driven[i].x, p.z - driven[i].z), 0);
  const sampled = smooth(resample(driven, Math.round(drivenLength * mpu / 2), false), 1, false);

  // Raster bounds and a bucket index of the trace for nearest-point queries.
  // Wide enough to hold road the trace never drove: Daytona's grid lane runs 75 m inside the tri-oval it skips.
  const pad = 90 / mpu;
  const x0 = Math.min(...sampled.map(p => p.x)) - pad, z0 = Math.min(...sampled.map(p => p.z)) - pad;
  const W = Math.ceil((Math.max(...sampled.map(p => p.x)) + pad - x0) / CELL), H = Math.ceil((Math.max(...sampled.map(p => p.z)) + pad - z0) / CELL);
  const BUCKET = 8, buckets = new Map<number, number[]>(), key = (bx: number, bz: number) => bx * 100003 + bz;
  sampled.forEach((p, i) => { const k = key(Math.floor(p.x / BUCKET), Math.floor(p.z / BUCKET)); const list = buckets.get(k); if (list) list.push(i); else buckets.set(k, [i]); });
  const nearestTrace = (x: number, z: number, reach = pad) => {
    let best = Infinity, index = -1;
    const r = Math.ceil(reach / BUCKET), bx = Math.floor(x / BUCKET), bz = Math.floor(z / BUCKET);
    for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) for (const t of buckets.get(key(bx + i, bz + j)) ?? []) {
      const d = (sampled[t].x - x) ** 2 + (sampled[t].z - z) ** 2; if (d < best) { best = d; index = t; }
    }
    return { index, distance: Math.sqrt(best) };
  };

  // Rasterise floors at the trace's level (the face nearest the trace height wins), then walls standing on them.
  const cls = new Uint8Array(W * H).fill(NONE), height = new Float32Array(W * H), gap = new Float32Array(W * H).fill(Infinity), wallTriangles: number[] = [];
  for (let tri = 0; tri < surfaces.length; tri++) {
    const a = indices[tri*3]*3, b = indices[tri*3+1]*3, c = indices[tri*3+2]*3;
    const minX = Math.min(v[a], v[b], v[c]), maxX = Math.max(v[a], v[b], v[c]), minZ = Math.min(v[a+2], v[b+2], v[c+2]), maxZ = Math.max(v[a+2], v[b+2], v[c+2]);
    if (maxX < x0 || maxZ < z0 || minX > x0 + W * CELL || minZ > z0 + H * CELL) continue;
    const near = nearestTrace((v[a] + v[b] + v[c]) / 3, (v[a+2] + v[b+2] + v[c+2]) / 3, pad + Math.max(maxX - minX, maxZ - minZ));
    if (near.index < 0) continue;
    const ty = sampled[near.index].y;
    const e1x = v[b]-v[a], e1y = v[b+1]-v[a+1], e1z = v[b+2]-v[a+2], e2x = v[c]-v[a], e2y = v[c+1]-v[a+1], e2z = v[c+2]-v[a+2];
    const nx = e1y*e2z - e1z*e2y, ny = e1z*e2x - e1x*e2z, nz = e1x*e2y - e1y*e2x, upright = Math.abs(ny) / (Math.hypot(nx, ny, nz) || 1);
    const minY = Math.min(v[a+1], v[b+1], v[c+1]), maxY = Math.max(v[a+1], v[b+1], v[c+1]);
    if (walls ? walls[tri] === 1 : upright < .55 && maxY - minY > .5) {
      if (maxY >= ty - .3 && minY <= ty + 2.5) wallTriangles.push(tri);
      continue;
    }
    if (upright < .55) continue;
    const det = e1x * e2z - e1z * e2x;
    if (Math.abs(det) < 1e-12) continue;
    for (let gx = Math.max(0, Math.floor((minX - x0) / CELL)); gx <= Math.min(W - 1, Math.floor((maxX - x0) / CELL)); gx++)
      for (let gz = Math.max(0, Math.floor((minZ - z0) / CELL)); gz <= Math.min(H - 1, Math.floor((maxZ - z0) / CELL)); gz++) {
        const cx = x0 + (gx + .5) * CELL, cz = z0 + (gz + .5) * CELL, px = cx - v[a], pz = cz - v[a+2];
        const s = (px * e2z - pz * e2x) / det, t = (e1x * pz - e1z * px) / det;
        if (s < 0 || t < 0 || s + t > 1) continue;
        const y = v[a+1] + s * e1y + t * e2y, k = gz * W + gx, dy = Math.abs(y - ty);
        // Banking climbs away from the trace, so the height window widens with distance from it.
        if (dy > 2 + .6 * Math.hypot(cx - sampled[near.index].x, cz - sampled[near.index].z) || dy >= gap[k]) continue;
        gap[k] = dy; height[k] = y;
        if (cls[k] !== WALL) cls[k] = surfaces[tri];
      }
  }

  // A wall counts where it stands more than half a metre above the floor beside it (tests/smooth-route.ts
  // realBarrier); lower steps, kerb risers and seam skirts are driven over.
  for (const tri of wallTriangles) {
    const a = indices[tri*3]*3, b = indices[tri*3+1]*3, c = indices[tri*3+2]*3, top = Math.max(v[a+1], v[b+1], v[c+1]);
    const e1x = v[b]-v[a], e1z = v[b+2]-v[a+2], e2x = v[c]-v[a], e2z = v[c+2]-v[a+2];
    const steps = Math.ceil(Math.max(Math.hypot(e1x, e1z), Math.hypot(e2x, e2z)) / (CELL / 2)) + 1;
    for (let i = 0; i <= steps; i++) for (let j = 0; i + j <= steps; j++) {
      const gx = Math.floor((v[a] + (e1x * i + e2x * j) / steps - x0) / CELL), gz = Math.floor((v[a+2] + (e1z * i + e2z * j) / steps - z0) / CELL);
      if (gx < 0 || gz < 0 || gx >= W || gz >= H) continue;
      let floorY = Infinity;
      for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
        const k = (gz + dz) * W + gx + dx;
        if (gx + dx >= 0 && gz + dz >= 0 && gx + dx < W && gz + dz < H && Number.isFinite(gap[k]) && cls[k] !== WALL) floorY = Math.min(floorY, height[k]);
      }
      if (!Number.isFinite(floorY) || top - floorY > .5) cls[gz * W + gx] = WALL;
    }
  }
  // Thicken walls by a cell so a thin diagonal barrier has no gaps between its cells.
  {
    const thin = cls.slice();
    for (let k = 0; k < W * H; k++) if (thin[k] === WALL) for (const j of [k - 1, k + 1, k - W, k + W]) if (j >= 0 && j < W * H) cls[j] = WALL;
  }
  // What the venue looks like beats its collision labels (design/build-venue-surface.ts): road, grass or gravel
  // from the textures wherever they are clear; walls stay as the collision mesh has them.
  const visual = loadSurface(track.id);
  let repainted = 0;
  if (visual) for (let gz = 0; gz < H; gz++) for (let gx = 0; gx < W; gx++) {
    const k = gz * W + gx;
    if (cls[k] === WALL || cls[k] === NONE) continue;
    const X = Math.floor((x0 + (gx + .5) * CELL - visual.x0) / visual.cell), Z = Math.floor((z0 + (gz + .5) * CELL - visual.z0) / visual.cell);
    const seen = X >= 0 && Z >= 0 && X < visual.width && Z < visual.height ? visual.cells[Z * visual.width + X] : 255;
    if (seen === 255 || seen === cls[k]) continue;
    cls[k] = seen; repainted++;
  }
  const cellOf = (p: P) => Math.floor((p.z - z0) / CELL) * W + Math.floor((p.x - x0) / CELL);
  const COST = [1, 3, 15, 40, Infinity], CLOSING_COST = [1, 30, 30, 60, Infinity];
  // Dijkstra on 8-connected cells inside a box, with a binary heap; `dist`/`from` are reset after each search.
  const dist = new Float64Array(W * H).fill(Infinity), from = new Int32Array(W * H).fill(-1), seen: number[] = [];
  const boxAround = (points: P[], reach: number) => [
    Math.max(0, Math.floor((Math.min(...points.map(p => p.x)) - reach - x0) / CELL)), Math.min(W - 1, Math.ceil((Math.max(...points.map(p => p.x)) + reach - x0) / CELL)),
    Math.max(0, Math.floor((Math.min(...points.map(p => p.z)) - reach - z0) / CELL)), Math.min(H - 1, Math.ceil((Math.max(...points.map(p => p.z)) + reach - z0) / CELL)),
  ] as const;
  const search = (start: number, [minX, maxX, minZ, maxZ]: readonly number[], cost: (k: number) => number, goal = -1, closed?: (k: number) => boolean) => {
    for (const k of seen) { dist[k] = Infinity; from[k] = -1; }
    seen.length = 0;
    const heap: [number, number][] = [];
    const push = (d: number, k: number) => { heap.push([d, k]); let i = heap.length - 1; while (i) { const up = (i - 1) >> 1; if (heap[up][0] <= heap[i][0]) break; [heap[up], heap[i]] = [heap[i], heap[up]]; i = up; } };
    const pop = () => { const top = heap[0], last = heap.pop()!; if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = i * 2 + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    dist[start] = 0; seen.push(start); push(0, start);
    while (heap.length) {
      const [d, k] = pop();
      if (k === goal) break;
      if (d > dist[k]) continue;
      const x = k % W, z = (k - x) / W;
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const X = x + dx, Z = z + dz;
        if ((!dx && !dz) || X < minX || X > maxX || Z < minZ || Z > maxZ) continue;
        // No squeezing diagonally between two wall cells.
        if (dx && dz && (cls[z * W + X] === WALL || cls[Z * W + x] === WALL)) continue;
        const j = Z * W + X;
        if (closed?.(j)) continue;
        const next = d + (dx && dz ? Math.SQRT2 : 1) * (cost(k) + cost(j)) / 2;
        if (next < dist[j]) { if (dist[j] === Infinity) seen.push(j); dist[j] = next; from[j] = k; push(next, j); }
      }
    }
  };
  /** Cells from `start` to `goal` of the last search, or undefined if it never reached `goal`. */
  const pathTo = (start: number, goal: number) => {
    const path: number[] = [];
    for (let k = goal; k >= 0 && k !== start; k = from[k]) path.push(k);
    return path.length && (from[path.at(-1)!] === start || path.at(-1) === start) ? path.reverse() : undefined;
  };
  const centre = (k: number): P => { const x = k % W, z = (k - x) / W; return { x: x0 + (x + .5) * CELL, y: 0, z: z0 + (z + .5) * CELL }; };

  // One lap: from the finish, the cheapest way on along the road (never back past the line) to a point of the trace's
  // opening stretch, choosing the one that leaves least of the trace unused. That cuts a trace that ran on past its
  // start, bridges one that stopped short, and joins one that starts on a grid lane beside the circuit (Daytona's pit
  // road) where it meets the circuit, instead of straight across the infield.
  const trace: P[] = [];
  {
    const n = sampled.length, ends = Math.floor(n * .15), end = sampled[n - 1], before = sampled[n - 3];
    const hx = end.x - before.x, hz = end.z - before.z, hl = Math.hypot(hx, hz) || 1, finish = cellOf(end);
    const behind = (k: number) => { const p = centre(k), dx = p.x - end.x, dz = p.z - end.z; return Math.hypot(dx, dz) * mpu < 25 && (dx * hx + dz * hz) / hl * mpu < -3; };
    // Off the road is dear here: the visible surface is known, and a lap never closes across an infield.
    search(finish, boxAround([...sampled.slice(0, ends), ...sampled.slice(n - ends)], 60 / mpu), k => CLOSING_COST[cls[k]], -1, behind);
    let best = Infinity, join = 0, unused = 0;
    for (let i = 0; i < ends; i++) {
      if (i) unused += Math.hypot(sampled[i].x - sampled[i - 1].x, sampled[i].z - sampled[i - 1].z);
      // Unused trace counts half: dropping a grid lane beats driving back down it to its first point.
      const score = dist[cellOf(sampled[i])] + unused / CELL * .5;
      if (score < best) { best = score; join = i; }
    }
    const bridge = Number.isFinite(best) ? pathTo(finish, cellOf(sampled[join])) : undefined;
    if (!bridge) throw new Error(`${track.id}: no road from the finish back to the start of the trace`);
    const loop = [...sampled.slice(join), ...bridge.slice(0, -1).map(centre)];
    trace.push(...smooth(resample(loop, Math.round(lapLength(loop) * mpu / 2)), 1));
    if (bridge.length * CELL * mpu > 40) console.warn(`  the trace's ends are ${(bridge.length * CELL * mpu).toFixed(0)} m of road apart: the lap closes along the road`);
  }

  // The trace runs wide into gravel traps and run-off in places (driving errors, not the circuit). The reference
  // is rebuilt as the cheapest path along it over the raster, a hundred metres at a time: asphalt is cheap, grass
  // affordable (real road is labelled grass in places), gravel and bare ground dear, walls closed, and every cell
  // dearer the further it lies from the trace, so the path follows the road where the trace ran wide but does not
  // cut a chicane across a trap that happens to be labelled asphalt.
  const traceCells = new Uint8Array(W * H);
  // Only where the trace is on the road does it pull the path: where it ran wide it would drag the path to the edge.
  for (const p of trace) { const k = cellOf(p); if (k >= 0 && k < W * H && (cls[k] === ASPHALT || cls[k] === GRASS)) traceCells[k] = 1; }
  const fromTrace = distanceTransform(traceCells, W, H);
  const cost = (k: number) => COST[cls[k]] * (1 + (fromTrace[k] * CELL * mpu / 8) ** 2);
  const reference: P[] = [], throughWalls: string[] = [], corridor = Math.ceil((TRUST + MARGIN) / mpu / CELL);
  let strays = 0;
  {
    const chunk = Math.round(100 / 2), anchors: number[] = [];
    for (let i = 0; i < trace.length; i += chunk) {
      // Anchor each leg on a trace point that is on asphalt where possible.
      let best = i;
      for (let k = 0; k < chunk / 2 && i + k < trace.length; k++) if (cls[cellOf(trace[i + k])] === ASPHALT) { best = i + k; break; }
      anchors.push(best);
    }
    for (let leg = 0; leg < anchors.length; leg++) {
      const a = anchors[leg], b = anchors[(leg + 1) % anchors.length], start = cellOf(trace[a]), goal = cellOf(trace[b]);
      const span = b > a ? trace.slice(a, b + 1) : [...trace.slice(a), ...trace.slice(0, b + 1)];
      search(start, boxAround(span, SEARCH / mpu), cost, goal);
      const path = pathTo(start, goal);
      if (!path) {
        // The trace passes through a wall here (it was recorded before the venue's barriers were solid, or
        // squeezes through a gap). The circuit is what the trace says: follow it, and open a corridor along it.
        throughWalls.push(`${trace[a].x.toFixed(0)},${trace[a].z.toFixed(0)}`);
        reference.push(...span.map(p => ({ ...p })));
        for (const p of span) for (let dx = -corridor; dx <= corridor; dx++) for (let dz = -corridor; dz <= corridor; dz++) {
          const k = cellOf(p) + dz * W + dx;
          if (dx * dx + dz * dz <= corridor * corridor && k >= 0 && k < W * H) cls[k] = GRASS;
        }
        continue;
      }
      reference.push(...path.map(centre));
    }
  }
  strays = trace.filter(p => cls[cellOf(p)] !== ASPHALT && cls[cellOf(p)] !== GRASS).length;
  {
    const smoothed = smooth(resample(reference, Math.round(lapLength(reference) * mpu / 2)), 1.5);
    reference.length = 0; reference.push(...smoothed);
  }
  // A gap between barriers too narrow to keep the wall margin either side (the trace squeezes through one): open a
  // corridor along the reference there, as where it crosses a wall, so the line passes straight through rather
  // than folding up trying to keep clear of both sides.
  const narrow: string[] = [];
  {
    const toWall = distanceTransform(cls.map(c => c === WALL ? 1 : 0), W, H), clear = WALL_MARGIN / mpu;
    let last = -Infinity;
    // Free width across the reference: the first wall cell either side along its normal (units).
    const across = (p: P, i: number) => {
      const a = reference[wrap(i - 2, reference.length)], b = reference[wrap(i + 2, reference.length)], l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const nx = (b.z - a.z) / l, nz = -(b.x - a.x) / l;
      let width = 0;
      for (const sign of [1, -1]) {
        let t = 0;
        while (t < clear * 2 && cls[cellOf({ x: p.x + nx * t * sign, y: 0, z: p.z + nz * t * sign })] !== WALL) t += CELL / 2;
        width += t;
      }
      return width;
    };
    reference.forEach((p, i) => {
      const k = cellOf(p);
      if (k < 0 || k >= W * H || toWall[k] * CELL >= clear || across(p, i) >= clear * 2) return;
      if (i - last > 10) narrow.push(`${p.x.toFixed(0)},${p.z.toFixed(0)}`);
      last = i;
      for (let dx = -corridor; dx <= corridor; dx++) for (let dz = -corridor; dz <= corridor; dz++) {
        const j = k + dz * W + dx;
        if (dx * dx + dz * dz <= corridor * corridor && j >= 0 && j < W * H && (cls[j] === WALL || cls[j] === NONE)) cls[j] = GRASS;
      }
    });
  }

  const rasterise = (points: P[]) => {
    const mask = new Uint8Array(W * H);
    for (let i = 0; i < points.length; i++) {
      const p = points[i], q = points[wrap(i + 1, points.length)], steps = Math.ceil(Math.hypot(q.x - p.x, q.z - p.z) / (CELL / 2)) + 1;
      for (let s = 0; s <= steps; s++) {
        const gx = Math.floor((p.x + (q.x - p.x) * s / steps - x0) / CELL), gz = Math.floor((p.z + (q.z - p.z) * s / steps - z0) / CELL);
        if (gx >= 0 && gz >= 0 && gx < W && gz < H) mask[gz * W + gx] = 1;
      }
    }
    return mask;
  };
  const onReference = rasterise(reference), toReference = distanceTransform(onReference, W, H);
  // Grass is open only around stretches where the reference itself runs over it (a shortcut the circuit is built
  // around, or road the textures could not call); elsewhere a grass verge is the edge of the track.
  const grassReference = new Uint8Array(W * H);
  for (let k = 0; k < W * H; k++) if (onReference[k] && cls[k] === GRASS) grassReference[k] = 1;
  const toGrassReference = distanceTransform(grassReference, W, H);
  const reach = REACH / mpu / CELL, trust = (TRUST + MARGIN) / mpu / CELL;
  // Drivable: road near the reference, or grass where the reference runs over it (gravel and walls never). Only the part connected
  // to the trace counts (no islands of a neighbouring road).
  const connected = new Uint8Array(W * H), sdf = new Float32Array(W * H), edge = new Float32Array(W * H);
  {
    const drivable = new Uint8Array(W * H);
    for (let k = 0; k < W * H; k++)
      drivable[k] = (cls[k] === ASPHALT && toReference[k] <= reach) || (cls[k] === GRASS && toGrassReference[k] <= trust) ? 1 : 0;
    const stack: number[] = [];
    for (let k = 0; k < W * H; k++) if (onReference[k] && drivable[k]) { connected[k] = 1; stack.push(k); }
    while (stack.length) {
      const k = stack.pop()!, x = k % W;
      for (const j of [x < W - 1 ? k + 1 : -1, x > 0 ? k - 1 : -1, k + W < W * H ? k + W : -1, k - W]) if (j >= 0 && drivable[j] && !connected[j]) { connected[j] = 1; stack.push(j); }
    }
    // Signed distance (units): positive inside the drivable area, negative outside.
    const inside = distanceTransform(connected.map(c => 1 - c), W, H), outside = distanceTransform(connected, W, H);
    // Solid walls get extra room: a driver a metre off the line must not touch one.
    const toWall = distanceTransform(cls.map(c => c === WALL ? 1 : 0), W, H), extra = (WALL_MARGIN - MARGIN) / mpu;
    for (let k = 0; k < W * H; k++) { edge[k] = (connected[k] ? inside[k] - .5 : .5 - outside[k]) * CELL; sdf[k] = Math.min(edge[k], (toWall[k] - .5) * CELL - extra); }
  }
  const sample = (grid: Float32Array, x: number, z: number) => {
    const fx = (x - x0) / CELL - .5, fz = (z - z0) / CELL - .5, ix = Math.max(0, Math.min(W - 2, Math.floor(fx))), iz = Math.max(0, Math.min(H - 2, Math.floor(fz)));
    const tx = Math.max(0, Math.min(1, fx - ix)), tz = Math.max(0, Math.min(1, fz - iz)), k = iz * W + ix;
    return (grid[k] * (1 - tx) + grid[k + 1] * tx) * (1 - tz) + (grid[k + W] * (1 - tx) + grid[k + W + 1] * tx) * tz;
  };
  /** Clearance the line keeps (units): from the drivable edge, or less a wall margin from a wall. */
  const field = (x: number, z: number) => sample(sdf, x, z);
  /** Whether the straight path between two points stays on drivable ground (never through a wall or off the road). */
  const clearPath = (a: P, b: P) => {
    const steps = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / (CELL / 2));
    for (let k = 1; k <= steps; k++) if (field(a.x + (b.x - a.x) * k / steps, a.z + (b.z - a.z) * k / steps) < 0) return false;
    return true;
  };
  /**
   * Moves a point along the band's normal (nx, nz) to the nearest offset `clear` of the edge, so stations keep
   * their order; where no offset within reach is clear (a corridor narrower than the margin), the clearest one.
   * The search never passes through a wall or off the road, so a station cannot hop onto a parallel road.
   */
  const project = (p: P, nx: number, nz: number, clear: number) => {
    const here = field(p.x, p.z);
    if (here >= clear) return;
    let best = 0, bestField = here;
    for (const sign of [1, -1]) {
      let inside = here >= 0;
      for (let step = 1; step * CELL / 2 <= reach * CELL; step++) {
        const t = sign * step * CELL / 2, f = field(p.x + nx * t, p.z + nz * t);
        if (inside && f < 0) break;
        inside ||= f >= 0;
        if (f >= clear) { if (Math.abs(t) < Math.abs(best) || bestField < clear) { best = t; bestField = f; } break; }
        if (f > bestField + 1e-6) { bestField = f; best = t; }
      }
    }
    p.x += nx * best; p.z += nz * best;
  };
  /** Moves a point straight up the distance field: the nearest drivable ground, for a band starting off it. */
  const snap = (p: P, clear: number) => {
    for (let it = 0; it < 80; it++) {
      const f = field(p.x, p.z);
      if (f >= clear) return;
      const gx = field(p.x + CELL, p.z) - field(p.x - CELL, p.z), gz = field(p.x, p.z + CELL) - field(p.x, p.z - CELL), g = Math.hypot(gx, gz);
      if (g < 1e-6) return;
      const move = Math.min(CELL, clear - f + .02);
      p.x += gx / g * move; p.z += gz / g * move;
    }
  };
  const normal = (band: P[], i: number) => {
    const n = band.length, a = band[wrap(i - 1, n)], b = band[wrap(i + 1, n)], fx = b.x - a.x, fz = b.z - a.z, l = Math.hypot(fx, fz) || 1;
    return [fz / l, -fx / l] as const;
  };
  /** Minimum-curvature band, coarse to fine (long corners settle at coarse spacing in fewer iterations). */
  const relax = (start: P[]) => {
    let band = start.map(p => ({ ...p }));
    band.forEach(p => snap(p, margin));
    for (const [spacing, iterations] of [[8, 2000], [STEP, 3000]] as const) {
      band = resample(band, Math.round(lapLength(band) * mpu / spacing));
      const n = band.length;
      band.forEach((p, i) => project(p, ...normal(band, i), margin));
      for (let it = 0; it < iterations; it++) {
        for (let i = 0; i < n; i++) {
          const p = band[i], a = band[wrap(i - 1, n)], b = band[wrap(i + 1, n)], aa = band[wrap(i - 2, n)], bb = band[wrap(i + 2, n)];
          const [nx, nz] = normal(band, i);
          const tx = (4 * (a.x + b.x) - aa.x - bb.x) / 6, tz = (4 * (a.z + b.z) - aa.z - bb.z) / 6;
          // Over-relaxed step along the normal only, so stations keep their spacing.
          const along = ((tx - p.x) * nx + (tz - p.z) * nz) * 1.5;
          const next = { x: p.x + nx * along, y: p.y, z: p.z + nz * along };
          if (clearPath(p, next)) { p.x = next.x; p.z = next.z; }
          project(p, nx, nz, margin);
        }
        if (it % 200 === 199) band = resample(band, n);
      }
    }
    return band;
  };
  const band = relax(reference);

  // Check, and read the road height under the ribbon's two edges.
  const n = band.length, points: number[] = [], close: string[] = [];
  let worst = Infinity, outside = Infinity, onGrass = 0;
  const floorY = (x: number, z: number, fallback: number) => {
    const gx = Math.floor((x - x0) / CELL), gz = Math.floor((z - z0) / CELL), k = gz * W + gx;
    return gx >= 0 && gz >= 0 && gx < W && gz < H && Number.isFinite(gap[k]) ? height[k] : fallback;
  };
  for (let i = 0; i < n; i++) {
    const p = band[i], a = band[wrap(i - 1, n)], b = band[wrap(i + 1, n)], l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const sx = (b.z - a.z) / l, sz = -(b.x - a.x) / l, half = RIBBON / mpu;
    // The whole segment to the next station, not just the station: a thin barrier can stand between two.
    let clearance = Infinity, inside = Infinity;
    const q = band[wrap(i + 1, n)];
    for (let k = 0; k < 8; k++) {
      const x = p.x + (q.x - p.x) * k / 8, z = p.z + (q.z - p.z) * k / 8;
      clearance = Math.min(clearance, field(x, z) * mpu); inside = Math.min(inside, sample(edge, x, z) * mpu);
    }
    outside = Math.min(outside, inside);
    worst = Math.min(worst, clearance);
    if (clearance < MARGIN / 2) close.push(`${i} (${clearance.toFixed(2)} m at ${p.x.toFixed(0)}, ${p.z.toFixed(0)})`);
    if (cls[Math.floor((p.z - z0) / CELL) * W + Math.floor((p.x - x0) / CELL)] === GRASS) onGrass++;
    const y = floorY(p.x, p.z, sampled[nearestTrace(p.x, p.z).index]?.y ?? p.y);
    points.push(+p.x.toFixed(2), +p.z.toFixed(2), +floorY(p.x - sx * half, p.z - sz * half, y).toFixed(2), +floorY(p.x + sx * half, p.z + sz * half, y).toFixed(2));
  }
  const offsets = band.map(p => nearestTrace(p.x, p.z).distance * mpu);
  console.log(`${track.id.padEnd(12)} ${n} stations, ${(lapLength(band) * mpu / 1000).toFixed(2)} km, raster ${W}x${H}, ` +
    `closest edge ${worst.toFixed(2)} m, ${visual ? `${(repainted / (W * H) * 100).toFixed(1)}% of cells repainted from the textures` : 'no surface map'}, ${strays} trace points off the road, ${onGrass} stations on the trace's grass corridor, max ${Math.max(...offsets).toFixed(1)} m from the trace at ${(() => { const i = offsets.indexOf(Math.max(...offsets)); return `${band[i].x.toFixed(0)}, ${band[i].z.toFixed(0)}`; })()}`);
  if (mapDir) console.log(`  map origin x ${x0.toFixed(1)}, z ${z0.toFixed(1)}, ${CELL} units per pixel`);
  if (mapDir) writeMap(`${mapDir}/${track.id}.bmp`, W, H, cls, connected, onReference, band.map(p => [(p.x - x0) / CELL, (p.z - z0) / CELL]));
  // Where the trace squeezes through a gap narrower than two margins (between barrier sections, its grass
  // shortcuts) a few stations come close or even touch a wall: reported, since the circuit itself runs there.
  // Running close for long is a fault.
  const list = `${close.slice(0, 12).join(', ')}${close.length > 12 ? ` and ${close.length - 12} more` : ''}`;
  if (close.length > n * .01) throw new Error(`${track.id}: line too close to the edge at stations ${list}`);
  if (close.length) console.warn(`  close to the edge at ${list}${outside < 0 ? ' (the trace squeezes through a gap narrower than a car)' : ''}`);
  if (narrow.length) console.warn(`  the trace squeezes between barriers too close to keep clear of both near ${narrow.join('; ')}: the line follows the trace there`);
  if (throughWalls.length) console.warn(`  the trace passes through a wall in the leg from ${throughWalls.join('; ')}: the line follows the trace there`);
  return { step: STEP / mpu, points } satisfies BakedLine;
}

/** Overhead check image: asphalt grey, grass green, gravel tan, walls white, drivable tinted blue, trace cyan, line red. */
function writeMap(path: string, W: number, H: number, cls: Uint8Array, drivable: Uint8Array, trace: Uint8Array, line: number[][]) {
  const colors = [[105, 105, 110], [55, 110, 45], [185, 165, 115], [15, 15, 18], [240, 240, 240]];
  const rgb = new Uint8Array(W * H * 3);
  for (let k = 0; k < W * H; k++) {
    const c = trace[k] ? [80, 220, 255] : colors[cls[k]];
    rgb.set(drivable[k] && !trace[k] ? [c[0] * .7, c[1] * .8, Math.min(255, c[2] * 1.3 + 30)] : c, k * 3);
  }
  for (let i = 0; i < line.length; i++) {
    const [ax, az] = line[i], [bx, bz] = line[(i + 1) % line.length], steps = Math.ceil(Math.hypot(bx - ax, bz - az) * 2) + 1;
    for (let s = 0; s <= steps; s++) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const x = Math.floor(ax + (bx - ax) * s / steps) + dx, z = Math.floor(az + (bz - az) * s / steps) + dz;
      if (x >= 0 && z >= 0 && x < W && z < H) rgb.set([255, 40, 40], (z * W + x) * 3);
    }
  }
  // 24-bit BMP; rows run bottom-up, so +z is up and the picture is a mirror of the top-down view.
  const row = Math.ceil(W * 3 / 4) * 4, bmp = Buffer.alloc(54 + row * H);
  bmp.write('BM'); bmp.writeUInt32LE(bmp.length, 2); bmp.writeUInt32LE(54, 10); bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(W, 18); bmp.writeInt32LE(H, 22);
  bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28); bmp.writeUInt32LE(row * H, 34);
  for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) { const k = (z * W + x) * 3, o = 54 + z * row + x * 3; bmp[o] = rgb[k + 2]; bmp[o + 1] = rgb[k + 1]; bmp[o + 2] = rgb[k]; }
  mkdirSync(mapDir!, { recursive: true }); writeFileSync(path, bmp);
}

const lines: Record<string, BakedLine> = {};
const output = 'shared/racing-lines.ts';
if (only && existsSync(output)) {
  // Keep the other circuits' existing lines.
  const { RACING_LINES } = await import('../shared/racing-lines');
  Object.assign(lines, RACING_LINES);
}
for (const track of TRACKS) if (!only || only.includes(track.id)) lines[track.id] = await bake(track);
await writeFile(output, `// Generated by design/build-racing-lines.ts from the shipped drive traces and collision meshes. Do not edit.\n` +
  `import type { BakedLine } from './racing-line';\n\nexport const RACING_LINES: Record<string, BakedLine> = {\n` +
  TRACKS.filter(track => lines[track.id]).map(({ id }) => `  ${JSON.stringify(id)}: { step: ${+lines[id].step.toFixed(5)}, points: [${lines[id].points.join(',')}] },`).join('\n') + '\n};\n');
console.log(`Wrote ${output}`);
