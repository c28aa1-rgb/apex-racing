import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { assetUrl } from '../shared/assets';
import type { Simulation } from '../shared/physics';
import { tireStress } from './race-audio';

/** Size of the marshal drone model in the world: about 8 m across its rotors, lamps about 1 m apart. */
const DRONE_SCALE=4.2;
export class StartLight extends THREE.Group {
  private lamps:THREE.MeshStandardMaterial[]=[];
  /** Detailed model only: the inside of each lamp hood (lit with its lamp) and the always-on accent LEDs. */
  private hoods:THREE.MeshStandardMaterial[]=[];private accents:THREE.MeshStandardMaterial[]=[];
  private rotors:THREE.Group[]=[];
  /** Spin of each rotor in radians per second; chosen so blades read as moving rather than strobing at 60 fps. */
  private rotorSpeeds:number[]=[];
  /** Emissive strength of a lit lamp. The detailed model's LED lenses need more than the fallback's. */
  private glow=1;
  /** Lens tint while waiting [red phase, green phase]. The detailed LED lenses stay visibly red when off, like smoked glass. */
  private lensTint:[number,number]=[0x240400,0x062d16];
  /**
   * Replaces the built-in fallback with the detailed marshal drone
   * (public/models/drone/marshal-drone.glb, built by design/build-marshal-drone.ts).
   * Its lenses use materials lamp-0..4 and its rotor-N nodes anchor new spinning blades.
   */
  async load(loader:GLTFLoader) {
    const gltf=await loader.loadAsync(assetUrl('models/drone/marshal-drone.glb'));
    const model=gltf.scene,lamps:THREE.MeshStandardMaterial[]=[],hoods:THREE.MeshStandardMaterial[]=[],accents:THREE.MeshStandardMaterial[]=[];
    model.traverse(object=>{
      if(!(object instanceof THREE.Mesh))return;
      const material=object.material as THREE.MeshStandardMaterial,lamp=/^lamp-(\d)$/.exec(material.name),hood=/^lampglow-(\d)$/.exec(material.name);
      if(lamp){material.toneMapped=false;lamps[Number(lamp[1])]=material;}
      if(hood)hoods[Number(hood[1])]=material;
      if(material.name==='led'&&!accents.includes(material)){material.toneMapped=false;accents.push(material);}
    });
    if(lamps.filter(Boolean).length!==5)throw new Error('Marshal drone model is missing lamp materials.');
    const rotors:THREE.Group[]=[],speeds:number[]=[];
    model.traverse(object=>{
      const match=/^rotor-(\d)$/.exec(object.name);if(!match)return;
      const rotor=buildRotor(Number(object.userData.radius)||.2);object.add(rotor);rotors.push(rotor);speeds.push((Number(match[1])%2?1:-1)*(17+Number(match[1])*1.3));
    });
    // Hang the model by its lamp row so the lights sit where the fallback's did.
    const centre=model.getObjectByName('lamp-centre')?.position.y??-.3;
    model.scale.setScalar(DRONE_SCALE);model.position.y=-centre*DRONE_SCALE;
    for(const child of [...this.children]){this.remove(child);child.traverse(object=>{if(object instanceof THREE.Mesh)object.geometry.dispose();});}
    this.add(model);this.hoods=hoods;this.accents=accents;this.lamps=lamps;this.rotors=rotors;this.rotorSpeeds=speeds;this.glow=1.8;this.lensTint=[0x6a1a12,0x0d4a26];
  }
  constructor() {
    super();this.name='APEX marshal drone';this.visible=false;
    const alloy=new THREE.MeshStandardMaterial({color:0x879da4,metalness:.8,roughness:.28});
    const shell=new THREE.MeshStandardMaterial({color:0x18313c,metalness:.55,roughness:.36});
    const black=new THREE.MeshStandardMaterial({color:0x101a20,roughness:.65});
    const orange=new THREE.MeshStandardMaterial({color:0xff784c,metalness:.25,roughness:.4});
    const add=(geometry:THREE.BufferGeometry,material:THREE.Material,x:number,y:number,z:number,parent:THREE.Object3D=this)=>{const mesh=new THREE.Mesh(geometry,material);mesh.position.set(x,y,z);parent.add(mesh);return mesh;};
    add(new RoundedBoxGeometry(5.9,1.48,.66,3,.12),shell,0,0,0);
    add(new RoundedBoxGeometry(5.66,1.22,.12,3,.06),black,0,0,.38);
    for(const y of [-.61,.61])add(new THREE.BoxGeometry(5.55,.035,.035),alloy,0,y,.45);
    for(let i=0;i<5;i++){
      const x=(i-2)*1.07;
      add(new THREE.CylinderGeometry(.45,.45,.16,40),alloy,x,0,.47).rotation.x=Math.PI/2;
      add(new THREE.CylinderGeometry(.41,.41,.18,40),black,x,0,.52).rotation.x=Math.PI/2;
      const lens=new THREE.MeshStandardMaterial({color:0x360d0b,emissive:0xff1208,emissiveIntensity:0,roughness:.24,metalness:.1,toneMapped:false});this.lamps.push(lens);
      add(new THREE.SphereGeometry(.35,28,18),lens,x,0,.59).scale.z=.25;
      // Individual diode points behind a protective lens.
      for(let row=-3;row<=3;row++)for(let col=-3;col<=3;col++)if(row*row+col*col<12)add(new THREE.SphereGeometry(.022,6,4),lens,x+col*.09,row*.09,.68);
      const hood=add(new THREE.CylinderGeometry(.46,.46,.27,32,1,true,Math.PI/2,Math.PI),shell,x,.02,.60);hood.rotation.x=Math.PI/2;
    }
    for(const x of [-2.73,2.73])for(const y of [-.48,.48])add(new THREE.CylinderGeometry(.04,.04,.03,6),alloy,x,y,.47).rotation.x=Math.PI/2;
    for(const x of [-3.25,3.25])for(const z of [-.85,.85]){
      const arm=add(new THREE.BoxGeometry(1.05,.13,.16),alloy,x*.84,.4,z*.55);arm.rotation.y=-Math.sign(x*z)*.48;
      const ring=add(new THREE.TorusGeometry(.62,.075,10,48),shell,x,.63,z);ring.rotation.x=Math.PI/2;
      add(new THREE.CylinderGeometry(.14,.18,.34,16),alloy,x,.53,z);
      const rotor=new THREE.Group();rotor.position.set(x,.73,z);this.add(rotor);this.rotors.push(rotor);
      for(let blade=0;blade<3;blade++){const pivot=new THREE.Group();pivot.rotation.y=blade*Math.PI*2/3;rotor.add(pivot);const fin=add(new RoundedBoxGeometry(.56,.025,.10,2,.025),black,.27,0,0,pivot);fin.rotation.z=.12;}
      add(new THREE.SphereGeometry(.09,12,8),orange,x,.82,z);
    }
    for(const x of [-2.2,2.2]){add(new THREE.BoxGeometry(.42,.07,.42),alloy,x,-.86,0);add(new THREE.BoxGeometry(.08,.32,.08),alloy,x,-.72,0);}
    for(let i=0;i<14;i++)add(new THREE.BoxGeometry(.18,.12,.07),black,(i-6.5)*.23,.55,-.36);
  }
  /** `sinceStart` is seconds since the lights sequence began; the drone swoops in from above and to one side during the first 1.5 s. */
  update(camera:THREE.Camera,count:number,elapsedSinceGo:number,time:number,reduced:boolean,sinceStart=Infinity) {
    this.visible=count>0||(elapsedSinceGo>=0&&elapsedSinceGo<1.1);if(!this.visible)return;
    const exit=count>0?0:Math.min(1,elapsedSinceGo/1.1);
    const arrive=reduced||count===0?1:Math.max(0,Math.min(1,sinceStart/1.5)),away=Math.pow(1-arrive,3);
    this.position.set(away*-26,3.1+(reduced?0:Math.sin(time*2)*.045)+exit*exit*12+away*30,-20-exit*10-away*55).applyQuaternion(camera.quaternion).add(camera.position);
    this.quaternion.copy(camera.quaternion);this.rotateX(-.055);this.rotateY(away*.5);this.rotateZ(away*-.18);
    this.lamps.forEach((m,i)=>{const lit=count===0||i<6-count;m.color.set(this.lensTint[count===0?1:0]);m.emissive.set(count===0?0x26ff6b:0xff1208);m.emissiveIntensity=lit?this.glow:0;});
    this.hoods.forEach((m,i)=>{const lit=count===0||i<6-count;m.emissive.set(count===0?0x26ff6b:0xff2a14);m.emissiveIntensity=lit?.95:0;});
    // Accent strips breathe gently while waiting, then flash green with the start.
    this.accents.forEach(m=>{m.emissive.set(count===0?0x2bff70:0xff1a0c);m.emissiveIntensity=count===0?2.4:1.5+(reduced?0:Math.sin(time*3)*.35);});
    this.rotors.forEach((rotor,i)=>rotor.rotation.y=reduced?0:time*(this.rotorSpeeds[i]??45*(i%2?1:-1)));
  }
}

