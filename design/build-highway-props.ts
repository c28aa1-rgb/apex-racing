/**
 * Builds the Endless Highway's scenery (npm run build:highway-props) into public/models/highway/:
 *
 * - highway-props.glb: the plants and rocks scattered over the desert. The pines, the small broadleaf tree and the four
 *   shrubs come from the city's runtime model (already thinned and budgeted by build:city); the boulders, fallen log,
 *   quiver tree and rooibos bushes are Poly Haven scans, simplified here to a game budget. One node per kind, named
 *   for src/highway-scene.ts, each with its pivot at the middle of its footprint, on the ground.
 * - textures/: the road, desert, concrete and rock surfaces (colour, normal, roughness), downsized for the game.
 *
 * Sources: the Poly Haven downloads in ~/Downloads/highway-assets (see its manifest.txt; MD5-checked against Poly
 * Haven's file list when downloaded) and public/models/tracks/racing-city.runtime.glb. All CC0 (see CREDITS.txt).
 * Rocks and wood are edge-collapse simplified; foliage never is (see design/build-city.ts: it strips leaves bare).
 */
import { Document, NodeIO, type Node } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, getBounds, mergeDocuments, prune, simplifyPrimitive, textureCompress, unpartition, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SOURCE = process.argv.find(a => a.startsWith('--source='))?.slice(9) ?? join(homedir(), 'Downloads/highway-assets');
const OUT = 'public/models/highway';
await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready]);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
await mkdir(join(OUT, 'textures'), { recursive: true });

const target = new Document(); target.createBuffer();
const scene = target.createScene('highway-props');
target.getRoot().setDefaultScene(scene);
const triangles = (node: Node) => { let n = 0; node.traverse(child => { for (const p of child.getMesh()?.listPrimitives() ?? []) n += (p.getIndices()?.getCount() ?? 0) / 3; }); return n; };

/**
 * Takes `picks` (kind name → the source nodes making it up) out of a source document into the props document: each
 * kind becomes one node, its parts re-parented under it with their world transforms, and its pivot moved to the
 * middle of its footprint on the ground (sunk by `sink` of its height, so rocks sit in the sand instead of on it).
 */
async function take(source: Document, picks: [string, Node[], number?][]) {
  const sourceScene = source.createScene('take');
  for (const old of source.getRoot().listScenes()) if (old !== sourceScene) old.dispose();
  const kinds: Node[] = [];
  for (const [name, parts, sink = 0] of picks) {
    const kind = source.createNode(name);
    for (const part of parts) {
      const copy = source.createNode(part.getName()).setMesh(part.getMesh()).setMatrix(part.getWorldMatrix());
      kind.addChild(copy);
    }
    const bounds = getBounds(kind), height = bounds.max[1] - bounds.min[1];
    for (const child of kind.listChildren()) {
      const t = child.getTranslation();
      child.setTranslation([t[0] - (bounds.min[0] + bounds.max[0]) / 2, t[1] - bounds.min[1] - height * sink, t[2] - (bounds.min[2] + bounds.max[2]) / 2]);
    }
    sourceScene.addChild(kind); kinds.push(kind);
  }
  await source.transform(prune());
  const map = mergeDocuments(target, source);
  for (const kind of kinds) { const moved = map.get(kind) as Node; moved.detach(); scene.addChild(moved); console.log(`${moved.getName()}: ${triangles(moved).toLocaleString()} triangles`); }
  for (const extra of target.getRoot().listScenes()) if (extra !== scene) extra.dispose();
}

