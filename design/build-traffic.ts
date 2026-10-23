/**
 * Packs the city's traffic cars into one small GLB: one flattened mesh per vehicle, all sharing Kenney's palette
 * texture, so the renderer can draw every car of a kind as a single instanced batch.
 *
 *   npm run build:traffic [-- --source=/path/to/kenney_car-kit]
 *
 * Source: Kenney "Car Kit" 3.1 (CC0), https://kenney.nl/assets/car-kit. Writes public/models/traffic/traffic-cars.glb.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, flatten, join, mergeDocuments, prune, unpartition } from '@gltf-transform/functions';
import { mkdir, writeFile } from 'node:fs/promises';
import { join as path } from 'node:path';

const source = process.argv.find(arg => arg.startsWith('--source='))?.slice(9) ?? 'work/traffic-src/kit';
/** The kit is toy-proportioned (a sedan is 1.5 m wide and 2.55 m long); this brings it to ~2 m by 4.5 m. */
const SCALE = [1.35, 1.6, 1.75];
export const TRAFFIC_MODELS = ['sedan', 'sedan-sports', 'suv', 'suv-luxury', 'taxi', 'van', 'hatchback-sports', 'truck', 'delivery'];

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const out = await io.read(path(source, 'Models/GLB format', `${TRAFFIC_MODELS[0]}.glb`));
out.getRoot().listScenes().forEach(scene => scene.dispose());
const scene = out.createScene('traffic');
out.getRoot().setDefaultScene(scene);
for (const name of TRAFFIC_MODELS) {
  const doc = await io.read(path(source, 'Models/GLB format', `${name}.glb`));
  await doc.transform(flatten(), join({ keepNamed: false }));
  const map = mergeDocuments(out, doc);
  const vehicle = out.createNode(name).setScale(SCALE as [number, number, number]);
  for (const node of doc.getRoot().getDefaultScene()!.listChildren()) vehicle.addChild(map.get(node) as never);
  scene.addChild(vehicle);
}
await out.transform(dedup(), prune(), unpartition());
await mkdir('public/models/traffic', { recursive: true });
await writeFile('public/models/traffic/traffic-cars.glb', await io.writeBinary(out));
await writeFile('public/models/traffic/CREDITS.txt', 'Traffic vehicles: "Car Kit" 3.1 by Kenney (www.kenney.nl), CC0 1.0. https://kenney.nl/assets/car-kit\n');
console.log(`wrote public/models/traffic/traffic-cars.glb: ${TRAFFIC_MODELS.join(', ')}`);
