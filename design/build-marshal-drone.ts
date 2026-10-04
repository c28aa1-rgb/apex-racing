// Builds the runtime marshal (start-light) drone from the supplied Meshy model.
// The source is a single 287k-triangle shell with no normals, UVs or materials,
// and its propellers are fused into their guard rings. This script:
//   1. splits the shell into parts (body shell, alloy frame, lamp pods, guard
//      rings, the ten lamp lenses) by measured position,
//   2. removes the fused propeller blades (the game adds spinning ones),
//   3. simplifies each part separately with its borders locked,
//   4. projects UVs per face and paints textures for each material,
//   5. writes public/models/drone/marshal-drone.glb with named lamp materials
//      (lamp-0..4, left to right seen from the front) and rotor anchor nodes.
// Run: node --import tsx design/build-marshal-drone.ts [source.glb]
import { mkdirSync, statSync } from 'node:fs';
import { Document, NodeIO, PropertyType, type Material } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRMaterialsClearcoat } from '@gltf-transform/extensions';
import { dedup, meshopt, textureCompress } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { createCanvas, GlobalFonts, type SKRSContext2D } from '@napi-rs/canvas';

const SOURCE = process.argv[2] ?? 'design/models/marshal-drone-source.glb';
const TARGET = 'public/models/drone/marshal-drone.glb';
GlobalFonts.registerFromPath('public/fonts/BigShoulders-Bold.ttf', 'Shoulders');

// ---- Measured layout of the source model (model units, ~1.9 wide) ----
const LAMP_X = { front: [-0.477, -0.242, -0.002, 0.241, 0.478], back: [-0.483, -0.248, -0.002, 0.243, 0.483] };
const LENS = { y: -0.305, front: 0.072, back: 0.08 };
const ROTORS = [
  { x: -0.552, z: -0.397, r: 0.235 }, { x: 0.549, z: -0.397, r: 0.235 },
  { x: -0.644, z: 0.346, r: 0.305 }, { x: 0.640, z: 0.347, r: 0.305 },
];
const BLADE_Y = 0.205, ROTOR_PLANE = 0.232;
type Part = 'shell' | 'frame' | 'pod' | 'bezel' | 'ring' | 'dark' | `lamp-${number}` | 'removed';

await MeshoptSimplifier.ready; await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
const source = await io.read(SOURCE);
const sourcePrimitive = source.getRoot().listMeshes()[0].listPrimitives()[0];
const positions = sourcePrimitive.getAttribute('POSITION')!.getArray() as Float32Array;
const indices = sourcePrimitive.getIndices()!.getArray() as Uint32Array;
const triangleCount = indices.length / 3;

