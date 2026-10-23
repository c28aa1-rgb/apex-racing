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
import { NodeIO, type Mesh, type Node, type Primitive } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshGPUInstancing } from '@gltf-transform/extensions';
import { compactPrimitive, dedup, joinPrimitives, prune, simplifyPrimitive, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { Matrix4, Quaternion, Vector3 } from 'three';
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
const CLASSES: { match: RegExp; triangles: number; cull: number; error?: number; cell?: number }[] = [
  // Buildings are the skyline: drawn to the fog, and simplified only within a tight error so facades keep their shape.
  // Each building is up to 17 material parts, one draw each per cell, so they use large cells.
  { match: /_(MM|PP)_(BrickTower|CornerShops|GlassCentre|Retail|ArcTower|CrownTower)/, triangles: 12000, cull: 4000, error: .015, cell: 300 },
  // The expressway deck is drivable road; piers, rails and gantries frame it from a distance.
  { match: /Highway_Deck/, triangles: 48, cull: 4000 },
  { match: /Highway_|Training_Garage|Training_Gantry|IndustrialDetail_Crane|Wayfinding/, triangles: 500, cull: 1200 },
  { match: /Industrial_Container|LampPoles|LampHeads/, triangles: 500, cull: 600 },
  { match: /pine_tree/, triangles: 1500, cull: 1100 },
  { match: /tree_small/, triangles: 1000, cull: 650 },
  { match: /shrub/, triangles: 600, cull: 260 },
  { match: /Markings|LanePaint|WheelStops/, triangles: 12, cull: 320 },
  { match: /Fence/, triangles: 200, cull: 380 },
  { match: /Sign|TrafficLight/, triangles: 500, cull: 450 },
  { match: /./, triangles: 500, cull: 320 },
];
const classOf = (name: string) => CLASSES.find(entry => entry.match.test(name))!;
const THREE_clamp = (value: number) => Math.min(1, Math.max(0, value));

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

// Taken out of the city: the start gantry and its sign over the test straight, right in front of the spawn.
const REMOVED = /^RC_Training_Gantry|^RC_TrainingStart$/;
for (const node of root.listNodes()) if (REMOVED.test(node.getName())) { node.traverse(child => child !== node && child.dispose()); node.dispose(); }
await doc.transform(weld());

// Buildings carry up to 17 materials each, one draw call apiece per map cell. Untextured opaque ones (trim, metal,
// black panels) become one shared material coloured per vertex, and the glass variants one shared glass, so the
// parts below can be joined.
const BUILDING = /_(MM|PP)_(BrickTower|CornerShops|GlassCentre|Retail|ArcTower|CrownTower)/;
{
  const solid = doc.createMaterial('RC_BuildingSolid').setBaseColorFactor([1, 1, 1, 1]).setMetallicFactor(.35).setRoughnessFactor(.55);
  let glass: ReturnType<typeof doc.createMaterial> | undefined, merged = 0;
  for (const node of root.listNodes()) {
    if (!BUILDING.test(node.getName())) continue;
    for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
      const material = primitive.getMaterial(); if (!material || material.getAlphaMode() !== 'OPAQUE' || material.getBaseColorTexture()) continue;
      if (/Glass/i.test(material.getName())) { glass ??= material; primitive.setMaterial(glass); merged++; continue; }
      const [r, g, b] = material.getBaseColorFactor(), count = primitive.getAttribute('POSITION')!.getCount(), colors = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) colors.set([r, g, b], i * 3);
      for (const semantic of primitive.listSemantics()) if (semantic !== 'POSITION' && semantic !== 'NORMAL') primitive.setAttribute(semantic, null);
      primitive.setAttribute('COLOR_0', doc.createAccessor().setType('VEC3').setArray(colors).setBuffer(root.listBuffers()[0]));
      primitive.setMaterial(solid); merged++;
    }
  }
  console.log(`building materials: ${merged} parts moved to shared solid/glass materials`);
}

