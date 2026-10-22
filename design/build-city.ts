/**
 * Builds the free-roam city's runtime assets from the RacingCity export.
 *
 *   npm run build:city [-- --source=/path/to/RacingCity]
 *
 * Writes (all git-ignored; rebuild from the export):
 *   public/models/tracks/racing-city.runtime.glb  visible city, simplified for the browser
 *   public/models/tracks/collision/racing-city.bin APEXCOL3 collision mesh
 *   public/models/tracks/racing-city.map.json      road centerlines for the minimap
 *
 * The export keeps every tree at full source detail (one pine is ~360k triangles, placed 99 times) and stores
 * each instance batch as one draw spanning the whole map, so nothing can be culled. This build simplifies
 * dense instanced meshes, splits every instance batch into map cells, and caps texture sizes.
 */
import { NodeIO, type Node, type Primitive } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshGPUInstancing } from '@gltf-transform/extensions';
import { compactPrimitive, dedup, prune, simplifyPrimitive, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { Matrix4, Vector3 } from 'three';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chassisWalls, sealCracks } from './seal-cracks';

const source = process.argv.find(arg => arg.startsWith('--source='))?.slice(9) ?? join(homedir(), 'Downloads/RacingCity');
const out = 'public/models/tracks';
/** Instance batches are split into square cells of this size (metres) so each cell can be culled on its own. */
const CELL = 200;
/** Fraction of individual leaves kept on modelled foliage (see thinFoliage). */
const LEAVES: { match: RegExp; keep: number }[] = [{ match: /pine_tree/, keep: .025 }, { match: /tree_small/, keep: .06 }];
/**
 * Per-instance triangle budget and draw distance (metres) by node name; first match wins. Draw distances are read
 * by the renderer's distance culling (world.ts, userData.apexCull), so small things stop drawing long before the fog.
 */
const CLASSES: { match: RegExp; triangles: number; cull: number }[] = [
  { match: /pine_tree/, triangles: 1500, cull: 1100 },
  { match: /tree_small/, triangles: 1000, cull: 650 },
  { match: /shrub/, triangles: 600, cull: 260 },
  { match: /Markings|LanePaint|WheelStops/, triangles: 12, cull: 320 },
  { match: /Fence/, triangles: 200, cull: 380 },
  { match: /Sign|TrafficLight/, triangles: 500, cull: 450 },
  { match: /./, triangles: 500, cull: 320 },
];
const classOf = (name: string) => CLASSES.find(entry => entry.match.test(name))!;

/**
 * Modelled foliage is thousands of separate small leaves. Edge-collapse simplification deletes small parts first, so
 * it strips a tree bare. Instead keep an even sample of whole leaves (connected components) and grow each kept leaf
 * about its own centre so the canopy keeps roughly the same coverage.
 */
