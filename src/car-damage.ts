import * as THREE from 'three';
import type { Simulation } from '../shared/physics';

type Vec3={x:number;y:number;z:number};
/** One crumple in the bodywork, in car-local metres. `push` is the unit direction the panel moves (into the car). */
export type Dent={centre:Vec3;push:Vec3;radius:number;depth:number};
export const MAX_DENTS=4;
const MAX_DEPTH=.15,MAX_RADIUS=.75;

/** How much one impact hurts, 0..1: a 6 m/s bump is light, about 24 m/s is a wreck. Car contact is a little softer than concrete. */
export function hitSeverity(speedChange:number,withCar:boolean){return Math.min(1,Math.max(0,(speedChange-2)/22))*(withCar?.8:1);}

/**
 * Pure damage bookkeeping, kept free of three.js so it can be tested headless.
 * Nothing here reads back into the simulation: damage is cosmetic only.
 */
export class DamageState {
  /** Overall wear, 0 (fresh) to 1 (smoking wreck). */
  damage=0;
  dents:Dent[]=[];
  /** Paint worn off along each flank by wall scrapes, 0..1: [-x side (the car's right), +x side (its left)]. */
  scrape:[number,number]=[0,0];
  private next=0;
  reset(){this.damage=0;this.dents=[];this.scrape=[0,0];this.next=0;}
  /**
   * Records a hit at `centre` on the body surface. `push` points into the car.
   * Hits close to an existing dent deepen it rather than using another slot; with all slots used the oldest is replaced.
   * Returns the severity applied.
   */
  hit(centre:Vec3,push:Vec3,severity:number){
    if(severity<=0)return 0;
    this.damage=Math.min(1,this.damage+severity*.55);
    if(severity<.1)return severity;
    const radius=.22+.4*severity,depth=.025+.085*severity;
    const near=this.dents.find(d=>Math.hypot(d.centre.x-centre.x,d.centre.y-centre.y,d.centre.z-centre.z)<d.radius*.6);
    if(near){near.depth=Math.min(MAX_DEPTH,near.depth+depth*.6);near.radius=Math.min(MAX_RADIUS,Math.max(near.radius,radius)*1.08);return severity;}
    const dent={centre:{...centre},push:{...push},radius,depth};
    if(this.dents.length<MAX_DENTS)this.dents.push(dent);
    else{this.dents[this.next]=dent;this.next=(this.next+1)%MAX_DENTS;}
    return severity;
  }
  /** Sustained wall contact at `speed` m/s on one side (sign of car-local x: -1 right, +1 left) for `dt` seconds. */
  rub(side:number,speed:number,dt:number){
    if(speed<4)return;
    const i=side<0?0:1,rate=Math.min(1,speed/30);
    this.scrape[i]=Math.min(1,this.scrape[i]+dt*.35*rate);
    this.damage=Math.min(1,this.damage+dt*.02*rate);
  }
}

const makeUniforms=()=>({
  uDent:{value:Array.from({length:MAX_DENTS},()=>new THREE.Vector4())},
  uDentPush:{value:Array.from({length:MAX_DENTS},()=>new THREE.Vector4())},
  uDamage:{value:0},
  /** x, y: left and right scrape wear; z, w: the x positions where each flank's outer quarter begins. */
  uScrape:{value:new THREE.Vector4()},
});
type Uniforms=ReturnType<typeof makeUniforms>;

