/**
 * Packs the city's traffic cars into one GLB.
 *
 *   npm run build:traffic [-- --source=/folder/with/the/downloaded/glbs]
 *
 * Source models: DanielZhabotinsky's "low poly model" road cars on Sketchfab (CC BY 4.0), downloaded as GLB. Each
 * car is turned to the game's convention (forward +z, right -x, wheels on y = 0, centred between the axles) under one
 * node named after it, its wheel parts tagged so the game can spin and steer them, and its lamp parts tagged so they
 * can glow. Textures shared between the cars (tyres, glass, undersides, plates) are stored once and re-encoded as WebP.
 * Writes public/models/traffic/traffic-cars.glb and CREDITS.txt.
 */
import { NodeIO, type Document, type Node } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTTextureWebP } from '@gltf-transform/extensions';
import { dedup, mergeDocuments, prune, textureCompress, unpartition } from '@gltf-transform/functions';
import sharp from 'sharp';
import { Box3, Matrix4, Vector3 } from 'three';
import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Sketchfab models used, by file name prefix: display name and model id, for the credits. */
const MODELS: Record<string, { name: string; id: string }> = {
  ace_11: { name: "Ace '11", id: '055ff8a21b8d4d279debca089e2fafcd' },
  milano_95: { name: "Milano '95", id: '122a22d210234596ad23623588d0d166' },
  negotiator_80: { name: "Negotiator '80", id: '892b2684fb37442299bfad9222cf331c' },
  fairheaven_lt_80: { name: "Fairheaven LT '80", id: 'e2678da920cc4be68dbc193727919ffb' },
  fairheaven_lt_80_taxi: { name: "Fairheaven LT '80 Taxi", id: '7da68ec2677f4abd8e31e9998b497a67' },
  asti_stradale_89: { name: "Asti Stradale '89", id: '97b15b067111443ebe05840137b49c65' },
  lightbody_90_md_utility: { name: "Lightbody '90 MD Utility", id: 'd3aca50a8f2b4917bb9f4ce2bf1ccfe5' },
  lct_3000_07: { name: "LCT 3000 '07", id: '3be03b6a43aa41898c9ca806b8787052' },
  illinois_90: { name: "Illinois '90", id: 'd604871eee5b4181bb298163b0b675b7' },
  canyon_75_taxi: { name: "Canyon '75 Taxi", id: '9e8f92a215784f3d8aaaaeab1bef54c4' },
  fairheaven_lt_80_cop_cruiser: { name: "Fairheaven LT '80 Cop Cruiser", id: '61766c1e6e1e4b2b803c174f33433a74' },
  bokaroo_67: { name: "Bokaroo '67", id: '22015d1863d6455aa31cfd738b972c50' },
};
const defaultSource = [join(homedir(), 'Downloads/traffic-cars'), join(homedir(), 'Downloads')].find(existsSync)!;
const source = process.argv.find(arg => arg.startsWith('--source='))?.slice(9) ?? defaultSource;

/** Part roles, from the source mesh names. Everything else is body. */
const role = (name: string) => /Wheel(Stock|Hubcaps)/i.test(name) ? 'wheel'
  : /Headlights\d*_UCB_Lights_and_Glass_0/i.test(name) ? 'head'
  : /(Brakelights|Taillights)\d*_UCB_Lights_and_Glass_0/i.test(name) ? 'tail' : 'body';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const files = (await readdir(source)).filter(file => /-_low_poly_model\.glb$/.test(file)).sort();
if (!files.length) throw new Error(`No "*-_low_poly_model.glb" files in ${source}.`);
let out: Document | undefined;
const credits: string[] = [];
for (const file of files) {
  const key = file.replace(/_?-_low_poly_model\.glb$/, ''), meta = MODELS[key];
  const doc = await io.read(join(source, file));
  const scene = doc.getRoot().getDefaultScene()!;
  // Wheel centres decide where the car is: the export origins vary (one taxi sits 8 m to the side).
  const wheels: Vector3[] = [], box = new Box3();
  scene.traverse(node => {
    const mesh = node.getMesh(); if (!mesh) return;
    const matrix = new Matrix4().fromArray(node.getWorldMatrix()), part = new Box3();
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute('POSITION')!, element: number[] = [];
      for (let i = 0; i < position.getCount(); i++) part.expandByPoint(new Vector3().fromArray(position.getElement(i, element)).applyMatrix4(matrix));
    }
    if (role(node.getName()) === 'wheel') wheels.push(part.getCenter(new Vector3()));
    if (!/Taxi_?Beacon/i.test(node.getName()) || part.max.y < 3) box.union(part);
    node.setExtras({ ...node.getExtras(), apexPart: role(node.getName()) });
  });
  if (wheels.length < 4) throw new Error(`${file}: expected 4 wheels, found ${wheels.length}.`);
  const centre = wheels.reduce((sum, wheel) => sum.add(wheel), new Vector3()).divideScalar(wheels.length);
  // Source cars face +x with their right at +z; the game's face +z with their right at -x: a -90 degree turn about y.
  const vehicle = doc.createNode(key.replace(/_/g, '-'))
    .setRotation([0, -Math.SQRT1_2, 0, Math.SQRT1_2])
    .setTranslation([centre.z, -box.min.y, -centre.x])
    .setExtras({ apexVehicle: true, name: meta?.name ?? key });
  for (const child of scene.listChildren()) vehicle.addChild(child);
  scene.addChild(vehicle);
  if (!out) out = doc;
  else {
    const map = mergeDocuments(out, doc);
    out.getRoot().getDefaultScene()!.addChild(map.get(vehicle) as Node);
  }
  credits.push(`- ${meta?.name ?? key} by DanielZhabotinsky, CC BY 4.0${meta ? ` - https://sketchfab.com/3d-models/${meta.id}` : ''}`);
  console.log(`${key}: ${wheels.length} wheels, ${(box.max.x - box.min.x).toFixed(2)} m long`);
}
const scene = out!.getRoot().getDefaultScene()!;
for (const extra of out!.getRoot().listScenes()) if (extra !== scene) extra.dispose();
out!.createExtension(EXTTextureWebP).setRequired(true);
await out!.transform(
  dedup(), prune(), unpartition(),
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024], quality: 82 }),
);
await mkdir('public/models/traffic', { recursive: true });
await writeFile('public/models/traffic/traffic-cars.glb', await io.writeBinary(out!));
await writeFile('public/models/traffic/CREDITS.txt', `City traffic vehicles, modified (turned, recentred, textures re-encoded):\n${credits.join('\n')}\nLicence: https://creativecommons.org/licenses/by/4.0/\n`);
console.log(`wrote public/models/traffic/traffic-cars.glb (${files.length} vehicles)`);