function faceOf(t: number) {
  const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
  const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
  const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, length = Math.hypot(nx, ny, nz) || 1;
  return { x: (positions[a] + positions[b] + positions[c]) / 3, y: (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3, z: (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3, nx: nx / length, ny: ny / length, nz: nz / length };
}
// Each lens is the flat face recessed inside its housing. Flood-fill it from the
// centre across neighbouring faces that stay in the same plane, so the glass
// keeps its true round outline instead of a cut made by a radius test.
const lensOf = new Int8Array(triangleCount).fill(-1);
/** Measured centre and radius of each filled lens, keyed `front-0` .. `back-4`, for its LED texture. */
const lensFit = new Map<string, { x: number; y: number; r: number; z: number }>();
{
  const candidates: number[] = [], faces = new Map<number, ReturnType<typeof faceOf>>();
  for (let t = 0; t < triangleCount; t++) { const f = faceOf(t); if (Math.abs(f.z) > 0.22 && Math.abs(f.nz) > 0.4 && f.y < -0.1 && f.y > -0.42) { candidates.push(t); faces.set(t, f); } }
  const edges = new Map<string, number[]>();
  for (const t of candidates) for (let k = 0; k < 3; k++) {
    const a = indices[t * 3 + k], b = indices[t * 3 + (k + 1) % 3], key = a < b ? `${a}_${b}` : `${b}_${a}`;
    const list = edges.get(key) ?? []; list.push(t); edges.set(key, list);
  }
  for (const [side, sign] of [['front', 1], ['back', -1]] as const) LAMP_X[side].forEach((cx, lamp) => {
    const seeds = candidates.filter(t => { const f = faces.get(t)!; return f.z * sign > 0 && f.nz * sign > 0.8 && Math.hypot(f.x - cx, f.y - LENS.y) < 0.03; });
    if (!seeds.length) { console.warn(`no lens seed for ${side} ${lamp}`); return; }
    const n = [0, 0, 0], p = [0, 0, 0];
    for (const t of seeds) { const f = faces.get(t)!; n[0] += f.nx; n[1] += f.ny; n[2] += f.nz; p[0] += f.x; p[1] += f.y; p[2] += f.z; }
    const nl = Math.hypot(n[0], n[1], n[2]); n[0] /= nl; n[1] /= nl; n[2] /= nl; p[0] /= seeds.length; p[1] /= seeds.length; p[2] /= seeds.length;
    const queue = [...seeds]; seeds.forEach(t => lensOf[t] = lamp);
    while (queue.length) {
      const t = queue.pop()!;
      for (let k = 0; k < 3; k++) {
        const a = indices[t * 3 + k], b = indices[t * 3 + (k + 1) % 3];
        for (const u of edges.get(a < b ? `${a}_${b}` : `${b}_${a}`) ?? []) {
          if (lensOf[u] >= 0) continue;
          const f = faces.get(u)!;
          if (f.nx * n[0] + f.ny * n[1] + f.nz * n[2] < 0.94) continue;
          if (Math.abs((f.x - p[0]) * n[0] + (f.y - p[1]) * n[1] + (f.z - p[2]) * n[2]) > 0.008) continue;
          if (Math.hypot(f.x - cx, f.y - LENS.y) > 0.11) continue;
          lensOf[u] = lamp; queue.push(u);
        }
      }
    }
    // Fit the LED grid to the glass actually found.
    let minX = 9, maxX = -9, minY = 9, maxY = -9, zSum = 0, zCount = 0;
    for (const t of candidates) if (lensOf[t] === lamp && faces.get(t)!.z * sign > 0) { zSum += faces.get(t)!.z; zCount++; for (let k = 0; k < 3; k++) { const v = indices[t * 3 + k]; minX = Math.min(minX, positions[v * 3]); maxX = Math.max(maxX, positions[v * 3]); minY = Math.min(minY, positions[v * 3 + 1]); maxY = Math.max(maxY, positions[v * 3 + 1]); } }
    lensFit.set(`${side}-${lamp}`, { x: (minX + maxX) / 2, y: (minY + maxY) / 2, r: Math.max(maxX - minX, maxY - minY) / 2, z: zSum / zCount });
  });
}
function classify(t: number): Part {
  const f = faceOf(t);
  if (lensOf[t] >= 0) return `lamp-${lensOf[t]}`;
  // The supplied propellers are fused into ragged guard rings: both go, and clean
  // rings are rebuilt below; the game spins its own blades inside them.
  for (const rotor of ROTORS) {
    const d = Math.hypot(f.x - rotor.x, f.z - rotor.z) / rotor.r;
    if (d < 0.8 && f.y > BLADE_Y) return 'removed';
    if (d >= 0.8 && d < 1.1 && f.y > 0.17) return 'removed';
  }
  // A bright alloy bezel around each lens frames the working face.
  if (Math.abs(f.z) > 0.25 && f.nz * Math.sign(f.z) > 0.25) {
    const fit = [0, 1, 2, 3, 4].map(i => lensFit.get(`${f.z > 0 ? 'front' : 'back'}-${i}`)).find(fit => fit && Math.hypot(f.x - fit.x, f.y - fit.y) < fit.r + 0.024);
    if (fit) return 'bezel';
  }
  if (f.y < -0.03 && Math.abs(f.x) < 0.63 && Math.abs(f.z) < 0.56) return 'pod';
  if (Math.abs(f.x) < 0.22 && Math.abs(f.z) < 0.55 && f.y > 0.1 && f.ny > 0.25) return 'shell';
  if (f.y > 0.29) return 'dark';
  return 'frame';
}

// Smooth vertex normals for the whole shell, before parts are split apart.
const normals = new Float32Array(positions.length);
for (let t = 0; t < triangleCount; t++) {
  const f = faceOf(t), a = indices[t * 3], b = indices[t * 3 + 1], c = indices[t * 3 + 2];
  // Area weighting: the unnormalised cross product.
  const ax = positions[b * 3] - positions[a * 3], ay = positions[b * 3 + 1] - positions[a * 3 + 1], az = positions[b * 3 + 2] - positions[a * 3 + 2];
  const bx = positions[c * 3] - positions[a * 3], by = positions[c * 3 + 1] - positions[a * 3 + 1], bz = positions[c * 3 + 2] - positions[a * 3 + 2];
  const area = Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
  for (const v of [a, b, c]) { normals[v * 3] += f.nx * area; normals[v * 3 + 1] += f.ny * area; normals[v * 3 + 2] += f.nz * area; }
}
for (let v = 0; v < normals.length; v += 3) { const l = Math.hypot(normals[v], normals[v + 1], normals[v + 2]) || 1; normals[v] /= l; normals[v + 1] /= l; normals[v + 2] /= l; }

const parts = new Map<Part, number[]>();
for (let t = 0; t < triangleCount; t++) {
  const part = classify(t); if (part === 'removed') continue;
  const list = parts.get(part) ?? []; list.push(indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]); parts.set(part, list);
}

// ---- UV projection ----
type Projection = (x: number, y: number, z: number, axis: 0 | 1 | 2, sign: number) => [number, number];
const BOX_SCALE = 4.5; // texture repeats per model unit on tiled materials (carbon cells about 6 cm on the full-size drone)
const box: Projection = (x, y, z, axis) => axis === 0 ? [z * BOX_SCALE, y * BOX_SCALE] : axis === 1 ? [x * BOX_SCALE, z * BOX_SCALE] : [x * BOX_SCALE, y * BOX_SCALE];
// Pod faces: a front atlas (top half) holds numbers under each lens; sides use the plain lower half.
const podUv: Projection = (x, y, z, axis, sign) => {
  if (axis === 2) { const u = sign > 0 ? (x + 0.63) / 1.26 : (0.63 - x) / 1.26; return [u, 0.5 + 0.5 * (y + 0.43) / 0.45]; }
  return axis === 0 ? [(z + 0.56) / 1.12, 0.48 * (y + 0.43) / 0.45] : [(x + 0.63) / 1.26, 0.48 * (z + 0.56) / 1.12];
};
const lensUv = (lamp: number): Projection => (x, y, z) => {
  const fit = lensFit.get(`${z > 0 ? 'front' : 'back'}-${lamp}`)!;
  return [0.5 + (z > 0 ? x - fit.x : fit.x - x) / (2 * fit.r), 0.5 - (y - fit.y) / (2 * fit.r)];
};

/** Simplify one part with borders locked, then split vertices where faces pick different projections. */
function buildPart(part: Part, list: number[], ratio: number, project: Projection) {
  const target = Math.max(3, Math.floor(list.length * ratio / 3) * 3);
  const [simplified] = MeshoptSimplifier.simplify(new Uint32Array(list), positions, 3, target, 0.0025, ['LockBorder']);
  const outPositions: number[] = [], outNormals: number[] = [], outUvs: number[] = [], outIndices: number[] = [];
  const remap = new Map<string, number>();
  for (let t = 0; t < simplified.length; t += 3) {
    const [a, b, c] = [simplified[t], simplified[t + 1], simplified[t + 2]];
    const ux = positions[b * 3] - positions[a * 3], uy = positions[b * 3 + 1] - positions[a * 3 + 1], uz = positions[b * 3 + 2] - positions[a * 3 + 2];
    const vx = positions[c * 3] - positions[a * 3], vy = positions[c * 3 + 1] - positions[a * 3 + 1], vz = positions[c * 3 + 2] - positions[a * 3 + 2];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const axis = (Math.abs(n[0]) >= Math.abs(n[1]) && Math.abs(n[0]) >= Math.abs(n[2]) ? 0 : Math.abs(n[1]) >= Math.abs(n[2]) ? 1 : 2) as 0 | 1 | 2;
    const sign = Math.sign(n[axis]) || 1;
    for (const v of [a, b, c]) {
      const key = `${v}|${axis}|${sign}`;
      let out = remap.get(key);
      if (out === undefined) {
        out = outPositions.length / 3; remap.set(key, out);
        outPositions.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
        outNormals.push(normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]);
        outUvs.push(...project(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2], axis, sign));
      }
      outIndices.push(out);
    }
  }
  console.log(`${part.padEnd(7)} ${String(list.length / 3).padStart(7)} -> ${String(outIndices.length / 3).padStart(6)} triangles`);
  return { positions: new Float32Array(outPositions), normals: new Float32Array(outNormals), uvs: new Float32Array(outUvs), indices: new Uint32Array(outIndices) };
}

