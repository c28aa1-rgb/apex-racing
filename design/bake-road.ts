/**
 * Road-surface bake. Makes the rendered road the smooth physical road.
 *
 * Imported venues ship coarse, tiled, quantized road meshes: seams step by centimetres, kerbs have vertical
 * risers, painted lines float above the asphalt and Daytona's banks meet the apron in a hard crease. The game
 * used to hide that with an invisible smoothed driving skin plus render-time body/wheel fitting, so what the
 * player saw was never what the car touched. This pass edits the venue model instead:
 *
 *  1. collect the drivable primitives (surface, kerbs, overlays) in world space, dequantized;
 *  2. sample the top drivable layer and define a smooth target height field F(x,z) by robust moving least
 *     squares (local quadratic: crests, sags, banking and crowns survive; steps, seams and facet noise do not);
 *  3. refine triangles until the piecewise-linear mesh follows F within a chord tolerance (no new T-junctions:
 *     the split decision for an edge depends only on its two endpoints);
 *  4. delete drivable triangles hidden under another drivable layer (stacked copies, under-kerb asphalt);
 *  5. snap surface vertices to F, kerbs to F + a capped, ramped relief, overlays to F + a small lift;
 *  6. carry the same displacement onto nearby non-drivable geometry (grass edges, wall bases, props) with a
 *     smooth falloff so nothing cracks open;
 *  7. write float32 positions and fresh normals back in each node's local space.
 *
 * Collision is regenerated from the result (design/build-model-collisions.ts), so visible == physical.
 */
import { type Document, type Node, type Primitive } from '@gltf-transform/core';
import { Matrix4, Vector3 } from 'three';
import type { Track } from '../shared/tracks';
import type { BakeConfig } from './track-bake';

type Role = 'surface' | 'kerb' | 'overlay';
type Mesh = {
  primitive: Primitive; node: Node; material: number; role: Role | 'other';
  matrix: Matrix4; inverse: Matrix4;
  semantics: string[]; sizes: number[];
  attributes: number[][];  // per semantic, flat float values (denormalized); POSITION is world space
  indices: number[];
  raw?: number[];          // original world y per vertex (role meshes)
  snapped?: Set<number>;   // vertices moved onto the road (role meshes)
};
export type BakeReport = {
  id: string; materials: Record<string, { role: string; trianglesBefore: number; trianglesAfter: number; maxMoveCm: number; p99MoveCm: number }>;
  samples: number; unsupportedVertices: number; clampHits: number; hiddenDeleted: number; steepDeleted: number; degenerateDeleted: number;
  featherVertices: number; featherMaxCm: number; refineRounds: number; residualRmsCm: number; residualP99Cm: number; residualMaxCm: number; seconds: number;
  clampAt: { x: number; y: number; z: number; material: number; wantedCm: number }[];
  residualAt: { x: number; y: number; z: number; material: number; cm: number; edgeM: number }[];
  /** Share of each overlay material's triangles with no drivable surface within 5 cm below: such an overlay fills a gap and must stay solid. */
  overlayWithoutFloor: Record<string, number>;
  /** Flat prop pieces lying just above the road (thin strips, misplaced paint, cable covers): count, flattened, worst. */
  lowProps: { found: number; flattened: number; at: { x: number; y: number; z: number; material: number; heightCm: number }[] };
};

const KEY_SCALE = 1000; // 1 mm position keys (world units are ~metres on every venue)
const keyOf = (x: number, y: number, z: number) => `${Math.round(x * KEY_SCALE)},${Math.round(y * KEY_SCALE)},${Math.round(z * KEY_SCALE)}`;

/** Uniform 2D hash grid over x/z. */
class Grid<T> {
  cells = new Map<number, T[]>();
  constructor(public cell: number) {}
  private key(ix: number, iz: number) { return ix * 1000003 + iz; }
  add(x: number, z: number, item: T) { const k = this.key(Math.floor(x / this.cell), Math.floor(z / this.cell)); let list = this.cells.get(k); if (!list) this.cells.set(k, list = []); list.push(item); }
  addBox(minX: number, minZ: number, maxX: number, maxZ: number, item: T) {
    for (let ix = Math.floor(minX / this.cell); ix <= Math.floor(maxX / this.cell); ix++) for (let iz = Math.floor(minZ / this.cell); iz <= Math.floor(maxZ / this.cell); iz++) {
      const k = this.key(ix, iz); let list = this.cells.get(k); if (!list) this.cells.set(k, list = []); list.push(item);
    }
  }
  near(x: number, z: number, radius: number, visit: (item: T) => void) {
    const x0 = Math.floor((x - radius) / this.cell), x1 = Math.floor((x + radius) / this.cell), z0 = Math.floor((z - radius) / this.cell), z1 = Math.floor((z + radius) / this.cell);
    for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++) { const list = this.cells.get(this.key(ix, iz)); if (list) for (const item of list) visit(item); }
  }
}

/** Solves the symmetric positive system A x = b (n x n, row-major) in place; returns false if singular. */
function solve(A: Float64Array, b: Float64Array, n: number) {
  for (let i = 0; i < n; i++) {
    let pivot = i; for (let r = i + 1; r < n; r++) if (Math.abs(A[r * n + i]) > Math.abs(A[pivot * n + i])) pivot = r;
    if (Math.abs(A[pivot * n + i]) < 1e-12) return false;
    if (pivot !== i) { for (let c = 0; c < n; c++) { const t = A[i * n + c]; A[i * n + c] = A[pivot * n + c]; A[pivot * n + c] = t; } const t = b[i]; b[i] = b[pivot]; b[pivot] = t; }
    for (let r = i + 1; r < n; r++) { const f = A[r * n + i] / A[i * n + i]; if (!f) continue; for (let c = i; c < n; c++) A[r * n + c] -= f * A[i * n + c]; b[r] -= f * b[i]; }
  }
  for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let c = i + 1; c < n; c++) s -= A[i * n + c] * b[c]; b[i] = s / A[i * n + i]; }
  return true;
}