/** Three swept carbon blades, a spinner and a faint motion disc, in model units around the rotor axis. */
function buildRotor(radius:number) {
  const rotor=new THREE.Group();rotor.name='marshal-rotor';
  const carbon=new THREE.MeshStandardMaterial({color:0x151c21,roughness:.42,metalness:.35});
  const tip=new THREE.MeshStandardMaterial({color:0x3a3f44,roughness:.35,metalness:.7});
  const blade=new THREE.Shape();
  // Root narrow, widening, then a raked rounded tip.
  blade.moveTo(0,-.012);blade.bezierCurveTo(radius*.35,-.03,radius*.75,-.034,radius*.97,-.016);
  blade.quadraticCurveTo(radius*1.0,0,radius*.95,.02);blade.bezierCurveTo(radius*.7,.026,radius*.3,.02,0,.012);
  const bladeGeometry=new THREE.ExtrudeGeometry(blade,{depth:.004,bevelEnabled:false}).rotateX(Math.PI/2);
  for(let i=0;i<3;i++){
    const pivot=new THREE.Group();pivot.rotation.y=i*Math.PI*2/3;rotor.add(pivot);
    const mesh=new THREE.Mesh(bladeGeometry,carbon);mesh.rotation.x=.16;pivot.add(mesh);
    const end=new THREE.Mesh(new THREE.BoxGeometry(radius*.09,.005,.03),tip);end.position.set(radius*.9,.001,0);end.rotation.x=.16;pivot.add(end);
  }
  const spinner=new THREE.Mesh(new THREE.ConeGeometry(.028,.045,20),new THREE.MeshStandardMaterial({color:0x8a9ba2,roughness:.3,metalness:.85}));spinner.position.y=.02;rotor.add(spinner);
  // Motion disc: barely there, it suggests blades the frame rate cannot show.
  const canvas=document.createElement('canvas');canvas.width=canvas.height=128;const context=canvas.getContext('2d')!;
  const gradient=context.createRadialGradient(64,64,6,64,64,64);gradient.addColorStop(0,'rgba(20,28,33,0)');gradient.addColorStop(.25,'rgba(20,28,33,.5)');gradient.addColorStop(.9,'rgba(20,28,33,.32)');gradient.addColorStop(1,'rgba(20,28,33,0)');
  context.fillStyle=gradient;context.fillRect(0,0,128,128);
  const disc=new THREE.Mesh(new THREE.CircleGeometry(radius,40).rotateX(-Math.PI/2),new THREE.MeshBasicMaterial({map:new THREE.CanvasTexture(canvas),transparent:true,opacity:.42,depthWrite:false,side:THREE.DoubleSide}));
  disc.position.y=.002;rotor.add(disc);
  return rotor;
}

