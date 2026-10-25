/**
 * Packs the police cruisers used for the city race roadblocks into one GLB.
 *
 *   npm run build:police [-- --source=/folder/with/the/unzipped/models]
 *
 * Source models: DanielZhabotinsky's "Cop Cruiser - Low poly model" cars on Sketchfab (CC BY 4.0), downloaded as
 * glTF zips (each unzipped to a folder holding scene.gltf). Each car is turned and centred like the traffic cars
 * (design/build-traffic.ts: forward +z, wheels on y = 0, centred between the axles) under one node named after it,
 * with its wheel, lamp and lightbar parts tagged. Writes public/models/traffic/police-cars.glb and adds the credits.
 */
import { NodeIO, type Document, type Node } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTTextureWebP } from '@gltf-transform/extensions';
import { dedup, mergeDocuments, prune, textureCompress, unpartition } from '@gltf-transform/functions';
import sharp from 'sharp';
import { Box3, Matrix4, Vector3 } from 'three';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MODELS: Record<string, { name: string; id: string }> = {
  fairheaven_lt_80_cop_cruiser: { name: "Fairheaven LT '80 Cop Cruiser", id: '61766c1e6e1e4b2b803c174f33433a74' },
  negotiator_80_cop_cruiser: { name: "Negotiator '80 Cop Cruiser", id: '945fd09f513f4d1ab19b6388a7ea7323' },
};
const source = process.argv.find(arg => arg.startsWith('--source='))?.slice(9) ?? join(homedir(), 'Downloads/police-cars');

const role = (name: string) => /Wheel(Stock|Stamp|Hubcaps)/i.test(name) ? 'wheel'
  : /Lightbar/i.test(name) ? 'beacon'
  : /Headlights\d*_UCB_Lights_and_Glass_0/i.test(name) ? 'head'
  : /(Brakelights|Taillights)\d*_UCB_Lights_and_Glass_0/i.test(name) ? 'tail' : 'body';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
if (!existsSync(source)) throw new Error(`No ${source}: unzip the two cop cruiser downloads into folders there.`);
const folders = (await readdir(source)).filter(folder => existsSync(join(source, folder, 'scene.gltf'))).sort();
if (!folders.length) throw new Error(`No model folders with a scene.gltf in ${source}.`);
let out: Document | undefined;
const credits: string[] = [];
for (const folder of folders) {
  const key = folder.replace(/_?-_low_poly_model$/, ''), meta = MODELS[key];
  const doc = await io.read(join(source, folder, 'scene.gltf'));
  const scene = doc.getRoot().getDefaultScene()!;
  const wheels: Vector3[] = [], box = new Box3(), beacon = new Box3();
  scene.traverse(node => {
    const mesh = node.getMesh(); if (!mesh) return;
    const matrix = new Matrix4().fromArray(node.getWorldMatrix()), part = new Box3();
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute('POSITION')!, element: number[] = [];
      for (let i = 0; i < position.getCount(); i++) part.expandByPoint(new Vector3().fromArray(position.getElement(i, element)).applyMatrix4(matrix));
    }
    const kind = role(node.getName());
    if (kind === 'wheel') wheels.push(part.getCenter(new Vector3()));
    if (kind === 'beacon') beacon.union(part);
    box.union(part);
    node.setExtras({ ...node.getExtras(), apexPart: kind });
  });
  if (wheels.length < 4) throw new Error(`${folder}: expected 4 wheels, found ${wheels.length}.`);
  const centre = wheels.reduce((sum, wheel) => sum.add(wheel), new Vector3()).divideScalar(wheels.length);
  // Source cars face +x with their right at +z; the game's face +z with their right at -x: a -90 degree turn about y.
  const toGame = (p: Vector3) => new Vector3(centre.z - p.z, p.y - box.min.y, p.x - centre.x);
  const lamps = new Box3().setFromPoints([toGame(beacon.min), toGame(beacon.max)]);
  const vehicle = doc.createNode(key.replace(/_/g, '-'))
    .setRotation([0, -Math.SQRT1_2, 0, Math.SQRT1_2])
    .setTranslation([centre.z, -box.min.y, -centre.x])
    // Where the lightbar sits and how wide it is (game axes), for the flashing lamps drawn over it.
    .setExtras({ apexVehicle: true, name: meta?.name ?? key, beacon: { min: lamps.min.toArray(), max: lamps.max.toArray() } });
  for (const child of scene.listChildren()) vehicle.addChild(child);
  scene.addChild(vehicle);
  if (!out) out = doc;
  else {
    const map = mergeDocuments(out, doc);
    out.getRoot().getDefaultScene()!.addChild(map.get(vehicle) as Node);
  }
  credits.push(`- ${meta?.name ?? key} by DanielZhabotinsky, CC BY 4.0${meta ? ` - https://sketchfab.com/3d-models/${meta.id}` : ''}`);
  console.log(`${key}: ${wheels.length} wheels, ${(box.max.x - box.min.x).toFixed(2)} m long, lightbar ${beacon.isEmpty() ? 'missing' : 'found'}`);
}
const scene = out!.getRoot().getDefaultScene()!;
for (const extra of out!.getRoot().listScenes()) if (extra !== scene) extra.dispose();
out!.createExtension(EXTTextureWebP).setRequired(true);
await out!.transform(
  dedup(), prune(), unpartition(),
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024], quality: 82 }),
);
await mkdir('public/models/traffic', { recursive: true });
await writeFile('public/models/traffic/police-cars.glb', await io.writeBinary(out!));
// Credits: the traffic list, then the police cars (replacing an earlier police section).
const file = 'public/models/traffic/CREDITS.txt', previous = existsSync(file) ? (await readFile(file, 'utf8')).split('\nRoadblock police cars')[0].trimEnd() : '';
await writeFile(file, `${previous}\n\nRoadblock police cars, modified (turned, recentred, textures re-encoded):\n${credits.join('\n')}\nLicence: https://creativecommons.org/licenses/by/4.0/\n`);
console.log(`wrote public/models/traffic/police-cars.glb (${folders.length} vehicles)`);