// ---- Textures ----
// Look: black clear-coated carbon fibre, satin-black lamp housings with
// gunmetal bezels, deep hoods over each lamp, red LED accents (see the
// reference render the drone is modelled on).
type Rgb = [number, number, number];
function png(w: number, h: number, draw: (context: SKRSContext2D) => void) {
  const canvas = createCanvas(w, h); draw(canvas.getContext('2d')); return canvas.toBuffer('image/png');
}
function seeded(seed: number) { return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }; }
function noise(context: SKRSContext2D, w: number, h: number, base: Rgb, amount: number, seed: number, streak = 0) {
  const image = context.createImageData(w, h), random = seeded(seed);
  const rows = new Float32Array(h).map(() => (random() - .5) * streak);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const n = (random() - .5) * amount + rows[y], i = (y * w + x) * 4;
    image.data[i] = base[0] + n; image.data[i + 1] = base[1] + n; image.data[i + 2] = base[2] + n; image.data[i + 3] = 255;
  }
  context.putImageData(image, 0, 0);
}
/**
 * 2x2 twill carbon weave, tiling. Each tow is a raised strand running across or
 * down its cell, and the over-under pattern steps one cell per row (the diagonal
 * twill line). Returns base colour and a matching tangent-space normal map.
 */
function carbon(size: number, cells: number, dark: number, sheen: number) {
  const cell = size / cells, height = new Float32Array(size * size), colour = new Uint8ClampedArray(size * size * 4), random = seeded(91);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), across = ((cx + cy) & 3) < 2;
    const u = (across ? y : x) % cell / cell, along = (across ? x : y) % cell / cell;
    // Rounded strand profile with a hairline gap between strands, and a slight dip where it passes under.
    const profile = Math.sin(Math.PI * Math.min(1, Math.max(0, (u - .04) / .92)));
    const dip = .82 + .18 * Math.sin(Math.PI * along);
    const h = profile * dip, grain = (random() - .5) * .06;
    height[y * size + x] = h;
    const v = dark + (sheen - dark) * Math.pow(h, 2.2) * (across ? 1 : .72) + grain * 20;
    colour.set([v, v, v * 1.04, 255], (y * size + x) * 4);
  }
  const normal = new Uint8ClampedArray(size * size * 4), strength = 2.2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const at = (px: number, py: number) => height[((py + size) % size) * size + (px + size) % size];
    const dx = (at(x + 1, y) - at(x - 1, y)) * strength, dy = (at(x, y + 1) - at(x, y - 1)) * strength, l = Math.hypot(dx, dy, 1);
    normal.set([(-dx / l * .5 + .5) * 255, (dy / l * .5 + .5) * 255, (1 / l * .5 + .5) * 255, 255], (y * size + x) * 4);
  }
  const toPng = (data: Uint8ClampedArray) => png(size, size, c => { const image = c.createImageData(size, size); image.data.set(data); c.putImageData(image, 0, 0); });
  return { colour: toPng(colour), normal: toPng(normal) };
}
const weave = carbon(512, 24, 9, 42);
const textures = {
  carbon: weave.colour, carbonNormal: weave.normal,
  // Gunmetal for bezels and fittings: fine brushed grain.
  gunmetal: png(256, 256, c => noise(c, 256, 256, [86, 90, 96], 14, 11, 16)),
  rubber: png(128, 128, c => noise(c, 128, 128, [16, 17, 19], 8, 23)),
  // Lamp housings: satin black, white station numbers above a red tick under each front lens.
  pod: png(1024, 1024, c => {
    noise(c, 1024, 1024, [22, 23, 26], 10, 71);
    LAMP_X.front.forEach((x, i) => {
      const u = (x + 0.63) / 1.26 * 1024, v = (0.5 + 0.5 * (-0.395 + 0.43) / 0.45) * 1024;
      c.fillStyle = '#ff2a1a'; c.fillRect(u - 30, v - 3, 60, 6);
      c.fillStyle = '#e9e6e0'; c.font = '38px Shoulders'; c.textAlign = 'center'; c.textBaseline = 'alphabetic'; c.fillText(String(i + 1), u, v - 9);
    });
  }),
  // LED lens: concentric rings of diodes behind smoked glass. The same image is the emissive map, so only the diodes glow.
  lens: png(512, 512, c => {
    c.fillStyle = '#080404'; c.fillRect(0, 0, 512, 512);
    const back = c.createRadialGradient(256, 256, 0, 256, 256, 256); back.addColorStop(0, 'rgba(90,30,24,.6)'); back.addColorStop(1, 'rgba(0,0,0,0)'); c.fillStyle = back; c.fillRect(0, 0, 512, 512);
    const dotAt = (x: number, y: number, r: number) => { const g = c.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, '#ffffff'); g.addColorStop(.5, '#e6e6e6'); g.addColorStop(1, 'rgba(70,70,70,0)'); c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill(); };
    dotAt(256, 256, 9);
    for (let ring = 1; ring <= 12; ring++) {
      const radius = ring * 19.5, count = Math.round(2 * Math.PI * radius / 19.5), offset = ring % 2 ? .5 : 0;
      for (let k = 0; k < count; k++) { const a = (k + offset) / count * Math.PI * 2; dotAt(256 + Math.cos(a) * radius, 256 + Math.sin(a) * radius, 8.6); }
    }
  }),
  // Inside of each hood: red light falling off away from the lens (v = 0 at the lens).
  glow: png(64, 256, c => { const g = c.createLinearGradient(0, 0, 0, 256); g.addColorStop(0, '#ffffff'); g.addColorStop(.35, '#7a7a7a'); g.addColorStop(1, '#0c0c0c'); c.fillStyle = g; c.fillRect(0, 0, 64, 256); }),
};