const VERTEX_HEAD=`
uniform vec4 uDent[${MAX_DENTS}];
uniform vec4 uDentPush[${MAX_DENTS}];
varying vec3 vRestPos;
`;
// Crumple: pull vertices near each impact inward with a smooth falloff, roughened a little so panels buckle rather than sag.
// Only dense meshes change silhouette; the fragment stage shades the dent on every panel, however few vertices it has.
const VERTEX_BODY=`
#include <begin_vertex>
vRestPos=transformed;
for(int i=0;i<${MAX_DENTS};i++){
  float r=uDent[i].w;
  if(r>0.){
    float f=1.-smoothstep(0.,r,distance(transformed,uDent[i].xyz));
    f*=f*(.72+.28*sin(dot(vRestPos,vec3(37.,23.,29.))));
    transformed+=uDentPush[i].xyz*uDentPush[i].w*f;
  }
}
`;
const FRAGMENT_HEAD=`
uniform vec4 uDent[${MAX_DENTS}];
uniform vec4 uDentPush[${MAX_DENTS}];
uniform float uDamage;
uniform vec4 uScrape;
varying vec3 vRestPos;
float apexHash(vec3 p){p=fract(p*.3183099+.1);p*=17.;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
float apexNoise(vec3 x){
  vec3 i=floor(x),f=fract(x);f=f*f*(3.-2.*f);
  return mix(mix(mix(apexHash(i),apexHash(i+vec3(1,0,0)),f.x),mix(apexHash(i+vec3(0,1,0)),apexHash(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(apexHash(i+vec3(0,0,1)),apexHash(i+vec3(1,0,1)),f.x),mix(apexHash(i+vec3(0,1,1)),apexHash(i+vec3(1,1,1)),f.x),f.y),f.z);
}
`;
// Per pixel: how close to a dent (influence) and how deep the crumpled surface sits (height, metres, negative).
// Paint: bare metal where panels crumpled, horizontal scratch streaks on scraped flanks, and grime that builds with overall wear.
const FRAGMENT_COLOR=`
#include <color_fragment>
float apexInfluence=0.,apexHeight=0.;
float apexCrumple=apexNoise(vRestPos*13.);
for(int i=0;i<${MAX_DENTS};i++){
  float r=uDent[i].w;
  if(r>0.){
    float f=1.-smoothstep(0.,r,distance(vRestPos,uDent[i].xyz));f*=f;
    apexInfluence=max(apexInfluence,f);apexHeight-=uDentPush[i].w*f*(.6+.8*apexCrumple);
  }
}
float apexGrain=apexNoise(vRestPos*38.);
float apexScuff=smoothstep(.22,.5,apexInfluence*(.35+.9*apexNoise(vRestPos*7.)));
#ifdef APEX_SCUFF
  float apexSide=vRestPos.x<uScrape.z?uScrape.x:(vRestPos.x>uScrape.w?uScrape.y:0.);
  float apexStreak=apexNoise(vec3(vRestPos.y*90.,vRestPos.z*1.4,vRestPos.x*2.));
  float apexScratch=apexSide*smoothstep(1.-apexSide*.4,1.04-apexSide*.4,apexStreak);
  vec3 apexBare=mix(vec3(.38,.39,.41),vec3(.74,.75,.77),apexGrain);
  diffuseColor.rgb=mix(diffuseColor.rgb,apexBare,max(apexScuff*.8,apexScratch*.75));
  diffuseColor.rgb=mix(diffuseColor.rgb,diffuseColor.rgb*vec3(.5,.45,.4),uDamage*.5*smoothstep(.35,.8,apexNoise(vRestPos*4.)));
#endif
diffuseColor.rgb*=1.-apexInfluence*.18;
`;
const FRAGMENT_ROUGHNESS=`
#include <roughnessmap_fragment>
roughnessFactor=mix(roughnessFactor,.8,apexScuff);
`;
// Bump the shading normal by the dent height (three's own bump-map derivation), exaggerated so shallow crumples catch the light.
const FRAGMENT_NORMAL=`
#include <normal_fragment_maps>
{
  vec3 apexSX=dFdx(-vViewPosition),apexSY=dFdy(-vViewPosition);
  vec2 apexDH=vec2(dFdx(apexHeight),dFdy(apexHeight))*4.;
  vec3 apexR1=cross(apexSY,normal),apexR2=cross(normal,apexSX);
  float apexDet=dot(apexSX,apexR1)*faceDirection;
  if(apexInfluence>0.)normal=normalize(abs(apexDet)*normal-sign(apexDet)*(apexDH.x*apexR1+apexDH.y*apexR2));
}
`;

/** Adds dents (and, for opaque paint, scuffs) to a cloned body material. */
function patchMaterial(material:THREE.Material,uniforms:Uniforms){
  const scuff=!material.transparent;
  const withDefines=material as THREE.Material&{defines?:Record<string,string>};
  if(scuff)withDefines.defines={...withDefines.defines,APEX_SCUFF:''};
  material.onBeforeCompile=shader=>{
    Object.assign(shader.uniforms,uniforms);
    shader.vertexShader=VERTEX_HEAD+shader.vertexShader.replace('#include <begin_vertex>',VERTEX_BODY);
    shader.fragmentShader=FRAGMENT_HEAD+shader.fragmentShader.replace('#include <color_fragment>',FRAGMENT_COLOR).replace('#include <roughnessmap_fragment>',FRAGMENT_ROUGHNESS).replace('#include <normal_fragment_maps>',FRAGMENT_NORMAL);
  };
  material.customProgramCacheKey=()=>`apex-damage-${scuff}`;
  material.needsUpdate=true;
}

