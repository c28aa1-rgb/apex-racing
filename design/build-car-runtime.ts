// Writes download-sized runtime copies of every selectable car. The supplied
// GLBs carry 4096 px PNG/JPEG textures (up to 52 MB per car) that take seconds
// to download, decode and upload on each car change. Runtime copies resize
// textures to 2048 px WebP and deduplicate repeated data; geometry, node names
// and materials are unchanged, so the rig and wheel detection behave identically. Vertex attributes no material
// reads (spare UV sets in the baked formula liveries) are dropped.
// Run: node --import tsx design/build-car-runtime.ts [car-or-livery-id ...]  (no ids: every car and livery)
import { mkdirSync, statSync } from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, textureCompress } from '@gltf-transform/functions';
import sharp from 'sharp';
import { CARS } from '../shared/cars';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
mkdirSync('public/models/cars/runtime', { recursive: true });
const only = process.argv.slice(2);
// Half a million vertices each: their tangents alone are ~8 MB. three.js derives the normal-map basis per pixel without them.
const DROP_TANGENTS = new Set(['mercedes-w14', 'ferrari-sf23']);
const models = CARS.flatMap(car => car.liveries?.length ? car.liveries : [car]);
for (const car of models.filter(car => !only.length || only.includes(car.id))) {
  const source = `public/models/cars/${car.model}`, target = `public/models/cars/runtime/${car.model}`;
  const document = await io.read(source);
  await document.transform(dedup(), prune({ keepAttributes: false }), textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [2048, 2048], quality: 85 }));
  if (DROP_TANGENTS.has(car.id)) for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) primitive.setAttribute('TANGENT', null);
  await document.transform(prune());
  await io.write(target, document);
  const mb = (path: string) => (statSync(path).size / 1048576).toFixed(1);
  console.log(`${car.id.padEnd(18)} ${mb(source).padStart(5)} MB -> ${mb(target).padStart(5)} MB`);
}
