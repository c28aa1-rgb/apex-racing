import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { Matrix4, Vector3, Box3 } from 'three';
import { mkdir, writeFile } from 'node:fs/promises';
import { TRACKS } from '../shared/tracks';

const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder});
const results=[];
for(const track of TRACKS)for(const variant of ['source','race']){
  const path=`public/models/tracks/${variant==='source'?track.model:track.model!.replace('.glb','.race.glb')}`;
  const doc=await io.read(path),root=doc.getRoot(),rows:unknown[]=[];
  let total=0,degenerate=0,nonfinite=0,missingUV=0;
  root.getDefaultScene()!.traverse(node=>{
    const matrix=new Matrix4().fromArray(node.getWorldMatrix());
    for(const p of node.getMesh()?.listPrimitives()??[]){
      const pos=p.getAttribute('POSITION');if(!pos||p.getMode()!==4)continue;
      const bounds=new Box3(),vertices:Vector3[]=[],index=p.getIndices(),m=p.getMaterial();let deg=0,bad=0,edge=0;
      for(let i=0;i<pos.getCount();i++){
        const v=new Vector3().fromArray(pos.getElement(i,[])).applyMatrix4(matrix);
        if(!v.toArray().every(Number.isFinite))bad++;vertices.push(v);bounds.expandByPoint(v);
      }
      const count=index?.getCount()??pos.getCount();
      for(let i=0;i+2<count;i+=3){
        const a=vertices[index?.getScalar(i)??i],b=vertices[index?.getScalar(i+1)??i+1],c=vertices[index?.getScalar(i+2)??i+2];
        if(!a||!b||!c){bad++;continue;}
        const area=b.clone().sub(a).cross(c.clone().sub(a)).length();if(area<1e-8)deg++;
        edge=Math.max(edge,a.distanceTo(b),b.distanceTo(c),c.distanceTo(a));
      }
      const uvMissing=!!m?.getBaseColorTexture()&&!p.getAttribute('TEXCOORD_0');if(uvMissing)missingUV++;
      rows.push({node:node.getName(),mesh:node.getMesh()!.getName(),material:m?.getName(),materialIndex:root.listMaterials().indexOf(m!),
        vertices:pos.getCount(),triangles:count/3,degenerate:deg,nonfinite:bad,largestEdge:edge,
        bounds:[bounds.min.toArray(),bounds.max.toArray()],size:bounds.getSize(new Vector3()).toArray(),
        color:m?.getBaseColorFactor(),alpha:m?.getAlphaMode(),texture:m?.getBaseColorTexture()?.getName(),uvMissing});
      total+=count/3;degenerate+=deg;nonfinite+=bad;
    }
  });
  results.push({id:track.id,variant,total,degenerate,nonfinite,missingUV,rows});
  console.log(track.id,variant,{total,degenerate,nonfinite,missingUV});
}
await mkdir('work/track-cleanup',{recursive:true});
await writeFile('work/track-cleanup/geometry-audit.json',JSON.stringify(results));