type Sample = { x: number; y: number; z: number; nx: number; ny: number; nz: number };

/** Smooth target field F(x,z) of the top drivable layer, by robust weighted moving least squares. */
class Field {
  grid: Grid<Sample>; radius: number; cache = new Map<string, number>();
  constructor(public samples: Sample[], public sigma: number, public huber: number, public reject: number, public layer: number) {
    this.radius = sigma * 2.5; this.grid = new Grid<Sample>(this.radius);
    for (const s of samples) this.grid.add(s.x, s.z, s);
  }
  /** Height of the smooth surface at (x,z) for the layer that passes near height y, or NaN without support. */
  at(x: number, y: number, z: number): number {
    const key = keyOf(x, y, z), cached = this.cache.get(key); if (cached !== undefined) return cached;
    const value = this.fit(x, y, z); this.cache.set(key, value); return value;
  }
  private fit(x: number, y: number, z: number): number {
    const r = this.radius, r2 = r * r, sigma = this.sigma;
    // Anchor: the nearest sample at about this height defines the local plane used to keep one layer.
    let anchor: Sample | undefined, best = Infinity;
    this.grid.near(x, z, r, s => { const dy = Math.abs(s.y - y); if (dy > this.layer * 2) return; const d = (s.x - x) ** 2 + (s.z - z) ** 2 + dy * dy * 400; if (d < best) { best = d; anchor = s; } });
    if (!anchor) return NaN;
    const a = anchor, list: Sample[] = [];
    this.grid.near(x, z, r, s => {
      const dx = s.x - x, dz = s.z - z, h2 = dx * dx + dz * dz; if (h2 > r2) return;
      // Distance from the anchor's tangent plane, allowing curvature (banking creases) to grow with distance.
      const planeY = a.y - (a.nx * (s.x - a.x) + a.nz * (s.z - a.z)) / Math.max(.3, a.ny);
      if (Math.abs(s.y - planeY) < this.layer + .7 * Math.sqrt(h2)) list.push(s);
    });
    if (list.length < 6) return NaN;
    const n = list.length, base = new Float64Array(n), robust = new Float64Array(n).fill(1);
    let support = 0;
    for (let i = 0; i < n; i++) { const s = list[i], h2 = (s.x - x) ** 2 + (s.z - z) ** 2; base[i] = Math.exp(-h2 / (2 * sigma * sigma)); support += base[i]; }
    // Expected weight of a full disc of samples; a vertex at the edge of the asphalt sees about half of it.
    if (support < .08 * this.expected()) return NaN;
    let value = NaN;
    const A = new Float64Array(36), b = new Float64Array(6), row = new Float64Array(6);
    for (let iteration = 0; iteration < 4; iteration++) {
      A.fill(0); b.fill(0); let total = 0;
      for (let i = 0; i < n; i++) {
        const w = base[i] * robust[i]; if (!w) continue; total += w;
        const s = list[i], u = (s.x - x) / sigma, v = (s.z - z) / sigma;
        row[0] = 1; row[1] = u; row[2] = v; row[3] = u * u; row[4] = u * v; row[5] = v * v;
        for (let p = 0; p < 6; p++) { b[p] += w * row[p] * s.y; for (let q = p; q < 6; q++) A[p * 6 + q] += w * row[p] * row[q]; }
      }
      for (let p = 0; p < 6; p++) for (let q = 0; q < p; q++) A[p * 6 + q] = A[q * 6 + p];
      // Ridge on the curvature terms: a one-sided or sparse neighbourhood falls back towards a plane.
      for (let p = 3; p < 6; p++) A[p * 6 + p] += .02 * total;
      for (let p = 1; p < 3; p++) A[p * 6 + p] += 1e-6 * total;
      const coefficients = b.slice();
      if (!solve(A.slice(), coefficients, 6)) return value;
      value = coefficients[0];
      if (iteration === 3) break;
      for (let i = 0; i < n; i++) {
        const s = list[i], u = (s.x - x) / sigma, v = (s.z - z) / sigma;
        const fit = coefficients[0] + coefficients[1] * u + coefficients[2] * v + coefficients[3] * u * u + coefficients[4] * u * v + coefficients[5] * v * v;
        const residual = Math.abs(s.y - fit);
        robust[i] = residual > this.reject ? 0 : residual > this.huber ? this.huber / residual : 1;
      }
    }
    return value;
  }
  private full = 0;
  private expected() {
    if (this.full) return this.full;
    // Sum of Gaussian weights of a 2D grid of samples at the configured spacing over the fitting disc.
    const spacing = this.spacing, sigma = this.sigma; let sum = 0;
    for (let u = -this.radius; u <= this.radius; u += spacing) for (let v = -this.radius; v <= this.radius; v += spacing) if (u * u + v * v <= this.radius ** 2) sum += Math.exp(-(u * u + v * v) / (2 * sigma * sigma));
    return this.full = sum;
  }
  spacing = .5;
}

