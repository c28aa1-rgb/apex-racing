import * as THREE from 'three';
import { RaceWorld } from '../world';
import { CarRig } from '../car-rig';
import { CARS, carById, type CarId } from '../../shared/cars';
import { TRACKS } from '../../shared/tracks';
import { SHOTS, ShotRoad, type ShotId } from './shots';
import { addHeadlights, TrailerLighting } from './lighting';
import type { WeatherPreset } from '../settings';
import { fetchRecordedRoutes, type RecordedRoutes } from '../dev-routes';
import { defaultGhostMotion, motionAt, type CarMotion } from './motion';
import { DriveSession, SkidRecorder, SKID_STRIDE, defaultPose, sampleTake, validPose, validTake, type Pose, type Take } from './driving';
import { DT, initPhysics } from '../../shared/physics';
import RAPIER from '@dimforge/rapier3d-compat';
import { read, write } from '../storage';
import { GRAPHICS_PRESETS } from '../graphics';

type Actor={root:THREE.Group;rig:CarRig;lights:THREE.Group;id:CarId};
/** One camera keyframe, in the followed car's frame: metres forward / right / up, degrees for lens and angles. */
export type CamKey={forward:number;side:number;height:number;fov:number;pan:number;tilt:number;roll:number};
export type CamEase='linear'|'in'|'out'|'inout';
export type CamRig={custom:boolean;path?:'line'|'arc';from:CamKey;to:CamKey;ease:CamEase;anchor:'follow'|'fixed';avoidWalls:boolean;aimForward:number;aimSide:number;aimHeight:number};
export const CAM_KEYS=['forward','side','height','fov','pan','tilt','roll'] as const;
export function easeCam(ease:CamEase,u:number){
  u=THREE.MathUtils.clamp(u,0,1);
  if(ease==='in')return u*u*u;
  if(ease==='out')return 1-(1-u)**3;
  if(ease==='inout')return u<.5?4*u*u*u:1-(-2*u+2)**3/2;
  return u;
}
/** Orbit angle around the car in degrees: 0 = in front, 90 = right side, ±180 = behind. */
export const orbitOf=(k:CamKey)=>({angle:THREE.MathUtils.radToDeg(Math.atan2(k.side,k.forward)),distance:Math.hypot(k.side,k.forward)});
export function setOrbit(k:CamKey,angle:number,distance:number){
  const a=THREE.MathUtils.degToRad(angle),r=Math.max(.05,distance);
  k.forward=Math.round(Math.cos(a)*r*1000)/1000;k.side=Math.round(Math.sin(a)*r*1000)/1000;
}
const camKey=(k:Partial<CamKey>={}):CamKey=>({forward:-8,side:3,height:1.2,fov:48,pan:0,tilt:0,roll:0,...k});
export class TrailerDirector {
  readonly world:RaceWorld;
  readonly lighting:TrailerLighting;
  actors:Actor[]=[];
  shot:ShotId='drone'; trackId='bugatti'; carId:CarId='porsche-911-gt3'; count=3;
  time=0; playing=false; loop=true; speed=1; hour=13; cycle=false; cycleSeconds=120;
  exposure=1.05; headlights=true; fov=48; cameraHeight=0; cameraSide=0;
  bloom=.12; fogFar=3000; weather:WeatherPreset='clear';
  routeOffset=40; ready=false; error='';
  routes:RecordedRoutes={}; routeOnline=false; routeAvailable=false;
  motion:CarMotion[]=defaultGhostMotion();
  shotDuration=8; focusCar=0; framePack=true;
  /** Driven takes and parked positions per car; a car with neither follows the route ghost. */
  takes:(Take|null)[]=[null,null,null,null];
  starts:(Pose|null)[]=[null,null,null,null];
  driveSlot=-1; recording=false; cockpit=false; driveLoading=-1;
  private driveToken=0;
  private skid=new SkidRecorder();
  drive?:DriveSession;
  private recorded:number[]=[];
  private chaseYaw=0;
  private tmpQ=new THREE.Quaternion();
  editKey:'from'|'to'='from';
  camRig:CamRig={custom:false,path:'arc',from:camKey(),to:camKey({forward:-6}),ease:'inout',anchor:'follow',avoidWalls:false,aimForward:0,aimSide:0,aimHeight:.3};
  private road:ShotRoad;
  private token=0;
  private frameId=0;
  private last=0;
  private ground=new THREE.Raycaster();
  private sight=new THREE.Raycaster();
  private floorCache=new Map<string,number>();
  onChange=()=>{};
  constructor(canvas:HTMLCanvasElement) {
    this.world=new RaceWorld(canvas,true);
    this.world.setGraphics(GRAPHICS_PRESETS.cinematic);
    this.world.car.visible=false;this.world.ghost.visible=false;
    this.road=new ShotRoad(TRACKS[0]);
    this.lighting=new TrailerLighting(this.world);
    this.frameId=requestAnimationFrame(this.frame);
  }
  get duration(){return this.shotDuration;}
  get routeLength(){return this.road.length;}
  get canPlay(){return this.ready&&(this.routeAvailable||this.takes.some(Boolean));}
  get driving(){return this.driveSlot>=0&&!!this.drive;}
  get recordedSeconds(){return Math.max(0,this.recorded.length/10-1)*DT;}
  get speedKmh(){return this.drive?.speedKmh??0;}
  private storageKey(){return `trailer-takes:${this.trackId}`;}
  private persist(){write(this.storageKey(),{takes:this.takes,starts:this.starts});}
  private pendingTakes?:{takes:(Take|null)[];starts:(Pose|null)[]};
  private restoreSaved(){
    if(this.pendingTakes){this.takes=this.pendingTakes.takes;this.starts=this.pendingTakes.starts;this.pendingTakes=undefined;return;}
    const saved=read<{takes?:unknown[];starts?:unknown[]}>(this.storageKey(),{});
    this.takes=[0,1,2,3].map(i=>validTake(saved.takes?.[i])&&(saved.takes![i] as Take).trackId===this.trackId?saved.takes![i] as Take:null);
    this.starts=[0,1,2,3].map(i=>validPose(saved.starts?.[i])?saved.starts![i] as Pose:null);
  }
  /** Apply a saved take recipe (the JSON the Download button writes). */
  async loadRecipe(t:any){
    this.shot=t.shot;this.trackId=t.trackId;this.carId=t.carId;this.count=t.count;
    this.pendingTakes=t.takes?{takes:t.takes,starts:t.starts}:undefined;
    await this.load();
    for(const k of ['hour','cycle','cycleSeconds','exposure','headlights','fov','cameraHeight','cameraSide','bloom','fogFar','shotDuration','focusCar','framePack','cockpit','speed'] as const)if(t[k]!==undefined)(this as any)[k]=t[k];
    if(t.motion)this.motion=t.motion;
    if(t.night)Object.assign(this.lighting.night,t.night);
    this.weather=t.weather;this.world.setWeather(this.weather);
    if(t.camRig)this.camRig=t.camRig;
    this.time=0;this.draw();this.onChange();
  }
  /** Start driving a car so its motion can be recorded or its position set by hand. */
  async startDrive(slot:number){
    if(!this.ready||slot<0||slot>=this.count||this.driveLoading===slot||this.driveSlot===slot)return;
    // Switching cars mid-take keeps the take instead of discarding it.
    if(this.recording)this.finishTake();
    this.stopDrive();this.playing=false;this.time=0;
    const token=this.driveToken,track=TRACKS.find(t=>t.id===this.trackId)!;
    this.driveLoading=slot;this.onChange();
    let session:DriveSession|undefined;
    try{session=await DriveSession.create(track,this.actors[slot].id,this.starts[slot]??this.currentPose(slot)??defaultPose(track,slot));}
    catch(error){if(token===this.driveToken){this.driveLoading=-1;this.error=error instanceof Error?error.message:String(error);this.onChange();}}
    // A newer click, a circuit change or Stop arrived while this physics world was loading.
    if(token!==this.driveToken||!this.ready||this.trackId!==track.id){session?.dispose();return;}
    if(!session)return;
    this.drive=session;this.driveSlot=slot;this.driveLoading=-1;this.focusCar=slot;this.framePack=false;this.chaseYaw=NaN;
    this.world.skidMarks.clear();
    this.onChange();
  }
  stopDrive(){
    this.driveToken++;this.driveLoading=-1;
    this.recording=false;this.recorded=[];this.skid.reset();this.drive?.dispose();this.drive=undefined;this.driveSlot=-1;
    this.world.skidMarks.clear();this.onChange();
  }
  private currentPose(slot:number):Pose|undefined{
    const take=this.takes[slot];
    if(take)return {p:take.frames.slice(0,3) as [number,number,number],q:take.frames.slice(3,7) as [number,number,number,number]};
    return undefined;
  }
  /** Begin a take from wherever the car is now; the other cars play their takes in sync. */
  record(){
    if(!this.drive)return;
    this.recorded=[...this.drive.frame()];this.skid.reset();this.recording=true;this.time=0;this.playing=false;this.onChange();
  }
  /** Stop recording and keep the take. */
  finishTake(){
    if(!this.recording||!this.drive||this.driveSlot<0)return;
    this.recording=false;
    if(this.recorded.length>=20){
      const first=this.recorded.slice(0,7);
      this.takes[this.driveSlot]={carId:this.actors[this.driveSlot].id,trackId:this.trackId,frames:this.recorded,...(this.skid.out.length?{skids:this.skid.out}:{})};
      this.world.skidMarks.clear();
      this.starts[this.driveSlot]={p:first.slice(0,3) as [number,number,number],q:first.slice(3,7) as [number,number,number,number]};
      this.persist();
    }
    this.recorded=[];this.skid.reset();this.time=0;this.onChange();
  }
  /** Leave this car standing exactly where it is. */
  parkHere(){
    if(!this.drive||this.driveSlot<0)return;
    if(this.recording)this.recording=false;this.recorded=[];
    const frame=this.drive.frame();
    this.takes[this.driveSlot]={carId:this.actors[this.driveSlot].id,trackId:this.trackId,frames:[...frame.slice(0,7),0,0,0]};
    this.starts[this.driveSlot]={p:frame.slice(0,3) as [number,number,number],q:frame.slice(3,7) as [number,number,number,number]};
    this.persist();this.onChange();
  }
  resetDriven(){if(this.driveSlot>=0){this.recording=false;this.recorded=[];this.skid.reset();this.world.skidMarks.clear();const s=this.starts[this.driveSlot];if(s)this.drive?.place(s);else this.drive?.reset();this.onChange();}}
  clearTake(slot:number){this.takes[slot]=null;this.starts[slot]=null;this.persist();this.draw();this.onChange();}
  async reloadRoutes(){
    const result=await fetchRecordedRoutes();this.routes=result.routes;this.routeOnline=result.online;
    if(!this.ready&&!this.routes[this.trackId])this.trackId=TRACKS.find(track=>this.routes[track.id])?.id??this.trackId;
    await this.load();
  }
  async selectShot(id:ShotId) {
    this.shot=id;this.time=0;this.playing=false;
    const preset=SHOTS.find(s=>s.id===id)!;this.hour=preset.hour;
    this.fov=id==='wheel'?62:48;this.cameraSide=this.cameraHeight=0;
    this.framePack=id==='drone'||id==='grid';this.camRig.custom=false;
    this.shotDuration=preset.duration;
    this.draw();this.onChange();
  }
  async load() {
    const token=++this.token;this.stopDrive();this.ready=false;this.playing=false;this.error='';this.restoreSaved();this.onChange();
    try {
      const track=TRACKS.find(t=>t.id===this.trackId)!;
      if(this.world.currentTrack?.id!==track.id){this.world.setTrack(track);this.floorCache.clear();this.wheelCache.clear();}
      this.routeAvailable=!!this.routes[track.id];
      this.road=new ShotRoad(track,this.routes[track.id]);
      this.routeOffset=THREE.MathUtils.clamp(this.routeOffset,0,Math.max(0,this.road.length-1));
      const roster=[this.carId,...CARS.filter(c=>c.id!==this.carId&&['ferrari-488-gt3','mclaren-720s-gt3','skyline-r34'].includes(c.id)).map(c=>c.id)];
      // A car with a driven take keeps the model it was driven with.
      const ids=roster.slice(0,this.count).map((id,i)=>{const take=this.takes[i];return take&&CARS.some(c=>c.id===take.carId)?take.carId:id;});
      // Cached source models are shared; rigs own only their cloned lamp materials.
      await initPhysics();
      const models=await Promise.all(ids.map(id=>this.world.partyModel(id)));
      await this.world.venueReady;
      if(token!==this.token)return;
      if(track.model&&!this.world.venueGroup.children.length)throw new Error('Venue could not load. Retry the shot.');
      if(this.probe?.trackId!==track.id)this.buildProbe(track.id);
      this.actors.forEach(a=>{a.rig.dispose();a.root.removeFromParent();a.lights.traverse(o=>{if(o instanceof THREE.Mesh){o.geometry.dispose();(o.material as THREE.Material).dispose();}});});
      this.actors=models.map((root,i)=>{
        const id=ids[i],definition=carById(id),rig=new CarRig(root,definition);
        root.traverse(o=>{if(o instanceof THREE.Mesh){o.castShadow=true;o.receiveShadow=true;}});
        const lights=addHeadlights(root,definition);this.world.scene.add(root);
        return {root,rig,lights,id};
      });
      this.world.car.visible=false;this.world.ghost.visible=false;
      this.world.venueGroup.visible=true;this.world.trackGroup.visible=true;
      this.focusCar=Math.min(this.focusCar,this.count-1);
      this.time=0;this.ready=true;this.playing=this.routeAvailable&&!this.takes.some(Boolean);this.draw();
    }catch(error){if(token===this.token)this.error=error instanceof Error?error.message:String(error);}
    if(token===this.token)this.onChange();
  }
  seek(time:number){this.time=THREE.MathUtils.clamp(time,0,this.duration);this.draw();this.onChange();}
  private floor(position:THREE.Vector3) {
    const key=`${Math.round(position.x*2)},${Math.round(position.z*2)}`;
    const cached=this.floorCache.get(key);if(cached!==undefined)return cached;
    const probed=this.probeGround(position,.3,3);
    if(probed!==undefined){if(this.floorCache.size>15000)this.floorCache.clear();this.floorCache.set(key,probed);return probed;}
    this.ground.set(position.clone().add(new THREE.Vector3(0,.3,0)),new THREE.Vector3(0,-1,0));
    this.ground.far=10;
    const hit=this.ground.intersectObject(this.world.venueGroup,true).find(h=>Math.abs(h.point.y-position.y)<3);
    const y=hit?.point.y??position.y;
    if(this.floorCache.size>15000)this.floorCache.clear();this.floorCache.set(key,y);return y;
  }
  private wheelCache=new Map<string,number|null>();
  /**
   * The visible venue's upward-facing triangles, as a Rapier collider used only
   * for ground queries. Rays against the raw three.js meshes cost ~20 ms each;
   * these take microseconds and still match the road the camera sees.
   */
  private probe?:{world:RAPIER.World;trackId:string};
  private probeGround(position:THREE.Vector3,up=.65,down=1.8){
    if(!this.probe)return undefined;
    const top=position.y+up;
    const hit=this.probe.world.castRayAndGetNormal(new RAPIER.Ray({x:position.x,y:top,z:position.z},{x:0,y:-1,z:0}),up+down,true);
    return hit&&Math.abs(hit.normal.y)>.55?top-hit.timeOfImpact:undefined;
  }
  private buildProbe(trackId:string){
    this.probe?.world.free();this.probe=undefined;
    const vertices:number[]=[],indices:number[]=[];
    const a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3(),n=new THREE.Vector3();
    this.world.venueGroup.updateMatrixWorld(true);
    this.world.venueGroup.traverse(o=>{
      if(!(o instanceof THREE.Mesh)||!o.visible)return;
      const position=o.geometry.getAttribute('position');if(!position)return;
      const index=o.geometry.getIndex(),count=index?index.count:position.count;
      for(let i=0;i<count;i+=3){
        const ia=index?index.getX(i):i,ib=index?index.getX(i+1):i+1,ic=index?index.getX(i+2):i+2;
        a.fromBufferAttribute(position,ia).applyMatrix4(o.matrixWorld);b.fromBufferAttribute(position,ib).applyMatrix4(o.matrixWorld);c.fromBufferAttribute(position,ic).applyMatrix4(o.matrixWorld);
        n.subVectors(c,b).cross(a.clone().sub(b)).normalize();
        if(Math.abs(n.y)<.5)continue;
        const base=vertices.length/3;vertices.push(a.x,a.y,a.z,b.x,b.y,b.z,c.x,c.y,c.z);indices.push(base,base+1,base+2);
      }
    });
    if(!indices.length)return;
    const world=new RAPIER.World({x:0,y:0,z:0});
    world.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array(vertices),new Uint32Array(indices)));
    world.step();
    this.probe={world,trackId};this.wheelCache.clear();this.floorCache.clear();
  }
  /** Visible road height under one wheel, or undefined when nothing is close below it. */
  private wheelFloor(center:THREE.Vector3,radius:number) {
    const key=`${Math.round(center.x*8)},${Math.round(center.z*8)},${Math.round(center.y)}`;
    if(this.wheelCache.has(key))return this.wheelCache.get(key)??undefined;
    if(this.probe){
      const y=this.probeGround(new THREE.Vector3(center.x,center.y-radius,center.z),.35+radius,1.2);
      if(this.wheelCache.size>40000)this.wheelCache.clear();
      this.wheelCache.set(key,y??null);return y;
    }
    this.ground.set(center.clone().add(new THREE.Vector3(0,1,0)),new THREE.Vector3(0,-1,0));this.ground.far=2.5+radius;
    // Ignore overhead geometry (gantries, banners) and anything far under the tyre.
    const hit=this.ground.intersectObject(this.world.venueGroup,true).find(h=>h.point.y<=center.y+.35&&h.point.y>=center.y-radius-1.2);
    if(this.wheelCache.size>40000)this.wheelCache.clear();
    this.wheelCache.set(key,hit?hit.point.y:null);return hit?.point.y;
  }
  /**
   * Seat a car on the visible road so no tyre sinks into it. Physics poses keep
   * their own pitch and roll; scripted poses (tilt) also take the ground's slope.
   * A physics car well clear of the road (a jump) is left airborne.
   */
  private fitToGround(actor:Actor,tilt:boolean) {
    const root=actor.root,wheels=actor.rig.wheels;
    for(const wheel of wheels)wheel.position.y=wheel.userData.rest[1];
    const measure=()=>{root.updateMatrixWorld(true);return wheels.map(w=>{const c=w.getWorldPosition(new THREE.Vector3());return {c,r:w.userData.radius as number,floor:this.wheelFloor(c,w.userData.radius)};});};
    let contacts=measure();
    if(tilt&&contacts.length===4&&contacts.every(w=>w.floor!==undefined)){
      const p=contacts.map(w=>new THREE.Vector3(w.c.x,w.floor!,w.c.z));
      const normal=p[0].clone().sub(p[3]).cross(p[1].clone().sub(p[2]));
      if(normal.y<0)normal.negate();normal.normalize();
      if(normal.y>.8){
        const yaw=new THREE.Euler().setFromQuaternion(root.quaternion,'YXZ').y;
        root.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),normal).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),yaw));
        contacts=measure();
        // Front and rear tyres can differ in size; pitch so both axles touch.
        const gap=(i:number)=>contacts[i].c.y-contacts[i].r-contacts[i].floor!;
        const front=(gap(0)+gap(1))/2,rear=(gap(2)+gap(3))/2,base=contacts[0].c.distanceTo(contacts[2].c);
        if(base>.5){root.rotateX(Math.atan2(front-rear,base));contacts=measure();}
      }
    }
    let lift=-Infinity;
    for(const w of contacts)if(w.floor!==undefined)lift=Math.max(lift,w.floor+.012-(w.c.y-w.r));
    if(!Number.isFinite(lift))return;
    if(!tilt&&lift<-.3)return;
    root.position.y+=lift;
    // Let each tyre drop a little onto the visible road, like suspension travel in the race view.
    const up=new THREE.Vector3(0,1,0).applyQuaternion(root.quaternion).y;
    contacts.forEach((w,i)=>{
      if(w.floor===undefined)return;
      const gap=w.c.y+lift-w.r-(w.floor+.012);
      wheels[i].position.y-=THREE.MathUtils.clamp(gap/up,0,Math.min(.045,w.r*.12));
    });
  }
  private skidMeshes:({take:Take;mesh:THREE.Mesh;ticks:Float32Array}|undefined)[]=[];
  /** Tyre marks of each recorded take, revealed as its car drives over them. */
  private updateSkids(t:number){
    for(let i=0;i<4;i++){
      const take=this.takes[i]&&this.takes[i]!.skids?.length?this.takes[i]!:undefined,entry=this.skidMeshes[i];
      if(entry&&entry.take!==take){entry.mesh.removeFromParent();entry.mesh.geometry.dispose();(entry.mesh.material as THREE.Material).dispose();this.skidMeshes[i]=undefined;}
      if(!take)continue;
      if(!this.skidMeshes[i]){
        const n=take.skids!.length/SKID_STRIDE,positions=new Float32Array(n*18),ticks=new Float32Array(n);
        const a=new THREE.Vector3(),b=new THREE.Vector3(),edge=new THREE.Vector3(),up=new THREE.Vector3(0,1,0);
        for(let k=0;k<n;k++){
          const o=k*SKID_STRIDE,S=take.skids!;ticks[k]=S[o];
          a.set(S[o+1],S[o+2],S[o+3]);b.set(S[o+4],S[o+5],S[o+6]);
          edge.subVectors(b,a).cross(up).normalize().multiplyScalar(.12);
          const p0=a.clone().add(edge),p1=a.clone().sub(edge),p2=b.clone().add(edge),p3=b.clone().sub(edge);
          positions.set([...p0.toArray(),...p1.toArray(),...p2.toArray(),...p1.toArray(),...p3.toArray(),...p2.toArray()],k*18);
        }
        const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));
        const mesh=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({color:0x000000,transparent:true,opacity:.82,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2,side:THREE.DoubleSide}));
        mesh.frustumCulled=false;mesh.name='Take tyre marks';this.world.scene.add(mesh);
        this.skidMeshes[i]={take,mesh,ticks};
      }
      const {mesh,ticks}=this.skidMeshes[i]!;
      // The live car draws its own marks; its old take's marks would double them.
      mesh.visible=this.driveSlot!==i;
      const tick=t*60;let lo=0,hi=ticks.length;
      while(lo<hi){const mid=(lo+hi)>>1;if(ticks[mid]<=tick)lo=mid+1;else hi=mid;}
      mesh.geometry.setDrawRange(0,lo*6);
    }
  }
  /** Cars with a driven take (or being driven live) use it; everything else follows the route ghost. */
  private drawRecorded(actor:Actor,i:number,t:number){
    const take=this.takes[i];
    let steering=0,brake=0,travel=0;
    if(this.driveSlot===i&&this.drive){
      const sim=this.drive.sim,p=sim.car.translation(),q=sim.car.rotation();
      actor.root.position.set(p.x,p.y,p.z);actor.root.quaternion.set(q.x,q.y,q.z,q.w);
      steering=sim.steering;brake=sim.brake;travel=this.drive.travel;
    }else if(take){
      ({steering,brake,travel}=sampleTake(take,t,actor.root.position,actor.root.quaternion));
    }else if(!this.routeAvailable){
      const pose=this.starts[i]??defaultPose(TRACKS.find(tr=>tr.id===this.trackId)!,i);
      actor.root.position.set(...pose.p);actor.root.quaternion.set(...pose.q);
    }else return false;
    this.fitToGround(actor,!take&&this.driveSlot!==i);
    for(const wheel of actor.rig.wheels)wheel.getObjectByName('apex-wheel-spin')!.rotation.x=travel/wheel.userData.radius;
    actor.rig.animate(steering,0,brake);
    actor.lights.visible=this.headlights;actor.rig.setHeadlights(this.headlights);
    return true;
  }
  /** Preset camera offsets. `side` is toward the car's left, `behind` is along its nose. */
  private presetOffsets(t:number){
    let side=8,height=3,behind=-12;
    if(this.shot==='pit'){side=-5; height=.05; behind=5-t*1.5;}
    if(this.shot==='grid'){side=0;height=1.3;behind=-13;}
    if(this.shot==='launch'){side=9; height=1.2;behind=4-t*3;}
    if(this.shot==='drone'){side=10; height=10;behind=-22;}
    if(this.shot==='wheel'){side=-1.8;height=-.45;behind=2;}
    if(this.shot==='finish'){side=Math.cos(t*.3)*10;height=2+t*.5;behind=Math.sin(t*.3)*10;}
    return {side,height,behind};
  }
  /** Start a custom move from the current shot preset so it can be fine-tuned. */
  customFromPreset(){
    const key=(t:number)=>{const o=this.presetOffsets(t);const r=(n:number)=>Math.round(n*1000)/1000;return camKey({forward:r(o.behind),side:r(-(o.side+this.cameraSide)),height:r(o.height+this.cameraHeight),fov:r(this.fov)});};
    const wheel=this.shot==='wheel';
    this.camRig={...this.camRig,custom:true,from:key(0),to:key(this.duration),ease:'linear',anchor:'follow',avoidWalls:false,aimForward:wheel?1.2:0,aimSide:wheel?.85:0,aimHeight:wheel?-.4:0};
    this.framePack=false;this.draw();this.onChange();
  }
  private get customCamera(){return this.camRig.custom&&!this.cockpit&&!(this.driving&&this.driveSlot===this.focusCar);}
  draw() {
    if(!this.ready)return;
    const t=this.time;
    this.world.venueGroup.updateMatrixWorld(true);
    let basis:{p:THREE.Vector3;q:THREE.Quaternion}|undefined;
    if(this.customCamera&&this.camRig.anchor==='fixed'){
      // A tripod: the camera stays where the car's frame was at the start of the shot.
      this.placeActors(0);const h=this.actors[this.focusCar].root;basis={p:h.position.clone(),q:h.quaternion.clone()};
    }
    this.placeActors(t);
    this.updateSkids(t);
    if(this.customCamera){this.drawCustomCamera(basis,t);this.finishFrame(t);return;}
    this.drawPresetCamera(t);
  }
  private drawCustomCamera(basis:{p:THREE.Vector3;q:THREE.Quaternion}|undefined,t:number){
    const rig=this.camRig,hero=this.actors[this.focusCar].root,cam=this.world.camera;
    const u=easeCam(rig.ease,this.duration>0?t/this.duration:0);
    const k=Object.fromEntries(CAM_KEYS.map(n=>[n,THREE.MathUtils.lerp(rig.from[n],rig.to[n],u)])) as CamKey;
    if(rig.path==='arc'){
      // Swing around the car instead of cutting straight through it.
      const a=orbitOf(rig.from),b=orbitOf(rig.to),turn=((b.angle-a.angle)%360+540)%360-180;
      setOrbit(k,a.angle+turn*u,THREE.MathUtils.lerp(a.distance,b.distance,u));
    }
    // Heading only, so the camera stays level while the car pitches and rolls.
    const frame=(q:THREE.Quaternion)=>{const yaw=new THREE.Euler().setFromQuaternion(q,'YXZ').y,forward=new THREE.Vector3(Math.sin(yaw),0,Math.cos(yaw));return {forward,right:new THREE.Vector3(-forward.z,0,forward.x)};};
    const at=frame(basis?.q??hero.quaternion),live=frame(hero.quaternion);
    cam.position.copy(basis?.p??hero.position).addScaledVector(at.forward,k.forward).addScaledVector(at.right,k.side);cam.position.y+=k.height;
    const target=hero.position.clone().addScaledVector(live.forward,rig.aimForward).addScaledVector(live.right,rig.aimSide);target.y+=rig.aimHeight;
    if(rig.avoidWalls){
      const sightline=cam.position.clone().sub(target),distance=sightline.length();
      this.sight.set(target,sightline.normalize());this.sight.far=distance;
      const obstruction=this.sight.intersectObject(this.world.venueGroup,true)[0];
      if(obstruction&&obstruction.distance>1)cam.position.copy(target).addScaledVector(sightline,Math.max(1,obstruction.distance-.3));
    }
    cam.up.set(0,1,0);cam.lookAt(target);
    cam.rotateY(THREE.MathUtils.degToRad(-k.pan));cam.rotateX(THREE.MathUtils.degToRad(k.tilt));cam.rotateZ(THREE.MathUtils.degToRad(k.roll));
    cam.near=.025;cam.fov=k.fov;cam.updateProjectionMatrix();
  }
  private placeActors(t:number){
    this.actors.forEach((actor,i)=>{
      if(this.drawRecorded(actor,i,t))return;
      const config=this.motion[i],pose=motionAt(config,this.routeAvailable?t:0,this.duration);
      const distance=this.routeOffset+pose.position;
      const sample=this.road.sample(distance,pose.lane);
      const travel=this.road.closed?pose.distance:THREE.MathUtils.clamp(distance,0,this.road.length)-THREE.MathUtils.clamp(this.routeOffset+config.offset,0,this.road.length);
      actor.root.position.copy(sample.position);
      actor.root.position.y=this.floor(sample.position)+.58+carById(actor.id).dimensions.wheelRadiusM;
      const drift=this.shot==='curb'?Math.sin(t/this.duration*Math.PI)*.35:0;
      const ahead=this.road.sample(distance+config.direction*1.2,pose.lane),behind=this.road.sample(distance-config.direction*1.2,pose.lane);
      const pitch=-Math.atan2(this.floor(ahead.position)-this.floor(behind.position),2.4);
      actor.root.rotation.set(THREE.MathUtils.clamp(pitch,-.3,.3),Math.atan2(sample.forward.x,sample.forward.z)+(config.direction===-1?Math.PI:0)+drift,0,'YXZ');
      this.fitToGround(actor,true);
      for(const wheel of actor.rig.wheels){
        wheel.getObjectByName('apex-wheel-spin')!.rotation.x=travel*config.direction/wheel.userData.radius;
      }
      const turn=sample.forward.clone().cross(ahead.forward).y*config.direction;
      actor.rig.animate(THREE.MathUtils.clamp(turn*2-drift,-.4,.4),0,config.endSpeed<config.speed?.6:0);
      actor.lights.visible=this.headlights;
      actor.rig.setHeadlights(this.headlights);
    });
  }
  private drawPresetCamera(t:number){
    const hero=this.actors[this.focusCar].root,cam=this.world.camera;
    const forward=new THREE.Vector3(0,0,1).applyQuaternion(hero.quaternion),right=new THREE.Vector3(forward.z,0,-forward.x);
    const {side,height,behind}=this.presetOffsets(t);
    const target=hero.position.clone();
    cam.position.copy(target).addScaledVector(right,side+this.cameraSide).addScaledVector(forward,behind);
    cam.position.y+=height+this.cameraHeight;
    if(this.shot==='curb'||this.shot==='overtake'){
      const middle=motionAt(this.motion[this.focusCar],this.duration*.5,this.duration);
      const fixed=this.road.sample(this.routeOffset+middle.position,-4.5);
      cam.position.copy(fixed.position).addScaledVector(fixed.right,this.cameraSide);cam.position.y+=.7+this.cameraHeight;
    }
    if(this.shot==='wheel')target.addScaledVector(right,-.85).addScaledVector(forward,1.2).add(new THREE.Vector3(0,-.4,0));
    if(this.framePack){
      const bounds=new THREE.Box3().setFromPoints(this.actors.map(a=>a.root.position));
      const center=bounds.getCenter(new THREE.Vector3()),radius=bounds.getSize(new THREE.Vector3()).length()/2+3;
      const offset=cam.position.clone().sub(target);
      const fit=radius/(Math.sin(THREE.MathUtils.degToRad(this.fov)/2)*Math.min(1,cam.aspect));
      target.copy(center);cam.position.copy(center).addScaledVector(offset.normalize(),Math.max(fit,12));
    }else if(cam.aspect<1&&this.shot!=='wheel'){
      cam.position.sub(target).multiplyScalar(1/Math.sqrt(cam.aspect)).add(target);
    }
    if(this.cockpit||(this.driving&&this.driveSlot===this.focusCar)){
      const q=hero.quaternion,heading=new THREE.Euler().setFromQuaternion(q,'YXZ').y;
      if(this.cockpit){
        const definition=carById(this.actors[this.focusCar].id),e=hero.userData.cockpitEye as {x:number;y:number;z:number}|undefined;
        const eye=e?new THREE.Vector3(e.x,e.y,e.z):new THREE.Vector3(definition.dimensions.bodyWidthM*.21,-(.58+definition.dimensions.wheelRadiusM)+definition.dimensions.heightM*.78,-definition.dimensions.wheelbaseM*.1);
        cam.position.copy(eye).applyQuaternion(q).add(hero.position);
        cam.up.set(0,1,0).applyQuaternion(q);
        cam.lookAt(cam.position.clone().add(new THREE.Vector3(0,.02,1).applyQuaternion(q)));
        cam.near=.025;cam.fov=this.fov;cam.updateProjectionMatrix();
        this.finishFrame(t);return;
      }
      // Chase camera: follows the heading with a short lag so drifts stay readable.
      this.chaseYaw=Number.isFinite(this.chaseYaw)?this.chaseYaw+Math.atan2(Math.sin(heading-this.chaseYaw),Math.cos(heading-this.chaseYaw))*.12:heading;
      const dir=new THREE.Vector3(Math.sin(this.chaseYaw),0,Math.cos(this.chaseYaw));
      cam.position.copy(hero.position).addScaledVector(dir,-8-this.cameraSide*0).add(new THREE.Vector3(0,2.6+this.cameraHeight,0));
      target.copy(hero.position).add(new THREE.Vector3(0,1,0));
      cam.up.set(0,1,0);cam.lookAt(target);cam.near=.025;cam.fov=this.fov;cam.updateProjectionMatrix();
      this.finishFrame(t);return;
    }
    // Keep the lens on the subject's side of walls and bridge geometry.
    const sightline=cam.position.clone().sub(target),distance=sightline.length();
    this.sight.set(target,sightline.normalize());this.sight.far=distance;
    const obstruction=this.sight.intersectObject(this.world.venueGroup,true)[0];
    if(obstruction&&obstruction.distance>3)cam.position.copy(target).addScaledVector(sightline,Math.max(3,obstruction.distance-.4));
    cam.up.set(0,1,0);cam.lookAt(target);cam.near=.025;cam.fov=this.fov;cam.updateProjectionMatrix();
    this.finishFrame(t);
  }
  private finishFrame(t:number){
    const hero=this.actors[this.focusCar].root,cam=this.world.camera;
    this.world.car.position.copy(hero.position);
    const day=this.lighting.update((this.hour+(this.cycle?t/this.cycleSeconds*24:0))%24,this.exposure,hero.position);
    if(day<.5&&!this.lighting.roadTuned)this.findRoad();
    this.world.setCinematicBloom(this.bloom);
    this.world.weather.seek(this.time);
    this.world.weather.update(0,cam,1,false,false);
    this.world.render(this.lighting.direction,this.fogFar);
  }
  /** Venue materials directly under the cars: the road surface for night gloss. */
  private findRoad(){
    const found=new Set<THREE.Material>();
    for(const a of this.actors){
      this.ground.set(a.root.position.clone().add(new THREE.Vector3(0,1.5,0)),new THREE.Vector3(0,-1,0));this.ground.far=5;
      const hit=this.ground.intersectObject(this.world.venueGroup,true)[0];
      if(!hit||!(hit.object instanceof THREE.Mesh))continue;
      const m=hit.object.material;found.add(Array.isArray(m)?m[hit.face?.materialIndex??0]:m);
    }
    this.lighting.glossRoad(found);
  }
  private frame=(now:number)=>{
    const dt=this.last?Math.min((now-this.last)/1000,.1):0;this.last=now;
    if(this.ready&&this.drive){
      this.drive.advance(dt,()=>{
        if(!this.recording)return;
        this.recorded.push(...this.drive!.frame());
        this.skid.step(this.drive!.sim,this.recorded.length/10-1);
        this.time=this.recordedSeconds;
        if(this.time>=this.duration)this.finishTake();
      });
      this.world.skidMarks.update(this.drive.sim,true);
      this.onChange();
    }
    if(this.ready&&this.playing&&!this.recording){
      this.time+=dt*this.speed;
      if(this.time>this.duration){if(this.loop)this.time%=this.duration;else{this.time=this.duration;this.playing=false;}}
      this.onChange();
    }
    this.draw();this.frameId=requestAnimationFrame(this.frame);
  };
  stop(){cancelAnimationFrame(this.frameId);}
}