// Street and road signs: ~90 text planes, each its own texture and draw call. They are packed into one atlas and
// merged into a single mesh (instanced signs expanded to plain copies).
{
  type Placement = { primitive: Primitive; matrix: Matrix4 };
  const placements: Placement[] = [], signNodes: Node[] = [];
  for (const node of root.listNodes()) {
    const primitive = node.getMesh()?.listPrimitives().find(p => /_Text$/.test(p.getMaterial()?.getName() ?? ''));
    if (!primitive) continue;
    signNodes.push(node);
    const world = new Matrix4().fromArray(node.getWorldMatrix()), instancing = node.getExtension<any>('EXT_mesh_gpu_instancing');
    if (!instancing) { placements.push({ primitive, matrix: world }); continue; }
    const T = instancing.getAttribute('TRANSLATION'), R = instancing.getAttribute('ROTATION'), S = instancing.getAttribute('SCALE');
    for (let i = 0; i < T.getCount(); i++) placements.push({ primitive, matrix: world.clone().multiply(new Matrix4().compose(
      new Vector3().fromArray(T.getElement(i, [0, 0, 0])), R ? new Quaternion().fromArray(R.getElement(i, [0, 0, 0, 1])) : new Quaternion(), S ? new Vector3().fromArray(S.getElement(i, [0, 0, 0])) : new Vector3(1, 1, 1))) });
  }
  // Shelf-pack each distinct sign texture, scaled to at most 96 px tall, into a 2048 px wide atlas.
  const ATLAS = 2048, slots = new Map<Primitive, { x: number; y: number; w: number; h: number; png: Buffer }>();
  let x = 0, y = 0, row = 0;
  for (const primitive of new Set(placements.map(p => p.primitive))) {
    const bytes = primitive.getMaterial()!.getBaseColorTexture()?.getImage(); if (!bytes) continue;
    const meta = await sharp(Buffer.from(bytes)).metadata(), scale = Math.min(1, 96 / meta.height!, ATLAS / meta.width!);
    const w = Math.max(1, Math.round(meta.width! * scale)), h = Math.max(1, Math.round(meta.height! * scale));
    if (x + w > ATLAS) { x = 0; y += row + 2; row = 0; }
    slots.set(primitive, { x, y, w, h, png: await sharp(Buffer.from(bytes)).resize(w, h).png().toBuffer() });
    x += w + 2; row = Math.max(row, h);
  }
  const height = 2 ** Math.ceil(Math.log2(y + row + 2));
  const atlas = await sharp({ create: { width: ATLAS, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([...slots.values()].map(slot => ({ input: slot.png, left: slot.x, top: slot.y }))).png().toBuffer();
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
  const v = new Vector3(), n = new Vector3(), normalMatrix = new Matrix4();
  for (const { primitive, matrix } of placements) {
    const slot = slots.get(primitive); if (!slot) continue;
    const P = primitive.getAttribute('POSITION')!, N = primitive.getAttribute('NORMAL'), UV = primitive.getAttribute('TEXCOORD_0')!, I = primitive.getIndices(), base = positions.length / 3;
    normalMatrix.copy(matrix).invert().transpose();
    for (let i = 0; i < P.getCount(); i++) {
      v.fromArray(P.getElement(i, [0, 0, 0])).applyMatrix4(matrix); positions.push(v.x, v.y, v.z);
      n.fromArray(N ? N.getElement(i, [0, 0, 0]) : [0, 1, 0]).applyMatrix4(normalMatrix).normalize(); normals.push(n.x, n.y, n.z);
      const [u, w] = UV.getElement(i, [0, 0]);
      uvs.push((slot.x + THREE_clamp(u) * slot.w) / ATLAS, (slot.y + THREE_clamp(w) * slot.h) / height);
    }
    for (let i = 0; i < (I?.getCount() ?? P.getCount()); i++) indices.push(base + (I ? I.getScalar(i) : i));
  }
  const buffer = root.listBuffers()[0], template = placements[0]?.primitive.getMaterial();
  if (template && positions.length) {
    const texture = doc.createTexture('RC_SignAtlas').setImage(new Uint8Array(atlas)).setMimeType('image/png');
    const material = template.clone().setName('RC_Signs_Text').setBaseColorTexture(texture);
    const primitive = doc.createPrimitive().setMaterial(material)
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(positions)).setBuffer(buffer))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(normals)).setBuffer(buffer))
      .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(uvs)).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(indices)).setBuffer(buffer));
    root.getDefaultScene()!.addChild(doc.createNode('RC_Signs').setMesh(doc.createMesh('RC_Signs').addPrimitive(primitive)));
    for (const node of signNodes) node.dispose();
    console.log(`signs: ${placements.length} planes from ${slots.size} textures packed into one ${ATLAS}x${height} atlas`);
  }
}
// Parts of one mesh that share a material and vertex layout draw as one.
for (const mesh of root.listMeshes()) {
  const sets = new Map<string, Primitive[]>();
  for (const primitive of mesh.listPrimitives()) {
    if (primitive.getMode() !== 4 || !primitive.getIndices()) continue;
    const key = `${root.listMaterials().indexOf(primitive.getMaterial()!)}|${primitive.listSemantics().sort().join()}`;
    (sets.get(key) ?? sets.set(key, []).get(key)!).push(primitive);
  }
  for (const parts of sets.values()) if (parts.length > 1) {
    mesh.addPrimitive(joinPrimitives(parts));
    for (const part of parts) { mesh.removePrimitive(part); part.dispose(); }
  }
}
let before = 0, after = 0;
const simplified = new Set<unknown>();
for (const node of root.listNodes()) {
  const instancing = node.getExtension<any>('EXT_mesh_gpu_instancing');
  const mesh = node.getMesh(); if (!mesh || !instancing) continue;
  const count = instancing.getAttribute('TRANSLATION')?.getCount() ?? 1, tris = triangles(node);
  before += tris * count;
  const { triangles: budget, cull, error = .08, cell = CELL } = classOf(node.getName());
  node.setExtras({ ...node.getExtras(), apexCull: cull, apexCell: cell });
  if (tris > budget && !simplified.has(mesh)) {
    simplified.add(mesh);
    const ratio = budget / tris;
    // Foliage cards and props seen from a moving car tolerate a large geometric error; the ratio is the real limit.
    const leaves = LEAVES.find(entry => entry.match.test(node.getName()));
    for (const primitive of mesh.listPrimitives()) {
      if (leaves && /Foliage/.test(primitive.getMaterial()?.getName() ?? '')) thinFoliage(primitive, leaves.keep);
      else simplifyPrimitive(primitive, { simplifier: MeshoptSimplifier, ratio, error, lockBorder: false });
    }
  }
  after += triangles(node) * count;
}
console.log(`instanced triangles: ${(before / 1e6).toFixed(1)}M -> ${(after / 1e6).toFixed(2)}M`);