// ---- Procedural parts ----
type Geometry = { positions: Float32Array; normals: Float32Array; uvs: Float32Array; indices: Uint32Array };
class Builder {
  p: number[] = []; n: number[] = []; uv: number[] = []; i: number[] = [];
  vertex(p: number[], n: number[], uv: number[]) { this.p.push(...p); this.n.push(...n); this.uv.push(...uv); return this.p.length / 3 - 1; }
  quad(a: number, b: number, c: number, d: number) { this.i.push(a, b, c, a, c, d); }
  /** A grid of vertices (rows × columns) from a callback, stitched into quads. */
  grid(rows: number, columns: number, at: (r: number, c: number) => [number[], number[], number[]]) {
    const base = this.p.length / 3;
    for (let r = 0; r <= rows; r++) for (let c = 0; c <= columns; c++) { const [p, n, uv] = at(r, c); this.vertex(p, n, uv); }
    for (let r = 0; r < rows; r++) for (let c = 0; c < columns; c++) { const a = base + r * (columns + 1) + c; this.quad(a, a + 1, a + columns + 2, a + columns + 1); }
  }
  build(): Geometry { return { positions: new Float32Array(this.p), normals: new Float32Array(this.n), uvs: new Float32Array(this.uv), indices: new Uint32Array(this.i) }; }
}
/** Revolves a closed cross-section [radial offset, height, normal r, normal y] around a vertical axis between two angles. */
function revolve(out: Builder, cx: number, cy: number, cz: number, radius: number, profile: [number, number, number, number][], segments: number, a0 = 0, a1 = Math.PI * 2) {
  out.grid(segments, profile.length - 1, (r, c) => {
    const a = a0 + (a1 - a0) * r / segments, [dr, dy, nr, ny] = profile[c];
    return [[cx + Math.cos(a) * (radius + dr), cy + dy, cz + Math.sin(a) * (radius + dr)], [Math.cos(a) * nr, ny, Math.sin(a) * nr], [a * radius * BOX_SCALE, c / (profile.length - 1)]];
  });
}
function roundedSection(halfW: number, halfH: number, round: number, steps = 4) {
  const profile: [number, number, number, number][] = [];
  for (const [cx, cy, start] of [[halfW - round, halfH - round, 0], [-halfW + round, halfH - round, Math.PI / 2], [-halfW + round, -halfH + round, Math.PI], [halfW - round, -halfH + round, Math.PI * 1.5]] as const)
    for (let s = 0; s <= steps; s++) { const a = start + s / steps * Math.PI / 2; profile.push([cx + Math.cos(a) * round, cy + Math.sin(a) * round, Math.cos(a), Math.sin(a)]); }
  profile.push(profile[0]); return profile;
}
const RING = { y: 0.222, halfW: 0.021, halfH: 0.019 };
const rings = new Builder(), leds = new Builder(), visors = new Builder();
const glows = [0, 1, 2, 3, 4].map(() => new Builder());
for (const rotor of ROTORS) {
  const radius = rotor.r * 0.92;
  // Wide, flat carbon guard ring.
  revolve(rings, rotor.x, RING.y, rotor.z, radius, roundedSection(RING.halfW, RING.halfH, .008), 120);
  // Red LED strip on the outer face, centred on the side facing away from the body.
  const outward = Math.atan2(rotor.z, rotor.x), strip: [number, number, number, number][] = [[0, -.006, 1, 0], [0, .006, 1, 0]];
  revolve(leds, rotor.x, RING.y, rotor.z, radius + RING.halfW + .0015, strip, 24, outward - .42, outward + .42);
  revolve(leds, rotor.x, RING.y + RING.halfH + .0015, rotor.z, radius + RING.halfW * .45, [[-.004, 0, 0, 1], [.004, 0, 0, 1]], 24, outward + Math.PI - .3, outward + Math.PI + .3);
  // Red ring round the motor, just below the rotor plane.
  const motor = rotor.r > .26 ? .084 : .068, tube: [number, number, number, number][] = [];
  for (let k = 0; k <= 8; k++) { const a = k / 8 * Math.PI * 2; tube.push([Math.cos(a) * .006, Math.sin(a) * .006, Math.cos(a), Math.sin(a)]); }
  revolve(leds, rotor.x, 0.188, rotor.z, motor, tube, 36);
}
// Light bar across the nose of the body.
{
  const [x0, x1, y0, y1, z] = [-0.055, 0.055, 0.128, 0.142, 0.414];
  const a = leds.vertex([x0, y0, z], [0, 0, 1], [0, 0]), b = leds.vertex([x1, y0, z], [0, 0, 1], [1, 0]), c = leds.vertex([x1, y1, z], [0, 0, 1], [1, 1]), d = leds.vertex([x0, y1, z], [0, 0, 1], [0, 1]);
  leds.quad(a, b, c, d);
}
// Hoods: a deep, flared visor over the top and sides of every lens, front and back.
for (const [side, sign] of [['front', 1], ['back', -1]] as const) for (let lamp = 0; lamp < 5; lamp++) {
  const fit = lensFit.get(`${side}-${lamp}`); if (!fit) continue;
  const rows = 6, columns = 40, a0 = -0.38, a1 = Math.PI + 0.38, inner = fit.r + 0.01, thick = 0.007, flare = 0.014;
  const depth = (a: number) => 0.03 + 0.085 * Math.max(0, Math.sin(a));
  const at = (a: number, j: number, offset: number): number[] => {
    const r = inner + flare * j / rows + offset;
    return [fit.x + Math.cos(a) * r, fit.y + Math.sin(a) * r, fit.z + sign * (0.006 + depth(a) * j / rows)];
  };
  const angle = (c: number) => a0 + (a1 - a0) * c / columns;
  // Inside face: lit red by the lamp (its own material per lamp).
  glows[lamp].grid(rows, columns, (r, c) => [at(angle(c), r, 0), [-Math.cos(angle(c)), -Math.sin(angle(c)), 0], [c / columns, r / rows]]);
  // Outside face and the rolled lip at the open end.
  visors.grid(rows, columns, (r, c) => [at(angle(c), r, thick), [Math.cos(angle(c)), Math.sin(angle(c)), 0], [angle(c) * inner * BOX_SCALE, r / rows]]);
  visors.grid(1, columns, (r, c) => [at(angle(c), rows, r ? thick : 0), [0, 0, sign], [angle(c) * inner * BOX_SCALE, r]]);
}

