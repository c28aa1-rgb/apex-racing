/** Derive contact geometry from the SAME optimized GLBs used by the renderer. */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { Matrix4, Vector3 } from 'three';
import { writeFile, mkdir } from 'node:fs/promises';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { TRACKS } from '../shared/tracks';
import { chassisWalls, sealCracks } from './seal-cracks';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const sheets = process.argv.includes('--sheets');
const selected = process.argv.find(arg=>arg.startsWith('--track='))?.slice(8);
await mkdir('work/material-audit', { recursive: true });
for (const track of TRACKS.filter(track=>!selected||track.id===selected)) {
  const doc = await io.read(`public/models/tracks/${track.runtimeModel??track.model}`);
  const materials = doc.getRoot().listMaterials();
  if (sheets) {
    const canvas = createCanvas(1000, Math.ceil(materials.length / 8) * 100), ctx = canvas.getContext('2d');
    ctx.fillStyle = '#172b39'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < materials.length; i++) {
      const m = materials[i], bytes = m.getBaseColorTexture()?.getImage(), x = i % 8 * 125, y = Math.floor(i / 8) * 100;
      if (bytes) { const img = await loadImage(Buffer.from(bytes)); ctx.drawImage(img, x, y, 120, 75); }
      ctx.fillStyle = 'white'; ctx.font = '10px sans-serif'; ctx.fillText(`${i}: ${m.getName()}`, x + 2, y + 89, 121);
    }
    await writeFile(`work/material-audit/${track.id}.png`, canvas.toBuffer('image/png')); continue;
  }
  const vertices: number[] = [], indices: number[] = [], types: number[] = [];
  // Audited against the embedded diffuse texture sheets (--sheets). These
  // exporters lost semantic material names; indices refer to the shipped GLBs.
  const anonymousGrass: Record<string, number[]> = { hungaroring: [0,5,6,20], barcelona: [90], indianapolis: [8,9,10,11,12,13,14,17,80], daytona: [71,89,90], 'marina-bay': [97] };
  const anonymousGravel: Record<string, number[]> = { hungaroring: [75,76,77], barcelona: [39,49,50], indianapolis: [15,16] };
  const a = new Vector3(), b = new Vector3(), c = new Vector3();
  doc.getRoot().getDefaultScene()!.traverse(node => {
    const mesh = node.getMesh(); if (!mesh) return;
    const matrix = new Matrix4().fromArray(node.getWorldMatrix());
    for (const primitive of mesh.listPrimitives()) {
      if (primitive.getMode() !== 4) continue;
      const material = primitive.getMaterial(), name = material?.getName() ?? '', materialIndex = materials.indexOf(material!);
      if(material?.getExtras().apexNonSolid===true)continue;
      // Fully transparent helpers and alpha-blended foliage/decal planes have
      // no solid volume. Visible fences/glass remain physical.
      if (material && (material.getBaseColorFactor()[3] < .05 || (material.getAlphaMode() === 'BLEND' && !/fence|glass|rail|barrier/i.test(name)))) continue;
      if (/groove|decal|stripe|rubber|^line|doted|grassbrd|sandbrd|tree|bush|water/i.test(name)) continue;
      const type = /grass|turf|carpet|dirt|sbancamento/i.test(name) || anonymousGrass[track.id]?.includes(materialIndex) ? 1
        : /sand|gravel/i.test(name) || anonymousGravel[track.id]?.includes(materialIndex) ? 2 : 0;
      const position = primitive.getAttribute('POSITION'); if (!position) continue;
      const primitiveVertices: number[] = [], v = new Vector3(), element: number[] = [];
      for (let i = 0; i < position.getCount(); i++) { position.getElement(i, element); v.fromArray(element).applyMatrix4(matrix); primitiveVertices.push(v.x, v.y, v.z); }
      const source = primitive.getIndices(), primitiveIndices: number[] = [];
      for (let i = 0; i + 2 < (source?.getCount() ?? position.getCount()); i += 3) {
        const ids = [0, 1, 2].map(j => source ? source.getScalar(i + j) : i + j);
        a.fromArray(primitiveVertices, ids[0] * 3); b.fromArray(primitiveVertices, ids[1] * 3); c.fromArray(primitiveVertices, ids[2] * 3);
        b.sub(a); c.sub(a); const normal = b.cross(c), area = normal.length(); if (area < 1e-6) continue;
        // Ground can be authored with either winding; wheel rays require the
        // upward side. Vertical faces keep their source winding.
        if (normal.y < -area * .2) [ids[1], ids[2]] = [ids[2], ids[1]];
        primitiveIndices.push(...ids);
      }
      if (!primitiveIndices.length) continue;
      const offset = vertices.length / 3;
      for (const coordinate of primitiveVertices) vertices.push(coordinate);
      for (const index of primitiveIndices) indices.push(index + offset);
      for (let i = 0; i < primitiveIndices.length; i += 3) types.push(type);
    }
  });
  // Bridge the few-centimetre cracks between separate floor meshes so a single-ray tyre cannot drop into them.
  const flanges = sealCracks(vertices, indices, types, { reach: 1.25, drop: .02, tolerance: .1 });
  // Which steep faces stop the car body (APEXCOL3 appends one byte per triangle).
  const walls = chassisWalls(vertices, indices, .15);
  const v = new Float32Array(vertices), i = new Uint32Array(indices), t = new Uint8Array(types);
  const header = Buffer.alloc(16); header.write('APEXCOL3'); header.writeUInt32LE(v.length / 3, 8); header.writeUInt32LE(i.length, 12);
  await writeFile(`public/models/tracks/${track.collision}`, Buffer.concat([header, Buffer.from(v.buffer), Buffer.from(i.buffer), Buffer.from(t.buffer), Buffer.from(walls.buffer)]));
  console.log(`${track.id}: ${types.length - flanges * 2} visible physical triangles + ${flanges} crack flanges, ${walls.reduce((sum, w) => sum + w, 0)} chassis walls, ${(v.byteLength+i.byteLength+t.byteLength)/1e6} MB`);
}
