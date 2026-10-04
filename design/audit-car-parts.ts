import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { Box3, Matrix4, Vector3 } from 'three';
import { writeFile } from 'node:fs/promises';
import { CARS } from '../shared/cars';

const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder});
for(const car of CARS){
  const doc=await io.read(`public/models/cars/${car.model}`),parts:unknown[]=[],box=new Box3();
  const materials=doc.getRoot().listMaterials();
  doc.getRoot().getDefaultScene()!.traverse(node=>{
    const mesh=node.getMesh();if(!mesh)return;
    const matrix=new Matrix4().fromArray(node.getWorldMatrix());
    for(const p of mesh.listPrimitives()){
      const pos=p.getAttribute('POSITION');if(!pos)continue;
      const bounds=new Box3(),v=new Vector3(),element:number[]=[];
      for(let i=0;i<pos.getCount();i++){pos.getElement(i,element);bounds.expandByPoint(v.fromArray(element).applyMatrix4(matrix));}
      box.union(bounds);
      const mat=p.getMaterial();
      parts.push({node:node.getName(),mesh:mesh.getName(),material:mat?.getName(),materialIndex:materials.indexOf(mat!),vertices:pos.getCount(),min:bounds.min.toArray(),max:bounds.max.toArray()});
    }
  });
  const report={id:car.id,min:box.min.toArray(),max:box.max.toArray(),parts,materials:materials.map(m=>({name:m.getName(),color:m.getBaseColorFactor(),emissive:m.getEmissiveFactor(),texture:!!m.getBaseColorTexture()}))};
  await writeFile(`work/${car.id}-parts.json`,JSON.stringify(report,null,2));
  console.log(car.id, 'parts',parts.length,'materials',report.materials.length);
}