// ---- Assemble the runtime GLB ----
const doc = new Document(); doc.createBuffer();
const clearcoat = doc.createExtension(KHRMaterialsClearcoat);
const texture = (name: string, image: Buffer) => doc.createTexture(name).setImage(new Uint8Array(image)).setMimeType('image/png');
const carbonMap = texture('carbon', textures.carbon), carbonNormal = texture('carbon-normal', textures.carbonNormal);
const gunmetalMap = texture('gunmetal', textures.gunmetal), rubberMap = texture('rubber', textures.rubber), podMap = texture('pod', textures.pod);
const lensMap = texture('lens', textures.lens), glowMap = texture('glow', textures.glow);
/** Lacquered carbon: woven base and normal map under a glossy clear coat. */
const carbonMaterial = (name: string, roughness: number) => doc.createMaterial(name).setBaseColorTexture(carbonMap).setNormalTexture(carbonNormal).setNormalScale(.45)
  .setMetallicFactor(.05).setRoughnessFactor(roughness).setExtension('KHR_materials_clearcoat', clearcoat.createClearcoat().setClearcoatFactor(1).setClearcoatRoughnessFactor(.07));
const materials: Record<string, Material> = {
  shell: carbonMaterial('shell', .32),
  frame: carbonMaterial('frame', .38),
  ring: carbonMaterial('ring', .34),
  visor: carbonMaterial('visor', .3).setDoubleSided(true),
  pod: doc.createMaterial('pod').setBaseColorTexture(podMap).setMetallicFactor(.3).setRoughnessFactor(.48),
  bezel: doc.createMaterial('bezel').setBaseColorTexture(gunmetalMap).setMetallicFactor(.9).setRoughnessFactor(.26),
  dark: doc.createMaterial('dark').setBaseColorTexture(rubberMap).setMetallicFactor(.1).setRoughnessFactor(.7),
  // Always-on accent lights; the game turns them green at the start.
  led: doc.createMaterial('led').setBaseColorFactor([.08, .01, .01, 1]).setEmissiveFactor([1, .06, .03]).setMetallicFactor(0).setRoughnessFactor(.4),
};
for (let i = 0; i < 5; i++) {
  materials[`lamp-${i}`] = doc.createMaterial(`lamp-${i}`).setBaseColorTexture(lensMap).setBaseColorFactor([.6, .12, .1, 1])
    .setEmissiveTexture(lensMap).setEmissiveFactor([1, .07, .03]).setMetallicFactor(.1).setRoughnessFactor(.16);
  materials[`lampglow-${i}`] = doc.createMaterial(`lampglow-${i}`).setBaseColorFactor([.03, .03, .03, 1]).setEmissiveTexture(glowMap).setEmissiveFactor([1, .08, .04])
    .setMetallicFactor(0).setRoughnessFactor(.6).setDoubleSided(true);
}
const mesh = doc.createMesh('marshal-drone');
const accessor = (type: 'VEC3' | 'VEC2' | 'SCALAR', array: Float32Array | Uint32Array) => doc.createAccessor().setType(type).setArray(array);
let total = 0;
function add(material: string, built: Geometry) {
  total += built.indices.length / 3;
  mesh.addPrimitive(doc.createPrimitive().setMaterial(materials[material])
    .setAttribute('POSITION', accessor('VEC3', built.positions)).setAttribute('NORMAL', accessor('VEC3', built.normals))
    .setAttribute('TEXCOORD_0', accessor('VEC2', built.uvs)).setIndices(accessor('SCALAR', built.indices)));
}
const plan: [Part, number, Projection][] = [
  ['shell', .5, box], ['frame', .36, box], ['pod', .36, podUv], ['bezel', .5, box], ['dark', .5, box],
  ...[0, 1, 2, 3, 4].map(i => [`lamp-${i}` as Part, .7, lensUv(i)] as [Part, number, Projection]),
];
for (const [part, ratio, project] of plan) {
  const list = parts.get(part); if (!list) { console.warn(`missing part ${part}`); continue; }
  add(part, buildPart(part, list, ratio, project));
}
add('ring', rings.build()); add('led', leds.build()); add('visor', visors.build());
glows.forEach((glow, i) => add(`lampglow-${i}`, glow.build()));
const scene = doc.createScene('marshal-drone');
const body = doc.createNode('drone-body').setMesh(mesh); scene.addChild(body);
ROTORS.forEach((rotor, i) => scene.addChild(doc.createNode(`rotor-${i}`).setTranslation([rotor.x, ROTOR_PLANE, rotor.z]).setExtras({ radius: rotor.r * .8 })));
// Centre of the lamp row, so the game can hang the drone by its lights.
scene.addChild(doc.createNode('lamp-centre').setTranslation([0, LENS.y, 0]));
// WebP textures and meshopt-compressed geometry; the game's loader decodes both.
// Materials are not deduplicated: the lamp materials are identical except for their names, which the game relies on.
await doc.transform(dedup({ propertyTypes: [PropertyType.ACCESSOR, PropertyType.TEXTURE] }), textureCompress({ encoder: sharp, targetFormat: 'webp', quality: 90 }), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
mkdirSync('public/models/drone', { recursive: true });
await io.write(TARGET, doc);
console.log(`total ${total} triangles, ${(statSync(TARGET).size / 1048576).toFixed(2)} MB -> ${TARGET}`);
