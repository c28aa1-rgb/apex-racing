import {NodeIO} from '@gltf-transform/core';
import {Vector3,Matrix4,Box3} from 'three';
const doc=await new NodeIO().read('public/models/cars/oracle_red_bull_f1_car_rb19_2023.glb');
for(const node of doc.getRoot().listNodes())for(const p of node.getMesh()?.listPrimitives()??[]){
  const a=p.getAttribute('POSITION'),indices=p.getIndices()?.getArray(),points=[],ids=new Map(),parent=[];
  const matrix=new Matrix4().fromArray(node.getWorldMatrix());
  for(let i=0;i<a.getCount();i++){const v=new Vector3().fromArray(a.getArray(),i*3).applyMatrix4(matrix);points.push(v);const key=v.toArray().map(x=>Math.round(x*1e5)).join(',');if(!ids.has(key)){ids.set(key,i);parent[i]=i;}else parent[i]=ids.get(key);}
  const root=i=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;};
  for(let i=0;i<(indices?.length??points.length);i+=3){const a=root(indices?.[i]??i),b=root(indices?.[i+1]??i+1),c=root(indices?.[i+2]??i+2);parent[b]=a;parent[c]=a;}
  const groups=new Map();points.forEach((v,i)=>{const r=root(i);if(!groups.has(r))groups.set(r,{count:0,b:new Box3()});const g=groups.get(r);g.count++;g.b.expandByPoint(v);});
  console.log(node.getName(),[...groups.values()].filter(g=>g.count>150).map(g=>({n:g.count,min:g.b.min.toArray().map(x=>+x.toFixed(3)),max:g.b.max.toArray().map(x=>+x.toFixed(3))})));
}
