import * as THREE from 'three';
import { deinterleaveGeometry, mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { CarDefinition, CarId } from '../shared/cars';
import { CockpitInstruments } from './cockpit';

type Part = { geometry: THREE.BufferGeometry; material: THREE.Material; name: string };
type Region = { min: [number,number,number]; max: [number,number,number] };
// Audited in the supplied GLBs, in their source coordinates converted to metres.
// These four exporters merge the steering wheel into the interior material.
const cockpitRegions: Partial<Record<CarId, Region>> = {
  'mclaren-720s-gt3': { min:[.12,.61,.32], max:[.435,.785,.45] },
  'bugatti-bolide': { min:[.255,.485,.28], max:[.58,.705,.43] },
  'porsche-963': { min:[.02,.54,.63], max:[.31,.73,.705] },
  'skyline-r34': { min:[-.545,.66,.265], max:[-.175,.992,.44] },
};
const steeringObjects: Partial<Record<CarId, number[]>> = {
  'porsche-911-gt3': [100,102,104,106,108,110,112,114,116,118,120,122,124],
  'celica-gt4': [298,301,303,305,307,309,311],
  'mazda-787b': [270,274,344,348],
};

/** Split actual triangles while retaining UVs, normals, colors and tangents. */
function partition(part: Part, classify: (a:THREE.Vector3,b:THREE.Vector3,c:THREE.Vector3,triangle:number)=>string) {
  const geometry=part.geometry,position=geometry.getAttribute('position'),index=geometry.getIndex();
  const count=index?.count??position.count,groups=new Map<string,number[]>();
  const a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3();
  for(let i=0;i<count;i+=3){
    const ia=index?.getX(i)??i,ib=index?.getX(i+1)??i+1,ic=index?.getX(i+2)??i+2;
    const key=classify(a.fromBufferAttribute(position,ia),b.fromBufferAttribute(position,ib),c.fromBufferAttribute(position,ic),i/3);
    const indices=groups.get(key)??[];indices.push(ia,ib,ic);groups.set(key,indices);
  }
  if(groups.size===1)return new Map([[groups.keys().next().value!,part]]);
  const result=new Map<string,Part>();
  for(const [key,indices] of groups){
    const remap=new Map<number,number>(),vertices:number[]=[],newIndices=indices.map(old=>{
      let next=remap.get(old);if(next===undefined){next=vertices.length;vertices.push(old);remap.set(old,next);}return next;
    });
    const split=new THREE.BufferGeometry();
    for(const [name,attribute] of Object.entries(geometry.attributes)){
      const values=new Float32Array(vertices.length*attribute.itemSize);
      vertices.forEach((old,i)=>{for(let j=0;j<attribute.itemSize;j++)values[i*attribute.itemSize+j]=attribute.getComponent(old,j);});
      split.setAttribute(name,new THREE.BufferAttribute(values,attribute.itemSize));
    }
    split.setIndex(newIndices);result.set(key,{...part,geometry:split});
  }
  geometry.dispose();return result;
}

function batch(parts: Part[], target: THREE.Group) {
  const batches=new Map<string,Part[]>();
  for(const part of parts){
    const key=`${part.material.uuid}|${Object.keys(part.geometry.attributes).sort()}|${!!part.geometry.index}`;
    const group=batches.get(key)??[];group.push(part);batches.set(key,group);
  }
  for(const parts of batches.values()){
    const geometries=parts.map(p=>p.geometry);
    // Rebuilt and loaded parts can disagree on interleaving or the GPU type tag of
    // identical float data; mergeGeometries then refuses and every part costs a draw call.
    if(geometries.length>1)for(const geometry of geometries){
      if(Object.values(geometry.attributes).some(attribute=>(attribute as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute))deinterleaveGeometry(geometry);
      for(const attribute of Object.values(geometry.attributes))if(attribute instanceof THREE.BufferAttribute&&attribute.array instanceof Float32Array)attribute.gpuType=THREE.FloatType;
    }
    const merged=geometries.length===1?geometries[0]:mergeGeometries(geometries,false);
    if(merged){const mesh=new THREE.Mesh(merged,parts[0].material);mesh.name=parts[0].name;target.add(mesh);if(geometries.length>1)geometries.forEach(g=>g.dispose());}
    else parts.forEach(p=>target.add(new THREE.Mesh(p.geometry,p.material)));
  }
}

// RB19 export bakes every material into seven unnamed meshes. Classify whole
// welded islands, not individual triangles, so suspension and wings stay intact.
function separateRB19(part:Part) {
  const p=part.geometry.getAttribute('position'),index=part.geometry.index,parent=new Int32Array(p.count),vertices=new Map<string,number>(),point=new THREE.Vector3();
  for(let i=0;i<p.count;i++){const key=`${Math.round(p.getX(i)*1e5)},${Math.round(p.getY(i)*1e5)},${Math.round(p.getZ(i)*1e5)}`;parent[i]=vertices.get(key)??i;if(!vertices.has(key))vertices.set(key,i);}
  const root=(i:number)=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;};
  const count=index?.count??p.count;
  for(let i=0;i<count;i+=3){const a=root(index?.getX(i)??i),b=root(index?.getX(i+1)??i+1),c=root(index?.getX(i+2)??i+2);parent[b]=a;parent[c]=a;}
  const bounds=new Map<number,THREE.Box3>();
  for(let i=0;i<p.count;i++){const id=root(i),box=bounds.get(id)??new THREE.Box3();box.expandByPoint(point.fromBufferAttribute(p,i));bounds.set(id,box);}
  const regions=[
    new THREE.Box3(new THREE.Vector3(-.695,-.005,-1.272),new THREE.Vector3(-.378,.512,-.756)),
    new THREE.Box3(new THREE.Vector3(.378,-.005,-1.272),new THREE.Vector3(.695,.512,-.756)),
    new THREE.Box3(new THREE.Vector3(-.685,-.005,1.124),new THREE.Vector3(-.397,.506,1.631)),
    new THREE.Box3(new THREE.Vector3(.397,-.005,1.124),new THREE.Vector3(.685,.506,1.631)),
    new THREE.Box3(new THREE.Vector3(-.074,.39,.710),new THREE.Vector3(.074,.479,.733)),
  ];
  const names=new Map([...bounds].map(([id,box])=>{const region=regions.findIndex(r=>r.containsBox(box));return [id,region<0?'body':region===4?'steering':'wheel'];}));
  return [...partition(part,(_a,_b,_c,t)=>names.get(root(index?.getX(t*3)??t*3))!).entries()].map(([name,p])=>({...p,name:`${p.name} ${name}`}));
}

/** Build a metre-scale rig once per car; preserve the original assets on disk. */
export function prepareCarModel(scene: THREE.Object3D, definition: CarDefinition, cinematic=false) {
  scene.updateMatrixWorld(true);
  const parts:Part[]=[],sourceBounds=new THREE.Box3();
  scene.traverse(object=>{
    const source=object as THREE.Mesh;
    if(!source.isMesh||(source as THREE.SkinnedMesh).isSkinnedMesh)return;
    for(let ancestor:THREE.Object3D|null=source;ancestor;ancestor=ancestor.parent)if(!ancestor.visible)return;
    const materials=Array.isArray(source.material)?source.material:[source.material];
    for(let i=0;i<materials.length;i++){
      const material=materials[i],name=`${source.name} ${material.name}`;
      // The source has both sharp and pre-blurred rims occupying the same space.
      if(/rim.*blur/i.test(name))continue;
      let geometry=source.geometry.clone().applyMatrix4(source.matrixWorld);
      if(materials.length>1){
        // GLTFLoader normally gives each primitive its own material/mesh.
        const selected=partition({geometry,material,name},(_a,_b,_c,triangle)=>source.geometry.groups.some(g=>g.materialIndex===i&&triangle*3>=g.start&&triangle*3<g.start+g.count)?'include':'exclude');
        selected.get('exclude')?.geometry.dispose();
        if(!selected.has('include'))continue;geometry=selected.get('include')!.geometry;geometry.clearGroups();
      }
      geometry.computeBoundingBox();sourceBounds.union(geometry.boundingBox!);parts.push({geometry,material,name});
    }
  });
  const size=sourceBounds.getSize(new THREE.Vector3()),rotateXLength=size.x>size.z*1.15;
  const rotation=new THREE.Matrix4().makeRotationY(rotateXLength?Math.PI/2:0);
  const bounds=sourceBounds.clone().applyMatrix4(rotation),scale=definition.dimensions.lengthM/(bounds.max.z-bounds.min.z);
  const wheelContact=.58+definition.dimensions.wheelRadiusM;
  const translate=new THREE.Vector3(-(bounds.min.x+bounds.max.x)*scale/2,-wheelContact-bounds.min.y*scale,-(bounds.min.z+bounds.max.z)*scale/2);
  const transform=new THREE.Matrix4().makeTranslation(translate.x,translate.y,translate.z).multiply(new THREE.Matrix4().makeScale(scale,scale,scale)).multiply(rotation);
  const body:Part[]=[],steering:Part[]=[],lamps:Part[]=[],headlamps:Part[]=[],wheels=[0,1,2,3].map(()=>[] as Part[]),calipers=[0,1,2,3].map(()=>[] as Part[]);
  let legacyEye:THREE.Vector3|undefined;
  const region=cockpitRegions[definition.id],sourceToMetres=size.z<.1?100:1;
  const regionBox=region?new THREE.Box3(new THREE.Vector3(...region.min).multiplyScalar(1/sourceToMetres),new THREE.Vector3(...region.max).multiplyScalar(1/sourceToMetres)).applyMatrix4(transform):undefined;
  const corner=(v:THREE.Vector3)=>(v.z>=0?0:2)+(v.x>=0?1:0);
  if(definition.id==='red-bull-rb19'){const separated=parts.flatMap(separateRB19);parts.splice(0,parts.length,...separated);}
  for(const part of parts){
    part.geometry.applyMatrix4(transform);
    if(!legacyEye&&/(?:steer.*wheel|wheel.*steer)/i.test(part.name)){
      part.geometry.computeBoundingBox();legacyEye=part.geometry.boundingBox!.getCenter(new THREE.Vector3()).add(new THREE.Vector3(0,.2,-.38));
    }
    const objectNumber=Number(/Object_(\d+)/.exec(part.name)?.[1]);
    if(/steer/i.test(part.name)||steeringObjects[definition.id]?.includes(objectNumber)){steering.push(part);continue;}
    const isCaliper=/cali?l?iper/i.test(part.name);
    if(isCaliper||/wheel|tyre|tire|rim|brakedisc|rotor|EXT_Disc|\bDiscs\b/i.test(part.name)){
      for(const [index,p] of partition(part,(a,b,c)=>String(corner(a.clone().add(b).add(c).multiplyScalar(1/3))))) (isCaliper?calipers:wheels)[Number(index)].push(p);
      continue;
    }
    let remaining:Part|undefined=part;
    if(regionBox&&/interior|carbon|textured|coloured|emis/i.test(part.name)){
      const split=partition(part,(a,b,c)=>regionBox.containsPoint(a)&&regionBox.containsPoint(b)&&regionBox.containsPoint(c)?'steer':'body');
      if(split.has('steer'))steering.push(split.get('steer')!);remaining=split.get('body');
    }
    if(!remaining)continue;
    if(/light|lamp|Glass_Emiss|red_glass/i.test(remaining.name)&&!/chrome|case|pod/i.test(remaining.name)){
      const split=partition(remaining,(a,b,c)=>Math.max(a.z,b.z,c.z)<-definition.dimensions.lengthM*.27?'lamp':cinematic&&Math.min(a.z,b.z,c.z)>definition.dimensions.lengthM*.27?'headlamp':'body');
      if(split.has('lamp'))lamps.push(split.get('lamp')!);
      if(split.has('headlamp'))headlamps.push(split.get('headlamp')!);
      remaining=split.get('body');
    }
    if(remaining)body.push(remaining);
  }
  const prepared=new THREE.Group();prepared.name=`apex-rig-${definition.id}`;batch(body,prepared);
  wheels.forEach((parts,index)=>{
    if(!parts.length)return;
    const bounds=new THREE.Box3(),tireBounds=new THREE.Box3();
    for(const p of parts){p.geometry.computeBoundingBox();bounds.union(p.geometry.boundingBox!);if(/tire|tyre/i.test(p.name))tireBounds.union(p.geometry.boundingBox!);}
    const axleBounds=tireBounds.isEmpty()?bounds:tireBounds,center=axleBounds.getCenter(new THREE.Vector3());
    const radius=(axleBounds.max.y-axleBounds.min.y)/2;
    const pivot=new THREE.Group(),spin=new THREE.Group();pivot.name=`apex-wheel-${index}`;spin.name='apex-wheel-spin';
    pivot.position.copy(center);pivot.userData={index,radius,rest:center.toArray()};
    for(const p of [...parts,...calipers[index]])p.geometry.translate(-center.x,-center.y,-center.z);
    batch(parts,spin);batch(calipers[index],pivot);pivot.add(spin);prepared.add(pivot);
  });
  if(steering.length){
    const bounds=new THREE.Box3();steering.forEach(p=>{p.geometry.computeBoundingBox();bounds.union(p.geometry.boundingBox!);});
    const center=bounds.getCenter(new THREE.Vector3()),pivot=new THREE.Group();pivot.name='apex-steering-wheel';pivot.position.copy(center);
    // Fit the authored wheel's tilt so it rotates around its column, not the dash.
    let yy=0,yz=0;for(const p of steering){const positions=p.geometry.getAttribute('position');for(let i=0;i<positions.count;i++){const y=positions.getY(i)-center.y,z=positions.getZ(i)-center.z;yy+=y*y;yz+=y*z;}p.geometry.translate(-center.x,-center.y,-center.z);}
    pivot.userData.axis=new THREE.Vector3(0,-THREE.MathUtils.clamp(yz/Math.max(yy,1e-6),-.7,.7),1).normalize().toArray();
    batch(steering,pivot);prepared.add(pivot);prepared.userData.cockpitEye={x:center.x,y:center.y+.2,z:center.z-.38};
    if(definition.id==='red-bull-rb19')prepared.userData.cockpitEye={x:center.x,y:center.y+.14,z:center.z-.48};
  }
  // Clone only the actual rear-light materials. Headlights and body paint retain
  // their original materials, even where the exporter shared a texture atlas.
  const lampMaterials=new Map<THREE.Material,THREE.Material>();
  for(const part of lamps){
    let material=lampMaterials.get(part.material);
    if(!material){
      material=part.material.clone();
      if(material instanceof THREE.MeshStandardMaterial){
        material.emissive.set(0xff1808);material.emissiveMap=material.map;material.emissiveIntensity=.12;
        material.userData.apexBrakeLamp=true;
      }
      lampMaterials.set(part.material,material);
    }
    part.material=material;part.name='apex-rear-lamp';
  }
  const dimensions=definition.dimensions;
  const headMaterials=new Map<THREE.Material,THREE.Material>();
  for(const part of headlamps){
    let next=headMaterials.get(part.material);
    if(!next){next=part.material.clone();next.userData.apexHeadlamp=true;headMaterials.set(part.material,next);}
    part.material=next;part.name='apex-front-lamp';
  }
  batch(headlamps,prepared);
  const oldEye=legacyEye??new THREE.Vector3(dimensions.bodyWidthM*.21,-wheelContact+dimensions.heightM*.78,-dimensions.wheelbaseM*.1);
  prepared.userData.legacyCockpitEye={x:oldEye.x,y:oldEye.y,z:oldEye.z};
  batch(lamps,prepared);prepared.updateMatrixWorld(true);return prepared;
}

export class CarRig {
  instruments:CockpitInstruments;
  wheels:THREE.Group[]=[];
  steeringWheel?:THREE.Object3D;
  private steeringAxis=new THREE.Vector3(0,0,1);
  private lamps=new Set<THREE.MeshStandardMaterial>();
  private headlights=new Map<THREE.MeshStandardMaterial,{color:THREE.Color;intensity:number}>();
  constructor(public root:THREE.Object3D,definition:CarDefinition){
    this.instruments=new CockpitInstruments(root,definition);
    const cloned=new Map<THREE.Material,THREE.Material>();
    root.traverse(object=>{
      if(/^apex-wheel-[0-3]$/.test(object.name))this.wheels.push(object as THREE.Group);
      if(object.name==='apex-steering-wheel'){this.steeringWheel=object;this.steeringAxis.fromArray(object.userData.axis);}
      const mesh=object as THREE.Mesh;if(!mesh.isMesh)return;
      const local=(source:THREE.Material)=>{
        if(!source.userData.apexBrakeLamp&&!source.userData.apexHeadlamp)return source;
        let material=cloned.get(source) as THREE.MeshStandardMaterial|undefined;
        if(!material){
          material=source.clone() as THREE.MeshStandardMaterial;cloned.set(source,material);
          if(material instanceof THREE.MeshStandardMaterial){
            if(source.userData.apexHeadlamp)this.headlights.set(material,{color:material.emissive.clone(),intensity:material.emissiveIntensity});
            else this.lamps.add(material);
          }
        }return material;
      };
      mesh.material=Array.isArray(mesh.material)?mesh.material.map(local):local(mesh.material);
    });
    this.wheels.sort((a,b)=>a.userData.index-b.userData.index);
  }
  animate(steering:number,distance:number,brake:number,maxWheelTravel=.045){
    for(const wheel of this.wheels){
      // The imported wheel arches are static, not a long-travel suspension rig.
      // Keep tires attached even during airborne recovery or stale render state.
      const travel=Math.min(maxWheelTravel,wheel.userData.radius*.6),rest=wheel.userData.rest[1];
      wheel.position.y=THREE.MathUtils.clamp(wheel.position.y,rest-travel,rest+travel);
      wheel.rotation.y=wheel.userData.index<2?steering:0;
      const spin=wheel.getObjectByName('apex-wheel-spin');
      if(spin)spin.rotation.x=THREE.MathUtils.euclideanModulo(spin.rotation.x+distance/wheel.userData.radius,Math.PI*2);
    }
    this.steeringWheel?.quaternion.setFromAxisAngle(this.steeringAxis,-steering*(this.steeringWheel.userData.steeringRatio??12));
    this.lamps.forEach(material=>{material.emissiveIntensity=.12+THREE.MathUtils.clamp(brake*4,0,1)*3.2;});
  }
  setHeadlights(enabled:boolean){this.headlights.forEach((original,material)=>{material.emissive.copy(enabled?new THREE.Color(0xdceeff):original.color);material.emissiveIntensity=enabled?2:original.intensity;});}
  dispose(){this.instruments.dispose();this.lamps.forEach(material=>material.dispose());this.headlights.forEach((_,material)=>material.dispose());}
}