// Re-batch instances by map cell. Batches that share a mesh and a draw distance are merged first (the export keeps one
// batch per district and actor, e.g. twelve lane-paint batches of the same box), so each cell costs one draw per mesh.
const instancingExt = doc.createExtension(EXTMeshGPUInstancing);
const scene = root.getDefaultScene()!;
type Placement = { t: number[]; r: number[]; s: number[] };
const groups = new Map<string, { name: string; mesh: Mesh; extras: Record<string, unknown>; placements: Placement[] }>();
const local = new Matrix4(), world = new Matrix4(), at = new Vector3(), turn = new Quaternion(), size = new Vector3();
for (const node of [...root.listNodes()]) {
  const instancing = node.getExtension<any>('EXT_mesh_gpu_instancing'), mesh = node.getMesh();
  if (!instancing || !mesh) continue;
  const semantics: string[] = instancing.listSemantics();
  if (semantics.some(semantic => !['TRANSLATION', 'ROTATION', 'SCALE'].includes(semantic))) continue;
  const [T, R, S] = ['TRANSLATION', 'ROTATION', 'SCALE'].map(semantic => instancing.getAttribute(semantic));
  const nodeMatrix = new Matrix4().fromArray(node.getWorldMatrix()), extras = node.getExtras();
  for (let i = 0; i < T.getCount(); i++) {
    at.fromArray(T.getElement(i, [0, 0, 0])); R ? turn.fromArray(R.getElement(i, [0, 0, 0, 1])) : turn.identity(); S ? size.fromArray(S.getElement(i, [0, 0, 0])) : size.set(1, 1, 1);
    world.multiplyMatrices(nodeMatrix, local.compose(at, turn, size)).decompose(at, turn, size);
    const cell = (extras.apexCell as number | undefined) ?? CELL, at2 = `${Math.floor(at.x / cell)}:${Math.floor(at.z / cell)}`;
    const key = `${root.listMeshes().indexOf(mesh)}|${extras.apexCull}|${cell}|${at2}`;
    const group = groups.get(key) ?? groups.set(key, { name: `${node.getName()}@${at2}`, mesh, extras, placements: [] }).get(key)!;
    group.placements.push({ t: at.toArray(), r: turn.toArray(), s: size.toArray() });
  }
  node.dispose();
}
const buffer = root.listBuffers()[0];
for (const { name, mesh, extras, placements } of groups.values()) {
  const batch = instancingExt.createInstancedMesh();
  for (const [semantic, type, width, field] of [['TRANSLATION', 'VEC3', 3, 't'], ['ROTATION', 'VEC4', 4, 'r'], ['SCALE', 'VEC3', 3, 's']] as const) {
    const values = new Float32Array(placements.length * width);
    placements.forEach((placement, i) => values.set(placement[field], i * width));
    batch.setAttribute(semantic, doc.createAccessor().setType(type).setArray(values).setBuffer(buffer));
  }
  scene.addChild(doc.createNode(name).setMesh(mesh).setExtras(extras).setExtension('EXT_mesh_gpu_instancing', batch));
}
const cells = groups.size;
console.log(`instance cells: ${cells}`);