function readMeshes(doc: Document, roleOf: (material: number) => Role | undefined) {
  const root = doc.getRoot(), materials = root.listMaterials(), meshes: Mesh[] = [];
  root.getDefaultScene()!.traverse(node => {
    const mesh = node.getMesh(); if (!mesh) return;
    const matrix = new Matrix4().fromArray(node.getWorldMatrix()), inverse = matrix.clone().invert();
    for (const primitive of mesh.listPrimitives()) {
      if (primitive.getMode() !== 4) continue;
      const material = materials.indexOf(primitive.getMaterial()!);
      const semantics = primitive.listSemantics(), sizes: number[] = [], attributes: number[][] = [];
      const position = primitive.getAttribute('POSITION'); if (!position) continue;
      const count = position.getCount(), element: number[] = [], v = new Vector3();
      for (const semantic of semantics) {
        const accessor = primitive.getAttribute(semantic)!, size = accessor.getElementSize(), values: number[] = new Array(count * size);
        for (let i = 0; i < count; i++) {
          accessor.getElement(i, element);
          if (semantic === 'POSITION') { v.fromArray(element).applyMatrix4(matrix); values[i * 3] = v.x; values[i * 3 + 1] = v.y; values[i * 3 + 2] = v.z; }
          else for (let c = 0; c < size; c++) values[i * size + c] = element[c];
        }
        sizes.push(size); attributes.push(values);
      }
      const source = primitive.getIndices(), indices: number[] = [];
      const total = source?.getCount() ?? count;
      for (let i = 0; i < total; i++) indices.push(source ? source.getScalar(i) : i);
      meshes.push({ primitive, node, material, role: roleOf(material) ?? 'other', matrix, inverse, semantics, sizes, attributes, indices });
    }
  });
  return meshes;
}

const position = (mesh: Mesh) => mesh.attributes[mesh.semantics.indexOf('POSITION')];

/** Appends the midpoint of vertices a and b (all attributes interpolated) and returns its index. */
function midpoint(mesh: Mesh, a: number, b: number) {
  const index = position(mesh).length / 3;
  mesh.semantics.forEach((_, s) => { const size = mesh.sizes[s], values = mesh.attributes[s]; for (let c = 0; c < size; c++) values.push((values[a * size + c] + values[b * size + c]) / 2); });
  if (mesh.raw) mesh.raw.push((mesh.raw[a] + mesh.raw[b]) / 2);
  return index;
}

function triangleNormal(p: number[], a: number, b: number, c: number) {
  const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
  const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, length = Math.hypot(nx, ny, nz);
  return { nx, ny, nz, length };
}

/** Height of triangle (a,b,c) at (x,z) when the point lies inside its x/z footprint. */
function heightIn(p: number[], a: number, b: number, c: number, x: number, z: number) {
  const ax = p[a * 3], az = p[a * 3 + 2], bx = p[b * 3], bz = p[b * 3 + 2], cx = p[c * 3], cz = p[c * 3 + 2];
  const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz); if (Math.abs(d) < 1e-12) return NaN;
  const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d, l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d, l3 = 1 - l1 - l2;
  if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) return NaN;
  return l1 * p[a * 3 + 1] + l2 * p[b * 3 + 1] + l3 * p[c * 3 + 1];
}

