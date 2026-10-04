// Writes download-sized runtime copies of every selectable car. The supplied
// GLBs carry 4096 px PNG/JPEG textures (up to 52 MB per car) that take seconds
// to download, decode and upload on each car change. Runtime copies resize
// textures to 2048 px WebP and deduplicate repeated data; geometry, node names
// and materials are unchanged, so the rig and wheel detection behave identically.
// Run: node --import tsx design/build-car-runtime.ts
import { mkdirSync, statSync } from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, textureCompress } from '@gltf-transform/functions';
import sharp from 'sharp';
import { CARS } from '../shared/cars';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
mkdirSync('public/models/cars/runtime', { recursive: true });
for (const car of CARS) {
  const source = `public/models/cars/${car.model}`, target = `public/models/cars/runtime/${car.model}`;
  const document = await io.read(source);
  await document.transform(dedup(), textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [2048, 2048], quality: 85 }));
  await io.write(target, document);
  const mb = (path: string) => (statSync(path).size / 1048576).toFixed(1);
  console.log(`${car.id.padEnd(18)} ${mb(source).padStart(5)} MB -> ${mb(target).padStart(5)} MB`);
}