/** Mean colour of a texture, read from an 8×8 downscale; undefined when the image cannot be drawn. */
function averageTexture(texture:THREE.Texture){
  try{
    const image=texture.image as CanvasImageSource|undefined;if(!image)return;
    const canvas=document.createElement('canvas');canvas.width=canvas.height=8;
    const c=canvas.getContext('2d',{willReadFrequently:true});if(!c)return;
    c.drawImage(image,0,0,8,8);const data=c.getImageData(0,0,8,8).data;let r=0,g=0,b=0;
    for(let i=0;i<data.length;i+=4){r+=data[i];g+=data[i+1];b+=data[i+2];}
    return new THREE.Color().setRGB(r/64/255,g/64/255,b/64/255,THREE.SRGBColorSpace);
  }catch{return;}
}

const SMOKE=110,SPARKS=90,DEBRIS=24;
const POINT_VERTEX=`
attribute float aSize;
attribute vec4 aColor;
uniform float uHalfHeight;
varying vec4 vColor;
void main(){
  vec4 mv=modelViewMatrix*vec4(position,1.);
  gl_Position=projectionMatrix*mv;
  gl_PointSize=aSize*projectionMatrix[1][1]*uHalfHeight/max(.1,-mv.z);
  vColor=aColor;
}`;
const POINT_FRAGMENT=`
uniform float uHardness;
varying vec4 vColor;
void main(){
  float d=length(gl_PointCoord-.5)*2.;
  float a=1.-smoothstep(uHardness,1.,d);
  if(a*vColor.a<.004)discard;
  gl_FragColor=vec4(vColor.rgb,vColor.a*a);
}`;