export function bakeRoad(doc: Document, track: Track, config: BakeConfig): BakeReport {
  const started = performance.now(), mpu = track.metersPerUnit, m = (meters: number) => meters / mpu;
  const materials = doc.getRoot().listMaterials();
  for (const [index, name] of Object.entries(config.names ?? {})) {
    const actual = materials[Number(index)]?.getName();
    if (actual !== name) throw new Error(`${track.id}: bake material ${index} is "${actual}", expected "${name}"`);
  }
  // Only blended (see-through) decals become render-only overlays; an opaque line or patch is drawn as road, so it stays
  // solid road surface (where it lies on the asphalt, the coplanar layer underneath is removed).
  const overlays = config.overlays.filter(index => materials[index]?.getAlphaMode() === 'BLEND');
  const roleOf = (material: number): Role | undefined => config.surface.includes(material) || config.overlays.includes(material) && !overlays.includes(material) ? 'surface' : config.kerbs.includes(material) ? 'kerb' : overlays.includes(material) ? 'overlay' : undefined;
  const meshes = readMeshes(doc, roleOf);
  const roleMeshes = meshes.filter(mesh => mesh.role !== 'other');
  const excluded = (x: number, z: number) => (config.exclude ?? []).some(zone => (x - zone.x) ** 2 + (z - zone.z) ** 2 < m(zone.radiusM) ** 2);
  const report: BakeReport = { id: track.id, materials: {}, samples: 0, unsupportedVertices: 0, clampHits: 0, hiddenDeleted: 0, steepDeleted: 0, degenerateDeleted: 0, featherVertices: 0, featherMaxCm: 0, refineRounds: 0, residualRmsCm: 0, residualP99Cm: 0, residualMaxCm: 0, seconds: 0, clampAt: [], residualAt: [], overlayWithoutFloor: {}, lowProps: { found: 0, flattened: 0, at: [] } };
  for (const mesh of roleMeshes) {
    mesh.raw = []; const p = position(mesh); for (let i = 1; i < p.length; i += 3) mesh.raw.push(p[i]);
    const name = `${mesh.material}:${materials[mesh.material].getName()}`;
    report.materials[name] ??= { role: mesh.role, trianglesBefore: 0, trianglesAfter: 0, maxMoveCm: 0, p99MoveCm: 0 };
    report.materials[name].trianglesBefore += mesh.indices.length / 3;
  }

  // Triangle index over every drivable layer (surface + kerb), used to find what lies on top of what.
  type Tri = { mesh: Mesh; t: number };
  const buildTriangleGrid = () => {
    const grid = new Grid<Tri>(m(4));
    for (const mesh of roleMeshes) if (mesh.role !== 'overlay') {
      const p = position(mesh);
      for (let t = 0; t < mesh.indices.length; t += 3) {
        const [a, b, c] = [mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]];
        if (Math.abs(triangleNormal(p, a, b, c).ny) < .2 * triangleNormal(p, a, b, c).length) continue;
        grid.addBox(Math.min(p[a * 3], p[b * 3], p[c * 3]), Math.min(p[a * 3 + 2], p[b * 3 + 2], p[c * 3 + 2]), Math.max(p[a * 3], p[b * 3], p[c * 3]), Math.max(p[a * 3 + 2], p[b * 3 + 2], p[c * 3 + 2]), { mesh, t });
      }
    }
    return grid;
  };
  const hiddenBelow = m(config.hiddenBelowCm / 100), coplanar = m(.003);
  const priority = (mesh: Mesh) => mesh.role === 'kerb' ? 2 : 1;
  /** True when another drivable triangle covers (x,z) within [-coplanar, hiddenBelow] above height y and wins the tie. */
  const covered = (grid: Grid<Tri>, x: number, y: number, z: number, self?: Tri) => {
    let hit = false;
    grid.near(x, z, 0, other => {
      if (hit || (self && other.mesh === self.mesh && other.t === self.t)) return;
      const p = position(other.mesh), i = other.mesh.indices, h = heightIn(p, i[other.t], i[other.t + 1], i[other.t + 2], x, z);
      if (Number.isNaN(h)) return;
      const above = h - y;
      if (above > coplanar && above <= hiddenBelow) hit = true;
      else if (Math.abs(above) <= coplanar && self) {
        const a = priority(other.mesh), b = priority(self.mesh);
        if (a > b || (a === b && (other.mesh.material < self.mesh.material || (other.mesh === self.mesh && other.t < self.t)))) hit = true;
      }
    });
    return hit;
  };

  // 1. Samples of the top surface layer (kerbs excluded: they are relief on top of the surface).
  let triangles = buildTriangleGrid();
  const spacing = Math.min(m(.5), m(config.sigmaM) / 3), samples: Sample[] = [];
  for (const mesh of roleMeshes) if (mesh.role === 'surface') {
    const p = position(mesh);
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const [a, b, c] = [mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]], normal = triangleNormal(p, a, b, c);
      if (normal.length < 1e-10 || Math.abs(normal.ny) < .55 * normal.length) continue;
      const sign = normal.ny < 0 ? -1 : 1, nx = sign * normal.nx / normal.length, ny = sign * normal.ny / normal.length, nz = sign * normal.nz / normal.length;
      const lab = Math.hypot(p[b * 3] - p[a * 3], p[b * 3 + 2] - p[a * 3 + 2]), lac = Math.hypot(p[c * 3] - p[a * 3], p[c * 3 + 2] - p[a * 3 + 2]);
      const steps = Math.max(1, Math.ceil(Math.max(lab, lac) / spacing));
      for (let i = 0; i <= steps; i++) for (let j = 0; j <= steps - i; j++) {
        const u = i / steps, v = j / steps, w = 1 - u - v;
        const x = w * p[a * 3] + u * p[b * 3] + v * p[c * 3], y = w * p[a * 3 + 1] + u * p[b * 3 + 1] + v * p[c * 3 + 1], z = w * p[a * 3 + 2] + u * p[b * 3 + 2] + v * p[c * 3 + 2];
        if (excluded(x, z) || covered(triangles, x, y, z, { mesh, t })) continue;
        samples.push({ x, y, z, nx, ny, nz });
      }
    }
  }
  // Shared triangle edges create duplicate samples; thin them to one per spacing cell and layer.
  const seen = new Set<string>(), unique: Sample[] = [];
  for (const s of samples) { const k = `${Math.round(s.x / spacing)},${Math.round(s.z / spacing)},${Math.round(s.y / m(.3))}`; if (!seen.has(k)) { seen.add(k); unique.push(s); } }
  report.samples = unique.length;
  const field = new Field(unique, m(config.sigmaM), m(config.huberCm / 100), m(config.rejectCm / 100), m(.5));
  field.spacing = spacing;
  const F = (x: number, y: number, z: number) => excluded(x, z) ? NaN : field.at(x, y, z);

  // 2. Refinement: split an edge while it is longer than maxEdge, or while its chord misses F by more than the
  //    tolerance. The decision depends only on the two endpoint positions, so neighbours always agree.
  const maxEdge = m(config.maxEdgeM), minEdge = m(config.minEdgeM), chord = m(config.chordCm / 100), clamp = m(config.clampCm / 100);
  const inDefect = (x: number, z: number) => (config.defects ?? []).some(d => (x - d.x) ** 2 + (z - d.z) ** 2 < m(d.radiusM) ** 2);
  /** A vertex lies on the road when the field supports it and it sits within the clamp distance of the field
   *  (road materials are also used for wall stripes, raised footpaths and kerb sides, which must not move). */
  const onRoad = (x: number, y: number, z: number, f: number) => Number.isFinite(f) && (Math.abs(y - f) <= clamp || inDefect(x, z));
  const decisions = new Map<string, boolean>();
  const shouldSplit = (p: number[], a: number, b: number, raw?: number[]) => {
    const ka = keyOf(p[a * 3], p[a * 3 + 1], p[a * 3 + 2]), kb = keyOf(p[b * 3], p[b * 3 + 1], p[b * 3 + 2]), key = ka < kb ? ka + '|' + kb : kb + '|' + ka;
    const known = decisions.get(key); if (known !== undefined) return known;
    const horizontal = Math.hypot(p[b * 3] - p[a * 3], p[b * 3 + 2] - p[a * 3 + 2]);
    let split = false;
    if (horizontal > minEdge) {
      // Only edges lying on the road are refined; everything else keeps its source triangles.
      const ya = raw ? raw[a] : p[a * 3 + 1], yb = raw ? raw[b] : p[b * 3 + 1];
      const fa = F(p[a * 3], ya, p[a * 3 + 2]), fb = F(p[b * 3], yb, p[b * 3 + 2]);
      if (onRoad(p[a * 3], ya, p[a * 3 + 2], fa) && onRoad(p[b * 3], yb, p[b * 3 + 2], fb)) {
        if (horizontal > maxEdge) split = true;
        else {
          const fm = F((p[a * 3] + p[b * 3]) / 2, (ya + yb) / 2, (p[a * 3 + 2] + p[b * 3 + 2]) / 2);
          split = Number.isFinite(fm) && Math.abs(fm - (fa + fb) / 2) > chord;
        }
      }
    }
    decisions.set(key, split); return split;
  };
  for (let round = 0; round < 14; round++) {
    let changed = false;
    for (const mesh of roleMeshes) {
      const p = position(mesh), next: number[] = [], mids = new Map<string, number>();
      const mid = (a: number, b: number) => { const k = a < b ? `${a}|${b}` : `${b}|${a}`; let v = mids.get(k); if (v === undefined) mids.set(k, v = midpoint(mesh, a, b)); return v; };
      for (let t = 0; t < mesh.indices.length; t += 3) {
        const v = [mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]];
        const s = [shouldSplit(p, v[0], v[1], mesh.raw), shouldSplit(p, v[1], v[2], mesh.raw), shouldSplit(p, v[2], v[0], mesh.raw)];
        const count = s.filter(Boolean).length;
        if (!count) { next.push(...v); continue; }
        changed = true;
        if (count === 3) {
          const ab = mid(v[0], v[1]), bc = mid(v[1], v[2]), ca = mid(v[2], v[0]);
          next.push(v[0], ab, ca, ab, v[1], bc, ca, bc, v[2], ab, bc, ca);
        } else if (count === 1) {
          const e = s.indexOf(true), a = v[e], b = v[(e + 1) % 3], c = v[(e + 2) % 3], ab = mid(a, b);
          next.push(a, ab, c, ab, b, c);
        } else {
          // Two split edges: the unsplit edge is (c,a) where c follows the second split edge.
          const e = s.indexOf(false), a = v[(e + 1) % 3], b = v[(e + 2) % 3], c = v[e];
          // Edges (a,b) and (b,c) are split; edge (c,a) is not.
          const ab = mid(a, b), bc = mid(b, c);
          next.push(ab, b, bc);
          // Quad a-ab-bc-c: cut along the shorter diagonal.
          const d1 = Math.hypot(p[a * 3] - p[bc * 3], p[a * 3 + 2] - p[bc * 3 + 2]), d2 = Math.hypot(p[ab * 3] - p[c * 3], p[ab * 3 + 2] - p[c * 3 + 2]);
          if (d1 <= d2) next.push(a, ab, bc, a, bc, c); else next.push(a, ab, c, ab, bc, c);
        }
      }
      mesh.indices = next;
    }
    report.refineRounds = round + 1;
    if (!changed) break;
  }

  // 3. Hidden drivable layers: a triangle whose centre and (shrunken) corners are all covered goes.
  triangles = buildTriangleGrid();
  for (const mesh of roleMeshes) if (mesh.role !== 'overlay') {
    const p = position(mesh), keep: number[] = [];
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const [a, b, c] = [mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]];
      const cx = (p[a * 3] + p[b * 3] + p[c * 3]) / 3, cy = (p[a * 3 + 1] + p[b * 3 + 1] + p[c * 3 + 1]) / 3, cz = (p[a * 3 + 2] + p[b * 3 + 2] + p[c * 3 + 2]) / 3;
      const points = [[cx, cy, cz], ...[a, b, c].map(v => [cx + (p[v * 3] - cx) * .8, cy + (p[v * 3 + 1] - cy) * .8, cz + (p[v * 3 + 2] - cz) * .8])];
      if (points.every(([x, y, z]) => covered(triangles, x, y, z, { mesh, t }))) { report.hiddenDeleted++; continue; }
      keep.push(a, b, c);
    }
    mesh.indices = keep;
  }

  // 4. Snap. Surface: y = F. Kerb: y = F + relief, relief capped and limited by distance to the surface edge
  //    (vertical risers become ramps). Overlay: y = F + lift. Unsupported vertices keep their height.
  const surfaceEdge = new Grid<Sample>(m(1)); for (const s of unique) surfaceEdge.add(s.x, s.z, s);
  const edgeDistance = (x: number, y: number, z: number) => {
    let best = m(3); surfaceEdge.near(x, z, m(3), s => { if (Math.abs(s.y - y) < m(.6)) best = Math.min(best, Math.hypot(s.x - x, s.z - z)); }); return best;
  };
  const cap = m(config.kerbCapCm / 100), ramp = Math.tan(config.kerbRampDeg * Math.PI / 180), lift = m(config.overlayLiftCm / 100);
  type Moved = { x: number; y: number; z: number; d: number };
  const touchedProps = new Set<Mesh>();
  const moved: Moved[] = [];
  for (const mesh of roleMeshes) {
    const p = position(mesh), used = new Set<number>(), top = new Set<number>(), moves: number[] = [];
    mesh.snapped = new Set<number>();
    // Only vertices of up-facing triangles are snapped: pure skirt vertices (vertical faces dropping below the
    // road) keep their height, so a skirt stays hidden under the surface instead of being dragged up into it.
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const [a, b, c] = [mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]], n = triangleNormal(p, a, b, c);
      // Kerb side faces are kerb too: their tops come down to the capped relief (their buried bottoms stay put).
      const up = n.length > 0 && Math.abs(n.ny) >= .6 * n.length;
      if (up) { top.add(a); top.add(b); top.add(c); }
      if (mesh.role === 'kerb' || up) { used.add(a); used.add(b); used.add(c); }
    }
    const debug = process.env.BAKE_DEBUG?.split(',').map(Number);
    for (const i of used) {
      const x = p[i * 3], z = p[i * 3 + 2], raw = mesh.raw![i], f = F(x, raw, z);
      if (debug && Math.hypot(x - debug[0], z - debug[1]) < 1.2 && raw - f > .07) console.log('bake debug', mesh.role, mesh.material, x.toFixed(2), raw.toFixed(3), z.toFixed(2), 'F', f.toFixed(3), 'edge', edgeDistance(x, raw, z).toFixed(2));
      if (!Number.isFinite(f)) { report.unsupportedVertices++; continue; }
      let target = f;
      if (mesh.role === 'kerb') {
        // Signed: raised kerb relief is capped; mixed kerb/grass atlases keep their lower grass halves. Either
        // way the offset may only grow with distance from the drivable surface edge, so risers become ramps.
        const limit = Math.max(0, edgeDistance(x, raw, z) - spacing / 2) * ramp, relief = raw - f;
        // Below the road: only a visible kerb top is raised (mixed kerb/grass atlases); a buried skirt stays buried.
        if (relief < 0 && !top.has(i)) continue;
        target = f + (relief >= 0 ? Math.min(cap, relief, limit) : Math.max(relief, -limit));
      } else if (mesh.role === 'overlay') target = f + lift;
      const d = target - raw;
      // Not road (wall stripe, footpath, kerb side): leave it exactly as modelled. Kerbs are the exception up to
      // 60 cm: a kerb is never meant to be a wall, so stray tall kerb pieces are brought down to the capped relief.
      const kerbOnRoad = mesh.role === 'kerb' && Number.isFinite(f) && raw - f >= -clamp && raw - f <= m(.6);
      if (!kerbOnRoad && !onRoad(x, raw, z, f)) { report.clampHits++; if (report.clampAt.length < 40) report.clampAt.push({ x, y: raw, z, material: mesh.material, wantedCm: d * mpu * 100 }); continue; }
      p[i * 3 + 1] = raw + d; moves.push(Math.abs(d) * mpu * 100); mesh.snapped.add(i);
      if (mesh.role !== 'overlay') moved.push({ x, y: raw, z, d });
    }
    const name = `${mesh.material}:${materials[mesh.material].getName()}`, entry = report.materials[name];
    moves.sort((a, b) => a - b);
    entry.maxMoveCm = Math.max(entry.maxMoveCm, moves.at(-1) ?? 0);
    entry.p99MoveCm = Math.max(entry.p99MoveCm, moves[Math.floor(moves.length * .99)] ?? 0);
  }

  // 5. Clean-up: degenerate triangles and steep drivable slivers (all drivable vertices now lie on F, so a
  //    steep drivable triangle can only be a collapsed riser or seam skirt).
  for (const mesh of roleMeshes) {
    const p = position(mesh), keep: number[] = [];
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const [a, b, c] = [mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]], n = triangleNormal(p, a, b, c);
      if (n.length < m(.001) ** 2 * 2 || a === b || b === c || a === c) { report.degenerateDeleted++; continue; }
      // A steep triangle whose corners were all snapped onto the road has collapsed (old seam riser or skirt).
      if (mesh.role !== 'overlay' && Math.abs(n.ny) < .6 * n.length && [a, b, c].every(v => mesh.snapped!.has(v))
        && Math.max(p[a * 3 + 1], p[b * 3 + 1], p[c * 3 + 1]) - Math.min(p[a * 3 + 1], p[b * 3 + 1], p[c * 3 + 1]) < m(.03)) { report.steepDeleted++; continue; }
      keep.push(a, b, c);
    }
    mesh.indices = keep;
    report.materials[`${mesh.material}:${materials[mesh.material].getName()}`].trianglesAfter += keep.length / 3;
  }

  // 5b. Low props: up-facing pieces of other materials lying a few centimetres above the road (thin strips,
  //     paint modelled as geometry, cable covers). They are invisible walls to a tyre ray. Report them, and when
  //     configured, lay them flat on the road surface (their sides collapse; their texture stays).
  const propLimit = m((config.flattenPropsCm ?? 0) / 100), flattened = new Set<string>();
  const lowAt: BakeReport['lowProps']['at'] = [];
  /** Road on at least three sides within 1 m: the piece lies on the road, not beside it (tyre walls, barriers). */
  const onRoadSurface = (x: number, y: number, z: number) => {
    const quadrants = new Set<number>();
    surfaceEdge.near(x, z, m(1), s => { if (Math.abs(s.y - y) < m(.6) && Math.hypot(s.x - x, s.z - z) < m(1)) quadrants.add((s.x > x ? 1 : 0) + (s.z > z ? 2 : 0)); });
    return quadrants.size >= 3;
  };
  for (const mesh of meshes) if (mesh.role === 'other') {
    const material = mesh.primitive.getMaterial();
    // Render-only materials (blended decals, foliage, flagged helpers) are not obstacles.
    if (material?.getExtras().apexNonSolid === true || material?.getBaseColorFactor()[3]! < .05 || (material?.getAlphaMode() === 'BLEND' && !/fence|glass|rail|barrier/i.test(material.getName()))) continue;
    const p = position(mesh);
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const [a, b, c] = [mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]], n = triangleNormal(p, a, b, c);
      if (!n.length || Math.abs(n.ny) < .9 * n.length) continue;
      const x = (p[a * 3] + p[b * 3] + p[c * 3]) / 3, y = (p[a * 3 + 1] + p[b * 3 + 1] + p[c * 3 + 1]) / 3, z = (p[a * 3 + 2] + p[b * 3 + 2] + p[c * 3 + 2]) / 3;
      if (!onRoadSurface(x, y, z)) continue;
      const f = F(x, y, z), h = y - f;
      if (!Number.isFinite(f) || h <= m(.01) || h > m(.15)) continue;
      report.lowProps.found++;
      lowAt.push({ x, y, z, material: mesh.material, heightCm: h * mpu * 100 });
      if (h > propLimit) continue;
      for (const v of [a, b, c]) {
        const key = `${materials.indexOf(mesh.primitive.getMaterial()!)}:${meshes.indexOf(mesh)}:${v}`; if (flattened.has(key)) continue;
        const fv = F(p[v * 3], p[v * 3 + 1], p[v * 3 + 2]); if (!Number.isFinite(fv)) continue;
        p[v * 3 + 1] = fv + lift; flattened.add(key); touchedProps.add(mesh);
      }
      report.lowProps.flattened++;
    }
  }
  report.lowProps.at = lowAt.sort((q, r) => r.heightCm - q.heightCm).slice(0, 80);

  // 6. Feather: nearby non-drivable vertices follow the displacement with a smooth falloff.
  const feather = m(config.featherM), movedGrid = new Grid<Moved>(Math.max(feather, m(1)));
  for (const point of moved) movedGrid.add(point.x, point.z, point);
  const featherMeshes = meshes.filter(mesh => mesh.role === 'other' && !(config.noFeather ?? []).includes(mesh.material));
  const touched = new Set<Mesh>(touchedProps);
  for (const mesh of featherMeshes) {
    const p = position(mesh);
    const meshIndex = meshes.indexOf(mesh), materialIndex = materials.indexOf(mesh.primitive.getMaterial()!);
    for (let i = 0; i < p.length / 3; i++) {
      if (flattened.has(`${materialIndex}:${meshIndex}:${i}`)) continue;
      const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
      let nearest = Infinity; const near: [number, number][] = [];
      movedGrid.near(x, z, feather, point => {
        const dy = y - point.y; if (dy < -m(1) || dy > m(3)) return;
        const distance = Math.hypot(point.x - x, point.z - z); if (distance > feather) return;
        nearest = Math.min(nearest, distance); near.push([distance, point.d]);
      });
      if (!near.length) continue;
      let sum = 0, weight = 0;
      for (const [distance, d] of near) if (distance <= nearest + m(1)) { const w = 1 / (distance + m(.05)) ** 2; sum += w * d; weight += w; }
      const t = Math.min(1, nearest / feather), falloff = 1 - t * t * (3 - 2 * t), d = sum / weight * falloff;
      if (Math.abs(d) < m(.0005)) continue;
      p[i * 3 + 1] = y + d; touched.add(mesh); report.featherVertices++;
      report.featherMaxCm = Math.max(report.featherMaxCm, Math.abs(d) * mpu * 100);
    }
  }

  // Overlays become render-only, so each one must lie on a drivable layer; otherwise it plugs a hole.
  triangles = buildTriangleGrid();
  for (const mesh of roleMeshes) if (mesh.role === 'overlay') {
    const p = position(mesh); let missing = 0, total = 0;
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const [a, b, c] = [mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]];
      const x = (p[a * 3] + p[b * 3] + p[c * 3]) / 3, y = (p[a * 3 + 1] + p[b * 3 + 1] + p[c * 3 + 1]) / 3, z = (p[a * 3 + 2] + p[b * 3 + 2] + p[c * 3 + 2]) / 3;
      let below = false;
      triangles.near(x, z, 0, other => { if (below) return; const q = position(other.mesh), i = other.mesh.indices, h = heightIn(q, i[other.t], i[other.t + 1], i[other.t + 2], x, z); if (!Number.isNaN(h) && y - h > -m(.01) && y - h < m(.05)) below = true; });
      total++; if (!below) missing++;
    }
    const name = `${mesh.material}:${materials[mesh.material].getName()}`;
    report.overlayWithoutFloor[name] = (report.overlayWithoutFloor[name] ?? 0) + missing / Math.max(1, total);
  }

  // 7. Residual: baked surface against F at triangle centres.
  let squares = 0, count = 0; const residuals: number[] = [];
  for (const mesh of roleMeshes) if (mesh.role === 'surface') {
    const p = position(mesh);
    for (let t = 0; t < mesh.indices.length; t += 3 * 7) {
      const [a, b, c] = [mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]];
      if (![a, b, c].every(v => mesh.snapped!.has(v))) continue;
      const x = (p[a * 3] + p[b * 3] + p[c * 3]) / 3, y = (p[a * 3 + 1] + p[b * 3 + 1] + p[c * 3 + 1]) / 3, z = (p[a * 3 + 2] + p[b * 3 + 2] + p[c * 3 + 2]) / 3;
      const f = F(x, (mesh.raw![a] + mesh.raw![b] + mesh.raw![c]) / 3, z); if (!Number.isFinite(f) || inDefect(x, z)) continue;
      const r = (y - f) * mpu * 100; squares += r * r; count++; residuals.push(Math.abs(r)); report.residualMaxCm = Math.max(report.residualMaxCm, Math.abs(r));
      if (Math.abs(r) > 3) report.residualAt.push({ x, y, z, material: mesh.material, cm: r, edgeM: Math.max(Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 2] - p[b * 3 + 2]), Math.hypot(p[b * 3] - p[c * 3], p[b * 3 + 2] - p[c * 3 + 2]), Math.hypot(p[c * 3] - p[a * 3], p[c * 3 + 2] - p[a * 3 + 2])) * mpu });
    }
  }
  report.residualRmsCm = Math.sqrt(squares / Math.max(1, count));
  residuals.sort((a, b) => a - b); report.residualP99Cm = residuals[Math.floor(residuals.length * .99)] ?? 0;
  report.residualAt = report.residualAt.sort((a, b) => Math.abs(b.cm) - Math.abs(a.cm)).slice(0, 40);

  // 8. Write back: role meshes get rebuilt float attributes and smooth normals; feathered meshes get float positions.
  for (const mesh of roleMeshes) writeMesh(doc, mesh, true);
  for (const mesh of touched) writeMesh(doc, mesh, false);
  for (const index of overlays) materials[index].setExtras({ ...materials[index].getExtras(), apexRoadOverlay: true, apexNonSolid: true });
  report.seconds = (performance.now() - started) / 1000;
  return report;
}