// ------------------------------------------------------------------ city vegetation
{
  const city = await io.read('public/models/tracks/racing-city.runtime.glb');
  const nodes = city.getRoot().listNodes();
  const first = (pattern: RegExp) => { const node = nodes.find(n => pattern.test(n.getName()) && n.getMesh()); if (!node) throw new Error(`No ${pattern} in the city model. Run npm run build:city first.`); return node; };
  for (const node of nodes) node.setExtension('EXT_mesh_gpu_instancing', null);
  await take(city, [
    ['pine', [first(/^RC_Nature_OuterGroves_pine_tree_01/)]],
    ['tree', [first(/^RC_Nature_City_tree_small_02/)]],
    ...[0, 1, 2, 3].map(i => [`shrub-${i}`, [first(new RegExp(`^RC_Nature_PlantingBeds_shrub_02_${i}`))]] as [string, Node[]]),
  ]);
}

// ------------------------------------------------------------------ Poly Haven scans
/** Welds and simplifies every primitive under a node to about `budget` triangles in all. */
async function simplify(doc: Document, budget: number) {
  await doc.transform(weld());
  let total = 0; for (const mesh of doc.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) total += (p.getIndices()?.getCount() ?? 0) / 3;
  const ratio = Math.min(1, budget / total);
  for (const mesh of doc.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) simplifyPrimitive(p, { simplifier: MeshoptSimplifier, ratio, error: .02 });
}
const scan = async (name: string) => io.read(join(SOURCE, name, `${name}_2k.gltf`));
for (const [file, kind, budget, sink] of [['namaqualand_boulder_02', 'rock-0', 2200, .18], ['namaqualand_boulder_05', 'rock-1', 1600, .15], ['dead_tree_trunk_02', 'log', 1800, .12], ['quiver_tree_02', 'quiver', 3200, 0]] as const) {
  const doc = await scan(file);
  await simplify(doc, budget);
  await take(doc, [[kind, doc.getRoot().listNodes().filter(n => n.getMesh()), sink]]);
}
{
  // Rooibos bushes: leaves and twigs are cards, kept whole; alpha-tested instead of blended (no sorting, no halos).
  const doc = await scan('wild_rooibos_bush');
  for (const material of doc.getRoot().listMaterials()) if (material.getAlphaMode() === 'BLEND') material.setAlphaMode('MASK').setAlphaCutoff(.45).setDoubleSided(true);
  const parts = doc.getRoot().listNodes();
  await take(doc, [['bush-0', parts.filter(n => n.getName() === 'wild_rooibos_bush_b')], ['bush-1', parts.filter(n => n.getName() === 'wild_rooibos_bush_c')]]);
}

// The city's textures are already small; the scans' come down from 2K.
await target.transform(
  textureCompress({ encoder: sharp, resize: [1024, 1024], pattern: /rock|boulder|trunk|quiver|log/i }),
  textureCompress({ encoder: sharp, resize: [512, 512], pattern: /rooibos/i }),
  dedup(), prune(), unpartition(),
);
await writeFile(join(OUT, 'highway-props.glb'), await io.writeBinary(target));
console.log(`highway-props.glb: ${scene.listChildren().length} kinds`);

// ------------------------------------------------------------------ surface textures
/** Surfaces: name in the game ← Poly Haven texture, and the size they ship at. */
const SURFACES: [string, string, number][] = [['asphalt', 'asphalt_02', 1024], ['sand', 'gravelly_sand', 1024], ['concrete', 'brushed_concrete_03', 512], ['rock', 'rock_face', 512]];
for (const [name, source, size] of SURFACES) for (const [map, suffix] of [['diff', 'diff'], ['nor', 'nor_gl'], ['rough', 'rough']]) {
  let image = sharp(join(SOURCE, 'textures', `${source}_${suffix}_2k.jpg`)).resize(size, size);
  // The scan is a brown, dusty slab; highway barriers are pale grey cast concrete.
  if (name === 'concrete' && map === 'diff') image = image.modulate({ saturation: .18, brightness: 1.75 });
  await image.jpeg({ quality: map === 'diff' ? 86 : 90, mozjpeg: true }).toFile(join(OUT, 'textures', `${name}_${map}.jpg`));
}
console.log(`textures: ${SURFACES.length} surfaces`);
