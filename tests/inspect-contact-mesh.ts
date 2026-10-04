import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { Matrix4, Triangle, Vector3, Box3 } from 'three';

const [track='indianapolis',x='-451.279',y='11.22',z='350.68']=process.argv.slice(2);
const point=new Vector3(+x,+y,+z),io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder});
const doc=await io.read(`public/models/tracks/${track}.glb`),matches:unknown[]=[];
doc.getRoot().getDefaultScene()!.traverse(node=>{
  const mesh=node.getMesh();if(!mesh)return;
  const matrix=new Matrix4().fromArray(node.getWorldMatrix());
  for(const primitive of mesh.listPrimitives()){
    const position=primitive.getAttribute('POSITION');if(!position)continue;
    const indices=primitive.getIndices(),bounds=new Box3(),verts:Vector3[]=[];
    for(let i=0;i<position.getCount();i++){const p=new Vector3().fromArray(position.getElement(i,[])).applyMatrix4(matrix);verts.push(p);bounds.expandByPoint(p);}
    if(bounds.distanceToPoint(point)>1)continue;
    let minimum=Infinity,closest:unknown;
    for(let i=0;i<(indices?.getCount()??verts.length);i+=3){
      const a=verts[indices?.getScalar(i)??i],b=verts[indices?.getScalar(i+1)??i+1],c=verts[indices?.getScalar(i+2)??i+2];
      const tri=new Triangle(a,b,c),near=tri.closestPointToPoint(point,new Vector3()),d=near.distanceTo(point);
      if(d<minimum){minimum=d;closest={a:a.toArray(),b:b.toArray(),c:c.toArray(),normal:tri.getNormal(new Vector3()).toArray()};}
    }
    if(minimum<1)matches.push({node:node.getName(),material:primitive.getMaterial()?.getName(),alpha:primitive.getMaterial()?.getAlphaMode(),factor:primitive.getMaterial()?.getBaseColorFactor(),distance:minimum,bounds:[bounds.min.toArray(),bounds.max.toArray()],closest});
  }
});
console.log(JSON.stringify(matches,null,2));