function thinFoliage(primitive: Primitive, keep: number) {
  const indices = primitive.getIndices()!, position = primitive.getAttribute('POSITION')!, count = position.getCount();
  const parent = Int32Array.from({ length: count }, (_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const ids = indices.getArray()!;
  for (let i = 0; i < ids.length; i += 3) { const a = find(ids[i]); parent[find(ids[i + 1])] = a; parent[find(ids[i + 2])] = a; }
  const stride = Math.round(1 / keep), grow = Math.sqrt(1 / keep) * .8, kept: number[] = [], chosen = new Map<number, boolean>();
  let order = 0;
  for (let i = 0; i < ids.length; i += 3) {
    const component = find(ids[i]);
    if (!chosen.has(component)) chosen.set(component, order++ % stride === 0);
    if (chosen.get(component)) kept.push(ids[i], ids[i + 1], ids[i + 2]);
  }
  const used = new Set(kept), sums = new Map<number, number[]>(), element: number[] = [];
  for (const id of used) { const c = find(id), sum = sums.get(c) ?? [0, 0, 0, 0]; position.getElement(id, element); sum[0] += element[0]; sum[1] += element[1]; sum[2] += element[2]; sum[3]++; sums.set(c, sum); }
  const positions = position.getArray()!.slice() as Float32Array;
  for (const id of used) {
    const [x, y, z, n] = sums.get(find(id))!, centre = [x / n, y / n, z / n];
    for (let axis = 0; axis < 3; axis++) positions[id * 3 + axis] = centre[axis] + (positions[id * 3 + axis] - centre[axis]) * grow;
  }
  position.setArray(positions);
  indices.setArray(new Uint32Array(kept));
  compactPrimitive(primitive);
}

await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

// ---------------------------------------------------------------- visible city
const doc = await io.read(join(source, 'RacingCity.glb'));
const root = doc.getRoot();
const triangles = (node: Node) => node.getMesh()?.listPrimitives().reduce((sum, p) => sum + (p.getIndices()?.getCount() ?? p.getAttribute('POSITION')!.getCount()) / 3, 0) ?? 0;
const hasBuildings = root.listNodes().some(node => /build|tower|skyscraper/i.test(node.getName()));
if (!hasBuildings) console.warn('warning: the export contains no building meshes; building collision blockers are left out so downtown has no invisible walls.');

await doc.transform(weld());
let before = 0, after = 0;
const simplified = new Set<unknown>();
for (const node of root.listNodes()) {
  const instancing = node.getExtension<any>('EXT_mesh_gpu_instancing');
  const mesh = node.getMesh(); if (!mesh || !instancing) continue;
  const count = instancing.getAttribute('TRANSLATION')?.getCount() ?? 1, tris = triangles(node);
  before += tris * count;
  const { triangles: budget, cull } = classOf(node.getName());
  node.setExtras({ ...node.getExtras(), apexCull: cull });
  if (tris > budget && !simplified.has(mesh)) {
    simplified.add(mesh);
    const ratio = budget / tris;
    // Foliage cards and props seen from a moving car tolerate a large geometric error; the ratio is the real limit.
    const leaves = LEAVES.find(entry => entry.match.test(node.getName()));
    for (const primitive of mesh.listPrimitives()) {
      if (leaves && /Foliage/.test(primitive.getMaterial()?.getName() ?? '')) thinFoliage(primitive, leaves.keep);
      else simplifyPrimitive(primitive, { simplifier: MeshoptSimplifier, ratio, error: .08, lockBorder: false });
    }
  }
  after += triangles(node) * count;
}
console.log(`instanced triangles: ${(before / 1e6).toFixed(1)}M -> ${(after / 1e6).toFixed(2)}M`);

// Split each instance batch into map cells.
const instancingExt = doc.createExtension(EXTMeshGPUInstancing);
const scene = root.getDefaultScene()!;
let cells = 0;
for (const node of [...root.listNodes()]) {
  const instancing = node.getExtension<any>('EXT_mesh_gpu_instancing'); if (!instancing) continue;
  const attributes: Record<string, any> = Object.fromEntries(instancing.listSemantics().map((semantic: string) => [semantic, instancing.getAttribute(semantic)]));
  const translation = attributes.TRANSLATION; if (!translation) continue;
  const parentMatrix = new Matrix4().fromArray(node.getWorldMatrix()), p = new Vector3(), element: number[] = [];
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < translation.getCount(); i++) {
    p.fromArray(translation.getElement(i, element)).applyMatrix4(parentMatrix);
    const key = `${Math.floor(p.x / CELL)}:${Math.floor(p.z / CELL)}`;
    (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(i);
  }
  if (buckets.size < 2) continue;
  const parent = node.getParentNode();
  for (const [key, ids] of buckets) {
    const cell = doc.createNode(`${node.getName()}@${key}`).setMesh(node.getMesh()).setMatrix(node.getMatrix()).setExtras(node.getExtras());
    const batch = instancingExt.createInstancedMesh();
    for (const [semantic, accessor] of Object.entries(attributes)) {
      const size = accessor.getElementSize(), values = new Float32Array(ids.length * size);
      const item = new Array(size);
      ids.forEach((id, i) => values.set(accessor.getElement(id, item), i * size));
      batch.setAttribute(semantic, doc.createAccessor().setType(accessor.getType()).setArray(values).setBuffer(root.listBuffers()[0]));
    }
    cell.setExtension('EXT_mesh_gpu_instancing', batch);
    if (parent) parent.addChild(cell); else scene.addChild(cell);
    cells++;
  }
  node.dispose();
}
console.log(`instance cells: ${cells}`);

// Small props and trees are seen briefly; tiled ground and road keep more detail.
await doc.transform(
  textureCompress({ encoder: sharp, resize: [1024, 1024], pattern: /^(T_|asphalt)/ }),
  textureCompress({ encoder: sharp, resize: [512, 512], pattern: /^(?!T_|asphalt)/ }),
  dedup(), prune(),
);
await writeFile(join(out, 'racing-city.runtime.glb'), await io.writeBinary(doc));

// ---------------------------------------------------------------- collision
const collision = await io.read(join(source, 'RacingCity-collision.glb'));
const vertices: number[] = [], indices: number[] = [], types: number[] = [];
const a = new Vector3(), b = new Vector3(), c = new Vector3();
collision.getRoot().getDefaultScene()!.traverse(node => {
  const mesh = node.getMesh(); if (!mesh) return;
  const name = node.getName();
  if (!hasBuildings && /BuildingCollision|RealCity_Collision/.test(name)) return;
  // 1 = grass grip off the road: the rolling landscape around the city.
  const type = /Landscape/.test(name) ? 1 : 0;
  const matrix = new Matrix4().fromArray(node.getWorldMatrix());
  for (const primitive of mesh.listPrimitives()) {
    const position = primitive.getAttribute('POSITION')!, local: number[] = [], element: number[] = [], v = new Vector3();
    for (let i = 0; i < position.getCount(); i++) { v.fromArray(position.getElement(i, element)).applyMatrix4(matrix); local.push(v.x, v.y, v.z); }
    const sourceIndices = primitive.getIndices(), ids: number[] = [];
    for (let i = 0; i + 2 < (sourceIndices?.getCount() ?? position.getCount()); i += 3) {
      const tri = [0, 1, 2].map(j => sourceIndices ? sourceIndices.getScalar(i + j) : i + j);
      a.fromArray(local, tri[0] * 3); b.fromArray(local, tri[1] * 3); c.fromArray(local, tri[2] * 3);
      b.sub(a); c.sub(a); const normal = b.cross(c), area = normal.length(); if (area < 1e-6) continue;
      // Wheel rays need upward-facing ground; vertical faces keep their winding.
      if (normal.y < -area * .2) [tri[1], tri[2]] = [tri[2], tri[1]];
      ids.push(...tri);
    }
    const offset = vertices.length / 3;
    for (const coordinate of local) vertices.push(coordinate);
    for (const id of ids) indices.push(id + offset);
    for (let i = 0; i < ids.length; i += 3) types.push(type);
  }
});
const flanges = sealCracks(vertices, indices, types, { reach: 1.25, drop: .02, tolerance: .1 });
const walls = chassisWalls(vertices, indices, .15);
const v = new Float32Array(vertices), i = new Uint32Array(indices), t = new Uint8Array(types);
const header = Buffer.alloc(16); header.write('APEXCOL3'); header.writeUInt32LE(v.length / 3, 8); header.writeUInt32LE(i.length, 12);
await mkdir(join(out, 'collision'), { recursive: true });
await writeFile(join(out, 'collision/racing-city.bin'), Buffer.concat([header, Buffer.from(v.buffer), Buffer.from(i.buffer), Buffer.from(t.buffer), Buffer.from(walls.buffer)]));
console.log(`collision: ${t.length} triangles (+${flanges} crack flanges), ${walls.reduce((sum, w) => sum + w, 0)} chassis walls`);

// ---------------------------------------------------------------- minimap roads
const mapData = JSON.parse(await readFile(join(source, 'map-data.json'), 'utf8'));
const roads = mapData.roads.map((road: { name: string; width: number; closed: boolean; points: number[][] }) => ({
  name: road.name, width: road.width, closed: road.closed,
  points: road.points.filter((_, index, all) => index % 4 === 0 || index === all.length - 1).map(([x, , z]) => [Math.round(x), Math.round(z)]),
}));
await writeFile(join(out, 'racing-city.map.json'), JSON.stringify({ spawn: mapData.spawnPoints[0], roads }));
console.log('wrote racing-city.runtime.glb, collision/racing-city.bin, racing-city.map.json');