/** A fixed pool of camera-facing particles: one draw call, no allocations per frame. */
class ParticlePool {
  readonly points:THREE.Points;
  private position:Float32Array;private velocity:Float32Array;private color:Float32Array;private size:Float32Array;
  private life:Float32Array;private span:Float32Array;private grow:Float32Array;private alpha:Float32Array;
  private geometry=new THREE.BufferGeometry();
  private cursor=0;
  constructor(private capacity:number,additive:boolean,private gravity:number,private drag:number){
    this.position=new Float32Array(capacity*3);this.velocity=new Float32Array(capacity*3);
    this.color=new Float32Array(capacity*4);this.size=new Float32Array(capacity);
    this.life=new Float32Array(capacity);this.span=new Float32Array(capacity).fill(1);this.grow=new Float32Array(capacity*2);this.alpha=new Float32Array(capacity);
    this.geometry.setAttribute('position',new THREE.BufferAttribute(this.position,3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('aColor',new THREE.BufferAttribute(this.color,4).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('aSize',new THREE.BufferAttribute(this.size,1).setUsage(THREE.DynamicDrawUsage));
    const halfHeight={value:400};
    const material=new THREE.ShaderMaterial({vertexShader:POINT_VERTEX,fragmentShader:POINT_FRAGMENT,transparent:true,depthWrite:false,
      blending:additive?THREE.AdditiveBlending:THREE.NormalBlending,uniforms:{uHalfHeight:halfHeight,uHardness:{value:additive?.25:0}}});
    this.points=new THREE.Points(this.geometry,material);this.points.frustumCulled=false;
    const buffer=new THREE.Vector2();
    this.points.onBeforeRender=renderer=>{halfHeight.value=renderer.getDrawingBufferSize(buffer).y/2;};
  }
  emit(x:number,y:number,z:number,vx:number,vy:number,vz:number,life:number,size0:number,size1:number,r:number,g:number,b:number,a:number){
    const i=this.cursor;this.cursor=(this.cursor+1)%this.capacity;
    this.position.set([x,y,z],i*3);this.velocity.set([vx,vy,vz],i*3);this.color.set([r,g,b,0],i*4);
    this.life[i]=life;this.span[i]=life;this.grow[i*2]=size0;this.grow[i*2+1]=size1;this.alpha[i]=a;
  }
  update(dt:number){
    const damping=Math.exp(-this.drag*dt);
    for(let i=0;i<this.capacity;i++){
      if(this.life[i]<=0){this.size[i]=0;continue;}
      this.life[i]-=dt;const j=i*3,t=1-Math.max(0,this.life[i])/this.span[i];
      this.velocity[j]*=damping;this.velocity[j+1]=this.velocity[j+1]*damping+this.gravity*dt;this.velocity[j+2]*=damping;
      this.position[j]+=this.velocity[j]*dt;this.position[j+1]+=this.velocity[j+1]*dt;this.position[j+2]+=this.velocity[j+2]*dt;
      this.size[i]=this.grow[i*2]+(this.grow[i*2+1]-this.grow[i*2])*Math.sqrt(t);
      // Fade in quickly, then out over the rest of the life.
      this.color[i*4+3]=this.alpha[i]*Math.min(1,t*8)*(1-t);
    }
    for(const name of ['position','aColor','aSize'])this.geometry.getAttribute(name).needsUpdate=true;
  }
  clear(){this.life.fill(0);this.size.fill(0);this.geometry.getAttribute('aSize').needsUpdate=true;}
  dispose(){this.geometry.dispose();(this.points.material as THREE.Material).dispose();}
}

type Piece={alive:boolean;age:number;life:number;floor:number;resting:boolean;position:THREE.Vector3;velocity:THREE.Vector3;spin:THREE.Vector3;rotation:THREE.Quaternion;scale:THREE.Vector3};
// Mirror housings, aero flaps and shards of bumper, in metres.
const SHAPES:[number,number,number][]=[[.2,.11,.09],[.38,.025,.16],[.14,.02,.1],[.26,.03,.06]];

const tmpV=new THREE.Vector3(),tmpV2=new THREE.Vector3(),tmpQ=new THREE.Quaternion(),tmpQ2=new THREE.Quaternion(),tmpM=new THREE.Matrix4(),tmpC=new THREE.Color();
const CARBON=new THREE.Color(0x15181b);

/**
 * Cosmetic damage for the player's car: shader dents and scuffs on cloned body materials,
 * radiator smoke, scrape sparks and loose bodywork. Reads the simulation's hit signals; never writes to it.
 */
export class CarDamage {
  readonly group=new THREE.Group();
  readonly state=new DamageState();
  /** Particle and debris amount, 0.25 to 1; World lowers it on light graphics presets. */
  detail=1;
  reducedMotion=false;
  private uniforms=makeUniforms();
  private materials:THREE.Material[]=[];
  private bounds=new THREE.Box3(new THREE.Vector3(-1,-.9,-2.3),new THREE.Vector3(1,.3,2.3));
  private smoke=new ParticlePool(SMOKE,false,1.1,1.6);
  private sparks=new ParticlePool(SPARKS,true,-9.8,.8);
  private debris:THREE.InstancedMesh;
  private pieces:Piece[]=[];
  private paint=new THREE.Color(0x888888);
  private sim?:Simulation;private hits=0;private smokeDue=0;private sparkDue=0;private shed=0;
  constructor(){
    this.group.name='Car damage';
    const material=new THREE.MeshStandardMaterial({roughness:.45,metalness:.35});
    this.debris=new THREE.InstancedMesh(new THREE.BoxGeometry(1,1,1),material,DEBRIS);
    this.debris.instanceMatrix.setUsage(THREE.DynamicDrawUsage);this.debris.count=0;this.debris.frustumCulled=false;this.debris.castShadow=true;
    for(let i=0;i<DEBRIS;i++){
      this.pieces.push({alive:false,age:0,life:0,floor:0,resting:false,position:new THREE.Vector3(),velocity:new THREE.Vector3(),spin:new THREE.Vector3(),rotation:new THREE.Quaternion(),scale:new THREE.Vector3()});
      this.debris.setColorAt(i,this.paint);
    }
    this.group.add(this.smoke.points,this.sparks.points,this.debris);
  }
  /**
   * Prepares a freshly cloned car model for damage. Body materials are cloned first, because the
   * prepared model is shared with the ghost and remote cars, which must stay pristine.
   */
  attach(model:THREE.Object3D){
    this.detachMaterials();this.reset();
    const cloned=new Map<THREE.Material,THREE.Material>(),bounds=new THREE.Box3(),usage=new Map<THREE.Material,number>();
    for(const mesh of model.children){
      // Body batches sit directly under the rig root with no transform of their own; wheels and the steering wheel are pivots.
      if(!(mesh instanceof THREE.Mesh)||/^apex-(?:wheel|steering)/.test(mesh.name)||!mesh.matrix.equals(tmpM.identity()))continue;
      const swap=(source:THREE.Material)=>{
        if(source.userData.apexBrakeLamp||source.userData.apexHeadlamp)return source;
        let material=cloned.get(source);
        if(!material){material=source.clone();patchMaterial(material,this.uniforms);cloned.set(source,material);}
        return material;
      };
      mesh.material=Array.isArray(mesh.material)?mesh.material.map(swap):swap(mesh.material);
      mesh.geometry.computeBoundingBox();bounds.union(mesh.geometry.boundingBox!);
      const material=Array.isArray(mesh.material)?mesh.material[0]:mesh.material,triangles=(mesh.geometry.index?.count??mesh.geometry.getAttribute('position').count)/3;
      if(!material.transparent&&!/glass|window|interior|tyre|tire|black|carbon|chrome|light/i.test(material.name))usage.set(material,(usage.get(material)??0)+triangles);
    }
    this.materials=[...cloned.values()];
    if(!bounds.isEmpty())this.bounds.copy(bounds);
    // Debris takes the colour of the biggest painted surface.
    const paint=[...usage].sort((a,b)=>b[1]-a[1])[0]?.[0] as THREE.MeshStandardMaterial|undefined;
    this.paint.set(0x8a8f96);
    if(paint?.color){this.paint.copy(paint.color);const texture=paint.map&&averageTexture(paint.map);if(texture)this.paint.multiply(texture);}
  }
  /** Fresh car: no dents, no smoke, no debris on the road. */
  reset(){
    this.state.reset();this.sim=undefined;this.shed=0;this.smokeDue=this.sparkDue=0;
    this.smoke.clear();this.sparks.clear();for(const piece of this.pieces)piece.alive=false;this.debris.count=0;
    this.syncUniforms();
  }
  /** `car` is the drawn car body (its pose may be smoothed between physics ticks). */
  update(sim:Simulation,car:THREE.Object3D,dt:number,enabled:boolean){
    this.group.visible=enabled;
    if(!enabled){if(this.state.damage>0||this.debris.count)this.reset();return;}
    // A new simulation (restart, or rolling into the Training Grounds) starts its hit counter afresh.
    if(sim!==this.sim){this.sim=sim;this.hits=sim.hitCount;}
    if(sim.hitCount!==this.hits){this.hits=sim.hitCount;this.impact(sim,car);}
    const velocity=sim.car.linvel(),speed=Math.hypot(velocity.x,velocity.y,velocity.z)*sim.track.metersPerUnit;
    if(dt>0&&sim.wallContact&&speed>4){
      const local=this.toLocal(sim.contactNormal,car);
      if(Math.abs(local.x)>.35)this.state.rub(local.x,speed,dt);
      this.emitSparks(sim,car,local,speed,dt);
      this.syncUniforms();
    }
    if(dt>0)this.emitSmoke(sim,car,dt);
    this.smoke.update(dt);this.sparks.update(dt);this.updateDebris(dt);
  }
  dispose(){this.detachMaterials();this.smoke.dispose();this.sparks.dispose();this.debris.geometry.dispose();(this.debris.material as THREE.Material).dispose();}
  private detachMaterials(){for(const material of this.materials)material.dispose();this.materials=[];}
  /** World direction to car-local, flattened: hits register on the body sides and ends, not the roof or floor. */
  private toLocal(normal:Vec3,car:THREE.Object3D){
    tmpQ.copy(car.quaternion).invert();
    const local=tmpV.set(normal.x,normal.y,normal.z).applyQuaternion(tmpQ);local.y=0;
    if(local.lengthSq()<1e-6)local.set(0,0,1);return local.normalize();
  }
  /** Where a ray from the body centre along `direction` leaves the body box, at bumper and door height. */
  private surfacePoint(direction:THREE.Vector3,target:THREE.Vector3){
    const b=this.bounds,cx=(b.min.x+b.max.x)/2,cz=(b.min.z+b.max.z)/2,hx=(b.max.x-b.min.x)/2,hz=(b.max.z-b.min.z)/2;
    const t=Math.min(Math.abs(direction.x)>1e-4?hx/Math.abs(direction.x):Infinity,Math.abs(direction.z)>1e-4?hz/Math.abs(direction.z):Infinity);
    return target.set(cx+direction.x*t*.94,b.min.y+(b.max.y-b.min.y)*.38,cz+direction.z*t*.94);
  }
  private impact(sim:Simulation,car:THREE.Object3D){
    const severity=hitSeverity(sim.lastHitSpeed,sim.lastHitWithCar);if(severity<=0)return;
    const direction=this.toLocal(sim.lastHitNormal,car).clone(),point=this.surfacePoint(direction,new THREE.Vector3());
    this.state.hit(point,{x:-direction.x,y:0,z:-direction.z},severity);this.syncUniforms();
    // A real knock throws a spray of sparks and, harder still, loose bodywork.
    const world=point.clone().applyMatrix4(car.matrixWorld),velocity=sim.car.linvel(),mpu=sim.track.metersPerUnit;
    const outward=direction.clone().applyQuaternion(car.quaternion),burst=Math.round((6+severity*30)*this.amount());
    for(let i=0;i<burst;i++){
      const s=2+Math.random()*7;
      this.sparks.emit(world.x,world.y,world.z,velocity.x*mpu*.4+outward.x*s+(Math.random()-.5)*5,1.5+Math.random()*4,velocity.z*mpu*.4+outward.z*s+(Math.random()-.5)*5,
        .25+Math.random()*.35,.07,.03,1,.62+Math.random()*.3,.25,1);
    }
    if(severity<.3||this.shed>=18)return;
    const count=Math.min(18-this.shed,Math.round((1+severity*5)*(this.reducedMotion?.5:1)*this.amount()));
    const floor=tmpV2.set(0,this.bounds.min.y,0).applyMatrix4(car.matrixWorld).y;
    for(let i=0;i<count;i++)this.shedPiece(world,outward,velocity,mpu,floor,i);
    this.shed+=count;
  }
  private shedPiece(at:THREE.Vector3,outward:THREE.Vector3,velocity:Vec3,mpu:number,floor:number,i:number){
    const piece=this.pieces.find(p=>!p.alive)??this.pieces.reduce((a,b)=>a.age>b.age?a:b);
    const shape=SHAPES[(this.shed+i)%SHAPES.length],k=.8+Math.random()*.5;
    piece.alive=true;piece.age=0;piece.life=7+Math.random()*3;piece.floor=floor+shape[1]*k/2;piece.resting=false;
    piece.position.copy(at).add(tmpV.set((Math.random()-.5)*.4,Math.random()*.25,(Math.random()-.5)*.4));
    const s=2+Math.random()*4;
    piece.velocity.set(velocity.x*mpu*.65+outward.x*s+(Math.random()-.5)*3,2+Math.random()*3.5,velocity.z*mpu*.65+outward.z*s+(Math.random()-.5)*3);
    piece.spin.set((Math.random()-.5)*22,(Math.random()-.5)*22,(Math.random()-.5)*22);
    piece.rotation.random();piece.scale.set(shape[0]*k,shape[1]*k,shape[2]*k);
    this.debris.setColorAt(this.pieces.indexOf(piece),i%3===2?CARBON:tmpC.copy(this.paint).multiplyScalar(.85+Math.random()*.25));
    this.debris.instanceColor!.needsUpdate=true;
  }
  private updateDebris(dt:number){
    let drawn=0;
    for(let i=0;i<this.pieces.length;i++){
      const piece=this.pieces[i];
      if(piece.alive&&dt>0){
        piece.age+=dt;if(piece.age>piece.life)piece.alive=false;
        else if(!piece.resting){
          piece.velocity.y-=9.8*dt;piece.position.addScaledVector(piece.velocity,dt);
          const length=piece.spin.length();if(length>0)piece.rotation.premultiply(tmpQ2.setFromAxisAngle(tmpV.copy(piece.spin).divideScalar(length),length*dt));
          if(piece.position.y<piece.floor){
            // Bounce, scrub speed, and settle once the bounce is too small to see.
            piece.position.y=piece.floor;piece.velocity.y*=-.32;piece.velocity.x*=.55;piece.velocity.z*=.55;piece.spin.multiplyScalar(.5);
            if(Math.abs(piece.velocity.y)<.6&&piece.velocity.lengthSq()<1){piece.resting=true;}
          }
        }
      }
      // Lost pieces shrink away in their last half second (instanced meshes cannot fade individually).
      const fade=piece.alive?Math.min(1,(piece.life-piece.age)/.5):0;
      tmpM.compose(piece.position,piece.rotation,tmpV2.copy(piece.scale).multiplyScalar(fade));
      this.debris.setMatrixAt(i,tmpM);if(piece.alive)drawn=i+1;
    }
    this.debris.count=drawn;this.debris.instanceMatrix.needsUpdate=true;
  }
  private amount(){return Math.max(.25,this.detail*(this.reducedMotion?.6:1));}
  private emitSmoke(sim:Simulation,car:THREE.Object3D,dt:number){
    const damage=this.state.damage;if(damage<.35)return;
    const heavy=THREE.MathUtils.smoothstep(damage,.6,.9),rate=(5+heavy*16)*this.amount();
    this.smokeDue+=rate*dt;
    const b=this.bounds,velocity=sim.car.linvel(),mpu=sim.track.metersPerUnit;
    while(this.smokeDue>=1){
      this.smokeDue--;
      // From under the bonnet, a little way back from the nose.
      const at=tmpV.set((Math.random()-.5)*(b.max.x-b.min.x)*.4,b.min.y+(b.max.y-b.min.y)*.62,b.max.z-(b.max.z-b.min.z)*.18).applyMatrix4(car.matrixWorld);
      const grey=.78-heavy*.58+Math.random()*.06;
      this.smoke.emit(at.x,at.y,at.z,velocity.x*mpu*.35+(Math.random()-.5)*.6,.9+Math.random()*.8,velocity.z*mpu*.35+(Math.random()-.5)*.6,
        1.4+Math.random()*1.2+heavy,.3,1.1+heavy*1.1,grey,grey,grey*1.02,.2+heavy*.25);
    }
  }
  private emitSparks(sim:Simulation,car:THREE.Object3D,local:THREE.Vector3,speed:number,dt:number){
    if(speed<8)return;
    this.sparkDue+=Math.min(60,speed*1.6)*dt*this.amount();
    if(this.sparkDue<1)return;
    const point=this.surfacePoint(local,tmpV2);point.y=this.bounds.min.y+(this.bounds.max.y-this.bounds.min.y)*.2;
    const at=point.applyMatrix4(car.matrixWorld),velocity=sim.car.linvel(),mpu=sim.track.metersPerUnit;
    while(this.sparkDue>=1){
      this.sparkDue--;
      // Sparks drag behind the car and kick off the wall.
      this.sparks.emit(at.x+(Math.random()-.5)*.6,at.y,at.z+(Math.random()-.5)*.6,velocity.x*mpu*.55+(Math.random()-.5)*3,.8+Math.random()*2.5,velocity.z*mpu*.55+(Math.random()-.5)*3,
        .18+Math.random()*.25,.06,.025,1,.55+Math.random()*.35,.2,1);
    }
  }
  private syncUniforms(){
    const {uDent,uDentPush,uDamage,uScrape}=this.uniforms;
    for(let i=0;i<MAX_DENTS;i++){
      const dent=this.state.dents[i];
      if(dent){uDent.value[i].set(dent.centre.x,dent.centre.y,dent.centre.z,dent.radius);uDentPush.value[i].set(dent.push.x,dent.push.y,dent.push.z,dent.depth);}
      else{uDent.value[i].set(0,0,0,0);uDentPush.value[i].set(0,0,0,0);}
    }
    uDamage.value=this.state.damage;
    // Scratches only reach the outer quarter of each flank.
    const b=this.bounds,inner=(b.max.x-b.min.x)*.3;
    uScrape.value.set(this.state.scrape[0],this.state.scrape[1],b.min.x+inner,b.max.x-inner);
  }
}
