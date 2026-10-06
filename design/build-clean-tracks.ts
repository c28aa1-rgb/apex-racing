/** Rebuild runtime venues from supplied originals; never overwrite originals. */
import { NodeIO, PropertyType, type Primitive } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { compactPrimitive, simplifyPrimitive, prune } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import { Matrix4, Vector3, Box3 } from 'three';
import { mkdir, writeFile } from 'node:fs/promises';
import { TRACKS } from '../shared/tracks';
import { bakeRoad } from './bake-road';
import { TRACK_BAKE } from './track-bake';

await Promise.all([MeshoptEncoder.ready,MeshoptSimplifier.ready]);
const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder,'meshopt.encoder':MeshoptEncoder});
const selected=process.argv.find(arg=>arg.startsWith('--track='))?.slice(8),reports=[],skipBake=process.argv.includes('--no-bake');
for(const track of TRACKS.filter(t=>!selected||t.id===selected)){
  const doc=await io.read(`public/models/tracks/${track.model}`),root=doc.getRoot();
  const race=await io.read(`public/models/tracks/${track.model!.replace('.glb','.race.glb')}`);
  // The previous runtime textures retain the original UV layout and are
  // already compressed for the browser. Reuse images, not simplified meshes.
  const textureSlots=['BaseColor','Normal','MetallicRoughness','Occlusion','Emissive'] as const;
  const copied=new Set(),raceMaterials=race.getRoot().listMaterials();
  // Anonymous names are mapped from the supplied diffuse texture contact
  // sheets. Cutout foliage writes depth correctly, unlike sorted blend planes.
  const foliage:Record<string,number[]>={hungaroring:[79],barcelona:[32,34,89],indianapolis:[22,82,83],daytona:[82,84],'marina-bay':[7,14]};
  const overlays:Record<string,number[]>={hungaroring:[12,13,14],barcelona:[48,64,65],'marina-bay':[92,93,94]};
  for(const [index,m]of root.listMaterials().entries())if(m.getAlphaMode()==='BLEND'&&(/groove|stripe|rubber|^line|doted/i.test(m.getName())||overlays[track.id]?.includes(index))){
    // Explicit visual-only road layers need depth bias and must not occlude
    // one another. Keep this metadata with the model, including anonymous IDs.
    m.setExtras({...m.getExtras(),apexRoadOverlay:true,apexNonSolid:true});
  }
  const cutouts:string[]=[];
  for(const [index,m] of root.listMaterials().entries())if(m.getAlphaMode()==='BLEND'&&(/tree|pine|bush/i.test(m.getName())||foliage[track.id]?.includes(index))){
    m.setAlphaMode('MASK').setAlphaCutoff(.3).setDoubleSided(true);
    m.setExtras({...m.getExtras(),apexNonSolid:true,apexFoliage:true});cutouts.push(m.getName());
  }
  for(const m of root.listMaterials()){
    const old=raceMaterials.find(o=>o.getName()===m.getName());if(!old)continue;
    for(const slot of textureSlots){
      const get=`get${slot}Texture` as const,a=m[get](),b=old[get]();
      if(a&&b?.getImage()&&!copied.has(a)){a.setImage(b.getImage()).setMimeType(b.getMimeType());copied.add(a);}
    }
  }
  const matrices=new Map<Primitive,Matrix4>();
  root.getDefaultScene()!.traverse(n=>{for(const p of n.getMesh()?.listPrimitives()??[])matrices.set(p,new Matrix4().fromArray(n.getWorldMatrix()));});
  let sourceTriangles=0,removedDegenerate=0,removedDuplicate=0,simplified=0;
  const rows=[];
  for(const mesh of root.listMeshes())for(const p of mesh.listPrimitives()){
    const pos=p.getAttribute('POSITION');if(!pos||p.getMode()!==4)continue;
    const matrix=matrices.get(p)??new Matrix4(),indices=p.getIndices(),count=indices?.getCount()??pos.getCount(),keep:number[]=[],seen=new Set<string>();
    const bounds=new Box3(),vertices:Vector3[]=[],keys:string[]=[];
    const attrs=p.listSemantics().map(semantic=>p.getAttribute(semantic)!);
    for(let i=0;i<pos.getCount();i++){
      const point=new Vector3().fromArray(pos.getElement(i,[])).applyMatrix4(matrix);vertices.push(point);bounds.expandByPoint(point);
      keys.push(attrs.map(a=>a.getElement(i,[]).join(',')).join('/'));
    }
    let degenerate=0,duplicates=0;
    for(let i=0;i+2<count;i+=3){
      const ids=[0,1,2].map(j=>indices?.getScalar(i+j)??i+j),[a,b,c]=ids.map(index=>vertices[index]);
      if(!a||!b||!c||![...a,...b,...c].every(Number.isFinite))throw new Error(`${track.id}/${mesh.getName()}: invalid triangle`);
      if(b.clone().sub(a).cross(c.clone().sub(a)).length()<1e-8){degenerate++;continue;}
      // Exact complete-attribute duplicates only, preserving opposite winding,
      // UV seams and separately authored overlay materials.
      const vs=ids.map(index=>keys[index]),start=vs[0]<=vs[1]&&vs[0]<=vs[2]?0:vs[1]<=vs[2]?1:2;
      const key=[vs[start],vs[(start+1)%3],vs[(start+2)%3]].join('|');
      if(seen.has(key)){duplicates++;continue;}seen.add(key);keep.push(...ids);
    }
    p.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(keep)).setBuffer(root.listBuffers()[0]));
    compactPrimitive(p);
    const material=p.getMaterial(),name=material?.getName()??'';
    // Preserve thin roads/markings, fences, vegetation and poles exactly. For
    // generic scenery allow at most 5 mm error, never a venue-sized percentage.
    // Baked road materials keep every source triangle: the bake refines them itself, and simplifying the
    // anonymous Daytona asphalt previously produced zero-area needles that stood up in the lane.
    const bake=TRACK_BAKE[track.id],materialIndex=root.listMaterials().indexOf(material!);
    const baked=!!bake&&[...bake.surface,...bake.kerbs,...bake.overlays].includes(materialIndex);
    const protectedSurface=baked||/road|asph|tarmac|line|groove|stripe|rubber|kerb|curb|fence|pole|light|tree|bush/i.test(name)||material?.getAlphaMode()!=='OPAQUE';
    const radius=bounds.getSize(new Vector3()).length();
    if(keep.length>9000&&!protectedSurface){
      simplifyPrimitive(p,{simplifier:MeshoptSimplifier,ratio:.65,error:Math.min(.00001,.005/Math.max(1,radius)),lockBorder:true});
    }
    // Edge collapse can leave collinear faces even when the source was clean.
    // Validate the final topology too, before the lossless export.
    const finalPos=p.getAttribute('POSITION')!,finalIndex=p.getIndices()!,valid:number[]=[];
    for(let i=0;i<finalIndex.getCount();i+=3){
      const ids=[0,1,2].map(j=>finalIndex.getScalar(i+j));
      const [a,b,c]=ids.map(index=>new Vector3().fromArray(finalPos.getElement(index,[])).applyMatrix4(matrix));
      if(b.clone().sub(a).cross(c.clone().sub(a)).length()<1e-8)continue;
      valid.push(...ids);
    }
    p.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(valid)).setBuffer(root.listBuffers()[0]));
    compactPrimitive(p);
    const final=(p.getIndices()?.getCount()??0)/3;
    sourceTriangles+=count/3;removedDegenerate+=degenerate;removedDuplicate+=duplicates;simplified+=keep.length/3-final;
    rows.push({mesh:mesh.getName(),material:name,source:count/3,degenerate,duplicates,final,protected:protectedSurface});
  }
  // Visible road == physical road: conform the drivable surface to one smooth field (design/bake-road.ts).
  let bakeReport;
  if(TRACK_BAKE[track.id]&&!skipBake){
    bakeReport=bakeRoad(doc,track,TRACK_BAKE[track.id]);
    await mkdir('work/track-cleanup',{recursive:true});
    await writeFile(`work/track-cleanup/bake-${track.id}.json`,JSON.stringify(bakeReport,null,2));
    console.log(track.id,'bake',{...bakeReport,materials:undefined});
  }
  // No new POSITION quantization: old quantization moved thin road decals and
  // poles by centimeters on large meshes. Meshopt entropy encoding is lossless.
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({method:EXTMeshoptCompression.EncoderMethod.QUANTIZE});
  await doc.transform(prune({propertyTypes:[PropertyType.ACCESSOR],keepAttributes:true,keepExtras:true}));
  const filename=track.model!.replace('.glb','.clean.glb');
  await io.write(`public/models/tracks/${filename}`,doc);
  const report={id:track.id,filename,bake:bakeReport?{...bakeReport,materials:undefined}:undefined,sourceTriangles,removedDegenerate,removedDuplicate,simplified,final:sourceTriangles-removedDegenerate-removedDuplicate-simplified,cutouts,rows};
  reports.push(report);console.log(track.id,{...report,rows:undefined});
}
await mkdir('work/track-cleanup',{recursive:true});
await writeFile(`work/track-cleanup/build${selected?`-${selected}`:''}.json`,JSON.stringify(reports,null,2));