// Small props and trees are seen briefly; tiled ground, road and building surfaces keep more detail, and the shared
// building atlas keeps its full export resolution (2K).
const DETAILED = /^(T_|asphalt|Clay|Concrete0|plastered_wall|roof|stone07|tile_mar|walpanel|wood-15)/;
await doc.transform(
  textureCompress({ encoder: sharp, resize: [1024, 1024], pattern: DETAILED }),
  textureCompress({ encoder: sharp, resize: [512, 512], pattern: new RegExp(`^(?!Atlas|RC_SignAtlas)(?!${DETAILED.source.slice(1)})`) }),
  dedup(), prune(),
);
await writeFile(join(out, 'racing-city.runtime.glb'), await io.writeBinary(doc));

// ---------------------------------------------------------------- collision
/** Ground outlines of the boxes in a collision primitive: each connected part's convex hull in x/z. */
function outlines(primitive: Primitive, matrix: Matrix4) {
  const position = primitive.getAttribute('POSITION')!, ids = primitive.getIndices()!.getArray()!, parent = Int32Array.from({ length: position.getCount() }, (_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  const byPosition = new Map<string, number>(), element: number[] = [], world: number[][] = [];
  for (let i = 0; i < position.getCount(); i++) {
    const p = new Vector3().fromArray(position.getElement(i, element)).applyMatrix4(matrix); world.push([p.x, p.z]);
    const key = `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`, other = byPosition.get(key);
    if (other !== undefined) parent[find(i)] = find(other); else byPosition.set(key, i);
  }
  for (let i = 0; i < ids.length; i += 3) { const root = find(ids[i]); parent[find(ids[i + 1])] = root; parent[find(ids[i + 2])] = root; }
  const parts = new Map<number, number[][]>();
  for (let i = 0; i < world.length; i++) (parts.get(find(i)) ?? parts.set(find(i), []).get(find(i))!).push(world[i]);
  return [...parts.values()].map(points => {
    // Monotone-chain convex hull.
    const sorted = [...new Map(points.map(p => [`${p[0].toFixed(1)},${p[1].toFixed(1)}`, p])).values()].sort((u, w) => u[0] - w[0] || u[1] - w[1]);
    const cross = (o: number[], u: number[], w: number[]) => (u[0] - o[0]) * (w[1] - o[1]) - (u[1] - o[1]) * (w[0] - o[0]);
    const half = (list: number[][]) => { const out: number[][] = []; for (const p of list) { while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop(); out.push(p); } out.pop(); return out; };
    return [...half(sorted), ...half([...sorted].reverse())].map(([x, z]) => [Math.round(x), Math.round(z)]);
  }).filter(hull => hull.length >= 3);
}
const collision = await io.read(join(source, 'RacingCity-collision.glb'));
const vertices: number[] = [], indices: number[] = [], types: number[] = [];
/** Building footprints for the city map: the ground outline of each collision box, as [x, z] corners. */
const footprints: number[][][] = [];
const a = new Vector3(), b = new Vector3(), c = new Vector3();
collision.getRoot().getDefaultScene()!.traverse(node => {
  const mesh = node.getMesh(); if (!mesh) return;
  const name = node.getName();
  if (!hasBuildings && /BuildingCollision|RealCity_Collision/.test(name)) return;
  if (REMOVED.test(name)) return;
  // 1 = grass grip off the road: the rolling landscape around the city.
  const type = /Landscape/.test(name) ? 1 : 0;
  const matrix = new Matrix4().fromArray(node.getWorldMatrix());
  if (/BuildingCollision|RealCity_Collision/.test(name)) for (const primitive of mesh.listPrimitives()) footprints.push(...outlines(primitive, matrix));
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
// The rolling landscape (grass) runs flush under the paved pads and roads in places. A wheel ray then hits grass and
// pavement at random, so a car on the big training pad was "off road" most of the time and held to ~50 mph. Landscape
// triangles lying under a paved floor (within 0.6 m of it) are counted as pavement.
{
  const CELL = 8, grid = new Map<string, number[]>(), paved: number[] = [];
  const corner = (t: number, k: number) => indices[t * 3 + k] * 3;
  for (let t = 0; t < types.length; t++) {
    if (types[t] !== 0) continue;
    const [a, b, c] = [0, 1, 2].map(k => corner(t, k));
    const ux = vertices[b] - vertices[a], uy = vertices[b + 1] - vertices[a + 1], uz = vertices[b + 2] - vertices[a + 2];
    const wx = vertices[c] - vertices[a], wy = vertices[c + 1] - vertices[a + 1], wz = vertices[c + 2] - vertices[a + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    if (ny < .85 * Math.hypot(nx, ny, nz)) continue;
    paved.push(t);
    const xs = [vertices[a], vertices[b], vertices[c]], zs = [vertices[a + 2], vertices[b + 2], vertices[c + 2]];
    for (let x = Math.floor(Math.min(...xs) / CELL); x <= Math.floor(Math.max(...xs) / CELL); x++)
      for (let z = Math.floor(Math.min(...zs) / CELL); z <= Math.floor(Math.max(...zs) / CELL); z++) (grid.get(`${x},${z}`) ?? grid.set(`${x},${z}`, []).get(`${x},${z}`)!).push(t);
  }
  // Height of a paved triangle at (x, z), if (x, z) lies over it.
  const heightOn = (t: number, x: number, z: number) => {
    const [a, b, c] = [0, 1, 2].map(k => corner(t, k));
    const x1 = vertices[a], z1 = vertices[a + 2], x2 = vertices[b], z2 = vertices[b + 2], x3 = vertices[c], z3 = vertices[c + 2];
    const d = (z2 - z3) * (x1 - x3) + (x3 - x2) * (z1 - z3); if (Math.abs(d) < 1e-9) return undefined;
    const l1 = ((z2 - z3) * (x - x3) + (x3 - x2) * (z - z3)) / d, l2 = ((z3 - z1) * (x - x3) + (x1 - x3) * (z - z3)) / d, l3 = 1 - l1 - l2;
    return l1 < -1e-3 || l2 < -1e-3 || l3 < -1e-3 ? undefined : l1 * vertices[a + 1] + l2 * vertices[b + 1] + l3 * vertices[c + 1];
  };
  let repaved = 0;
  for (let t = 0; t < types.length; t++) {
    if (types[t] !== 1) continue;
    const [a, b, c] = [0, 1, 2].map(k => corner(t, k));
    const samples = [[vertices[a], vertices[a + 1], vertices[a + 2]], [vertices[b], vertices[b + 1], vertices[b + 2]], [vertices[c], vertices[c + 1], vertices[c + 2]],
      [(vertices[a] + vertices[b] + vertices[c]) / 3, (vertices[a + 1] + vertices[b + 1] + vertices[c + 1]) / 3, (vertices[a + 2] + vertices[b + 2] + vertices[c + 2]) / 3]];
    const under = samples.some(([x, y, z]) => (grid.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`) ?? []).some(p => { const h = heightOn(p, x, z); return h !== undefined && Math.abs(h - y) < .6; }));
    if (under) { types[t] = 0; repaved++; }
  }
  console.log(`terrain: ${repaved} grass triangles under paving counted as pavement (${paved.length} paved floor triangles)`);
}
const flanges = sealCracks(vertices, indices, types, { reach: 1.25, drop: .02, tolerance: .1 });
const walls = chassisWalls(vertices, indices, .15);
const v = new Float32Array(vertices), i = new Uint32Array(indices), t = new Uint8Array(types);
const header = Buffer.alloc(16); header.write('APEXCOL3'); header.writeUInt32LE(v.length / 3, 8); header.writeUInt32LE(i.length, 12);
await mkdir(join(out, 'collision'), { recursive: true });
await writeFile(join(out, 'collision/racing-city.bin'), Buffer.concat([header, Buffer.from(v.buffer), Buffer.from(i.buffer), Buffer.from(t.buffer), Buffer.from(walls.buffer)]));
console.log(`collision: ${t.length} triangles (+${flanges} crack flanges), ${walls.reduce((sum, w) => sum + w, 0)} chassis walls`);

// ---------------------------------------------------------------- minimap roads
const mapData = JSON.parse(await readFile(join(source, 'map-data.json'), 'utf8'));
const roads = mapData.roads.map((road: { name: string; district: string; width: number; closed: boolean; points: number[][] }) => ({
  name: road.name, district: road.district, width: road.width, closed: road.closed,
  points: road.points.filter((_, index, all) => index % 4 === 0 || index === all.length - 1).map(([x, , z]) => [Math.round(x), Math.round(z)]),
}));
// Full-resolution centerlines with height, for traffic: cars follow the road's own elevation (the expressway).
const paths = mapData.roads.map((road: { name: string; district: string; width: number; closed: boolean; points: number[][] }) => ({
  name: road.name, district: road.district, width: road.width, closed: road.closed, points: road.points.map(point => point.map(value => Math.round(value * 100) / 100)),
}));
await writeFile(join(out, 'racing-city.map.json'), JSON.stringify({ spawn: mapData.spawnPoints[0], roads, buildings: footprints, paths }));
console.log(`map: ${roads.length} roads, ${footprints.length} building footprints`);
console.log('wrote racing-city.runtime.glb, collision/racing-city.bin, racing-city.map.json');