function writeMesh(doc: Document, mesh: Mesh, rebuild: boolean) {
  const buffer = doc.getRoot().listBuffers()[0], p = position(mesh), count = p.length / 3, local = new Float32Array(count * 3), v = new Vector3();
  for (let i = 0; i < count; i++) { v.set(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]).applyMatrix4(mesh.inverse); local[i * 3] = v.x; local[i * 3 + 1] = v.y; local[i * 3 + 2] = v.z; }
  const primitive = mesh.primitive;
  primitive.setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(local).setBuffer(buffer));
  // Moving vertices can collapse a tiny sliver, and float32 storage under a large node scale can merge two
  // vertices a fraction of a millimetre apart: check faces on the stored positions, as the runtime validation does.
  const stored: number[] = new Array(count * 3);
  for (let i = 0; i < count; i++) { v.set(local[i * 3], local[i * 3 + 1], local[i * 3 + 2]).applyMatrix4(mesh.matrix); stored[i * 3] = v.x; stored[i * 3 + 1] = v.y; stored[i * 3 + 2] = v.z; }
  const kept: number[] = [];
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const [a, b, c] = [mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]];
    if (triangleNormal(stored, a, b, c).length >= 2e-8) kept.push(a, b, c);
  }
  mesh.indices = kept;
  if (!rebuild) { primitive.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(kept)).setBuffer(buffer)); return; }
  mesh.semantics.forEach((semantic, s) => {
    if (semantic === 'POSITION' || semantic === 'NORMAL') return;
    if (semantic === 'TANGENT') { primitive.setAttribute('TANGENT', null); return; }
    const size = mesh.sizes[s], type = size === 1 ? 'SCALAR' : size === 2 ? 'VEC2' : size === 3 ? 'VEC3' : 'VEC4';
    primitive.setAttribute(semantic, doc.createAccessor().setType(type).setArray(new Float32Array(mesh.attributes[s])).setBuffer(buffer));
  });
  // Smooth normals across coincident positions, faces oriented upward (drivable surfaces are seen from above).
  const sums = new Map<string, [number, number, number]>(), keys: string[] = [];
  for (let i = 0; i < count; i++) keys.push(keyOf(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]));
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const [a, b, c] = [mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]], n = triangleNormal(p, a, b, c), sign = n.ny < 0 ? -1 : 1;
    for (const vertex of [a, b, c]) { const sum = sums.get(keys[vertex]) ?? [0, 0, 0]; sum[0] += sign * n.nx; sum[1] += sign * n.ny; sum[2] += sign * n.nz; sums.set(keys[vertex], sum); }
  }
  const normals = new Float32Array(count * 3), normalMatrix = new Matrix4().copy(mesh.matrix).transpose(); // inverse(inverse)^T: world -> local uses matrix^T
  for (let i = 0; i < count; i++) {
    const sum = sums.get(keys[i]) ?? [0, 1, 0];
    v.set(sum[0], sum[1], sum[2]).transformDirection(normalMatrix);
    normals[i * 3] = v.x; normals[i * 3 + 1] = v.y; normals[i * 3 + 2] = v.z;
  }
  primitive.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(normals).setBuffer(buffer));
  primitive.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(mesh.indices)).setBuffer(buffer));
}