export class SkidMarks {
  private capacity=900;
  private positions=new Float32Array(this.capacity*18);
  private attribute=new THREE.BufferAttribute(this.positions,3).setUsage(THREE.DynamicDrawUsage);
  private geometry=new THREE.BufferGeometry();
  readonly mesh:THREE.Mesh;
  private cursor=0;
  private count=0;
  private last:(THREE.Vector3|undefined)[]=[];
  private lastTick=-1;
  constructor() {
    this.geometry.setAttribute('position',this.attribute);
    this.geometry.setDrawRange(0,0);
    this.mesh=new THREE.Mesh(this.geometry,new THREE.MeshBasicMaterial({color:0x000000,transparent:true,opacity:.82,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2,side:THREE.DoubleSide,toneMapped:false}));
    this.mesh.frustumCulled=false;this.mesh.name='Tire rubber';
  }
  clear(){this.count=this.cursor=0;this.last=[];this.lastTick=-1;this.geometry.setDrawRange(0,0);}
  update(sim:Simulation,enabled:boolean) {
    this.mesh.visible=enabled;if(!enabled){this.last=[];return;}
    if(sim.ticks===this.lastTick)return;this.lastTick=sim.ticks;
    const stress=tireStress(sim);if(stress<.09){this.last=[];return;}
    let written=false;
    for(let wheel=0;wheel<4;wheel++){
      if(wheel<2&&sim.brake<.35&&stress<.35){this.last[wheel]=undefined;continue;}
      if(!sim.vehicle.wheelIsInContact(wheel)){this.last[wheel]=undefined;continue;}
      const contact=sim.vehicle.wheelContactPoint(wheel);if(!contact)continue;
      const point=new THREE.Vector3(contact.x,contact.y,contact.z);
      const floor=sim.visibleGroundAt(point);if(floor===undefined){this.last[wheel]=undefined;continue;}point.y=floor+.018;
      const previous=this.last[wheel];if(!previous){this.last[wheel]=point;continue;}
      const distance=point.distanceTo(previous);if(distance<.18)continue;
      this.last[wheel]=point;if(distance>5)continue;
      const normal=sim.vehicle.wheelContactNormal(wheel),up=new THREE.Vector3(normal?.x??0,normal?.y??1,normal?.z??0);
      const edge=new THREE.Vector3().subVectors(point,previous).cross(up).normalize().multiplyScalar(sim.carSpec.id==='red-bull-rb19'?.17:.12);
      const a=previous.clone().add(edge),b=previous.clone().sub(edge),c=point.clone().add(edge),d=point.clone().sub(edge);
      this.positions.set([...a,...b,...c,...b,...d,...c],this.cursor*18);
      this.attribute.addUpdateRange(this.cursor*18,18);written=true;
      this.cursor=(this.cursor+1)%this.capacity;this.count=Math.min(this.count+1,this.capacity);
    }
    if(written){this.attribute.needsUpdate=true;this.geometry.setDrawRange(0,this.count*6);}
  }
}

