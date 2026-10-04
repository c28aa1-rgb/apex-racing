import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { Box3, Matrix4, Vector3 } from 'three';
import { CARS } from '../shared/cars';
const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder});
for(const id of ['bugatti-bolide','mclaren-720s-gt3','porsche-963','skyline-r34']){
 const car=CARS.find(c=>c.id===id)!,doc=await io.read(`public/models/cars/${car.model}`),rows:unknown[]=[];
 doc.getRoot().getDefaultScene()!.traverse(node=>{const mesh=node.getMesh();if(!mesh)return;
  for(const prim of mesh.listPrimitives()){
   const name=prim.getMaterial()?.getName()??'';if(!/interior|carbon|textured|coloured/i.test(name))continue;
   const pos=prim.getAttribute('POSITION')!,indices=prim.getIndices(),matrix=new Matrix4().fromArray(node.getWorldMatrix()),weld=new Map<string,number>(),parent:number[]=[],vertices:Vector3[]=[],element:number[]=[];
   const find=(i:number):number=>parent[i]===i?i:(parent[i]=find(parent[i]));
   for(let i=0;i<pos.getCount();i++){pos.getElement(i,element);const v=new Vector3().fromArray(element).applyMatrix4(matrix).multiplyScalar(100);vertices.push(v);const key=v.toArray().map(x=>Math.round(x*100000)).join(',');parent[i]=weld.get(key)??i;weld.set(key,parent[i]);}
   const count=indices?.getCount()??pos.getCount();for(let i=0;i<count;i+=3){const a=find(indices?.getScalar(i)??i);for(let j=1;j<3;j++)parent[find(indices?.getScalar(i+j)??(i+j))]=a;}
   const groups=new Map<number,{b:Box3;n:number}>();vertices.forEach((v,i)=>{const key=find(i),g=groups.get(key)??{b:new Box3(),n:0};g.b.expandByPoint(v);g.n++;groups.set(key,g);});
   for(const {b,n} of groups.values()){const c=b.getCenter(new Vector3()),s=b.getSize(new Vector3());if(n<40||Math.abs(c.x)>.6||c.y<.4||c.y>1||c.z<.1||c.z>1.15||s.x<.07||s.x>.65||s.y>.6||s.z>.35)continue;rows.push({mat:name,n,min:b.min.toArray().map(v=>+v.toFixed(3)),max:b.max.toArray().map(v=>+v.toFixed(3))});}
  }
 });console.log(JSON.stringify({id,rows}));
}