export class FinishConfetti {
  private readonly count=72;
  private readonly positions:THREE.Vector3[]=[];
  private readonly velocities:THREE.Vector3[]=[];
  private readonly rotations:THREE.Euler[]=[];
  private readonly spins:THREE.Vector3[]=[];
  private elapsed=0;
  private matrix=new THREE.Matrix4();
  private quaternion=new THREE.Quaternion();
  private scale=new THREE.Vector3(1,1,1);
  readonly mesh:THREE.InstancedMesh;
  constructor() {
    const material=new THREE.MeshBasicMaterial({side:THREE.DoubleSide,transparent:true,depthWrite:false,toneMapped:false});
    material.forceSinglePass=true;
    this.mesh=new THREE.InstancedMesh(new THREE.PlaneGeometry(.18,.34),material,this.count);
    this.mesh.name='Finish confetti';this.mesh.frustumCulled=false;this.mesh.renderOrder=30;this.mesh.visible=false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const colors=[0xff784c,0xf1faee,0x132b3b,0x45c8bd,0x111111];
    for(let i=0;i<this.count;i++){
      this.mesh.setColorAt(i,new THREE.Color(colors[i%colors.length]));
      this.positions.push(new THREE.Vector3());this.velocities.push(new THREE.Vector3());this.rotations.push(new THREE.Euler());this.spins.push(new THREE.Vector3());
    }
    if(this.mesh.instanceColor)this.mesh.instanceColor.needsUpdate=true;
  }
  burst(origin:THREE.Vector3,orientation:THREE.Quaternion,reduced:boolean) {
    this.clear();if(reduced)return;
    this.mesh.visible=true;this.elapsed=0;
    let seed=314159;
    const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
    for(let i=0;i<this.count;i++){
      this.positions[i].set((random()-.5)*11,2+random()*4,(random()-.5)*5).applyQuaternion(orientation).add(origin);
      this.velocities[i].set((random()-.5)*7,3+random()*7,(random()-.5)*5).applyQuaternion(orientation);
      this.rotations[i].set(random()*Math.PI,random()*Math.PI,random()*Math.PI);
      this.spins[i].set((random()-.5)*9,(random()-.5)*11,(random()-.5)*8);
    }
    this.writeMatrices();
  }
  update(dt:number) {
    if(!this.mesh.visible)return;
    this.elapsed+=dt;if(this.elapsed>4){this.clear();return;}
    for(let i=0;i<this.count;i++){
      this.velocities[i].y-=8.5*dt;this.positions[i].addScaledVector(this.velocities[i],dt);
      const rotation=this.rotations[i],spin=this.spins[i];rotation.x+=spin.x*dt;rotation.y+=spin.y*dt;rotation.z+=spin.z*dt;
    }
    (this.mesh.material as THREE.MeshBasicMaterial).opacity=THREE.MathUtils.clamp((4-this.elapsed)/1.2,0,1);
    this.writeMatrices();
  }
  clear() {
    this.mesh.visible=false;
    (this.mesh.material as THREE.MeshBasicMaterial).opacity=1;
  }
  private writeMatrices() {
    for(let i=0;i<this.positions.length;i++){this.quaternion.setFromEuler(this.rotations[i]);this.matrix.compose(this.positions[i],this.quaternion,this.scale);this.mesh.setMatrixAt(i,this.matrix);}
    this.mesh.instanceMatrix.needsUpdate=true;
  }
}
