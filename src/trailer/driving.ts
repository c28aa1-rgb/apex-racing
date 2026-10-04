import * as THREE from 'three';
import { DT, initPhysics, Input, Simulation } from '../../shared/physics';
import { spawnGate, type Track } from '../../shared/tracks';
import type { CarId } from '../../shared/cars';
import { loadSettings } from '../settings';
import type { Action } from '../controls';
import { tireStress } from '../race-audio';

/** One recorded tick: position(3) rotation(4) steering brake wheel-travel. */
export const STRIDE=10;
/** Tyre-mark segments: tick, previous contact(3), contact(3). */
export const SKID_STRIDE=7;
export type Take={carId:CarId;trackId:string;frames:number[];skids?:number[]};
export type Pose={p:[number,number,number];q:[number,number,number,number]};
export const takeTicks=(take:Take)=>take.frames.length/STRIDE;
export const takeSeconds=(take:Take)=>Math.max(0,takeTicks(take)-1)*DT;
export function validTake(value:unknown):value is Take {
  const take=value as Take;
  const skids=take?.skids;
  return !!take&&typeof take.carId==='string'&&typeof take.trackId==='string'&&Array.isArray(take.frames)&&take.frames.length>=STRIDE&&take.frames.length%STRIDE===0&&take.frames.length<=STRIDE*60*120&&take.frames.every(n=>Number.isFinite(n))
    &&(skids===undefined||(Array.isArray(skids)&&skids.length%SKID_STRIDE===0&&skids.length<=SKID_STRIDE*60*120*4&&skids.every(n=>Number.isFinite(n))));
}
export function validPose(value:unknown):value is Pose {
  const pose=value as Pose;
  return !!pose&&Array.isArray(pose.p)&&pose.p.length===3&&Array.isArray(pose.q)&&pose.q.length===4&&[...pose.p,...pose.q].every(n=>Number.isFinite(n));
}
const round=(n:number)=>Math.round(n*1e4)/1e4;

const tmpA=new THREE.Quaternion(),tmpB=new THREE.Quaternion();
/** Fixed 60 Hz frames interpolate exactly, so scrubbing matches playback. Holds the last pose after the take ends. */
export function sampleTake(take:Take,time:number,position:THREE.Vector3,quaternion:THREE.Quaternion) {
  const count=takeTicks(take),f=THREE.MathUtils.clamp(time/DT,0,count-1),i=Math.floor(f),j=Math.min(count-1,i+1),a=f-i,F=take.frames;
  const at=(k:number,o:number)=>F[k*STRIDE+o];
  position.set(THREE.MathUtils.lerp(at(i,0),at(j,0),a),THREE.MathUtils.lerp(at(i,1),at(j,1),a),THREE.MathUtils.lerp(at(i,2),at(j,2),a));
  quaternion.copy(tmpA.set(at(i,3),at(i,4),at(i,5),at(i,6)).slerp(tmpB.set(at(j,3),at(j,4),at(j,5),at(j,6)),a));
  return {steering:THREE.MathUtils.lerp(at(i,7),at(j,7),a),brake:THREE.MathUtils.lerp(at(i,8),at(j,8),a),travel:THREE.MathUtils.lerp(at(i,9),at(j,9),a)};
}

/**
 * Records where the tyres lay rubber, using the same rules as the race view's
 * skid marks, so a take can show its drift marks again when played back.
 */
export class SkidRecorder {
  out:number[]=[];
  private last:(THREE.Vector3|undefined)[]=[];
  reset(){this.out=[];this.last=[];}
  step(sim:Simulation,tick:number){
    if(tireStress(sim)<.09){this.last=[];return;}
    for(let wheel=0;wheel<4;wheel++){
      if(wheel<2&&sim.brake<.35){this.last[wheel]=undefined;continue;}
      if(!sim.vehicle.wheelIsInContact(wheel)){this.last[wheel]=undefined;continue;}
      const contact=sim.vehicle.wheelContactPoint(wheel);if(!contact)continue;
      const point=new THREE.Vector3(contact.x,contact.y,contact.z);
      const floor=sim.visibleGroundAt(point);if(floor===undefined){this.last[wheel]=undefined;continue;}point.y=floor+.018;
      const previous=this.last[wheel];if(!previous){this.last[wheel]=point;continue;}
      const distance=point.distanceTo(previous);if(distance<.18)continue;
      this.last[wheel]=point;if(distance>5)continue;
      this.out.push(tick,...[previous.x,previous.y,previous.z,point.x,point.y,point.z].map(round));
    }
  }
}

/** Live physics car for the trailer tool, driven with the player's own key bindings. */
export class DriveSession {
  sim!:Simulation;
  travel=0;
  private keys=new Set<string>();
  private bindings=loadSettings().bindings;
  private accumulator=0;
  home?:Pose;
  private last=new THREE.Vector3();
  private queuedRespawn=false;private queuedFlip=false;
  onReset=()=>{};
  private constructor(readonly track:Track,readonly carId:CarId){}
  static async create(track:Track,carId:CarId,pose?:Pose) {
    await initPhysics(track);
    const session=new DriveSession(track,carId);
    session.home=pose;session.build(pose);
    addEventListener('keydown',session.keyDown);addEventListener('keyup',session.keyUp);addEventListener('blur',session.release);
    return session;
  }
  private build(pose?:Pose) {
    this.sim?.dispose();
    this.sim=new Simulation(this.track,this.carId);
    if(pose)this.place(pose);
    this.travel=0;this.accumulator=0;this.last.copy(this.sim.car.translation() as THREE.Vector3);
  }
  /** Drop the car at a saved pose, at rest. */
  place(pose:Pose) {
    const car=this.sim.car;
    car.setTranslation({x:pose.p[0],y:pose.p[1],z:pose.p[2]},true);
    car.setRotation({x:pose.q[0],y:pose.q[1],z:pose.q[2],w:pose.q[3]},true);
    car.setLinvel({x:0,y:0,z:0},true);car.setAngvel({x:0,y:0,z:0},true);
    this.last.copy(car.translation() as THREE.Vector3);this.travel=0;
  }
  /** Back to the circuit's start grid. */
  reset() {this.build(this.home);this.onReset();}
  private keyDown=(event:KeyboardEvent)=>{
    if((event.target as HTMLElement).closest?.('input,textarea,select'))return;
    const action=(Object.keys(this.bindings) as Action[]).find(a=>this.bindings[a].includes(event.code));
    if(!action)return;
    if(!['throttle','brake','left','right','drift','recover','flip','restart'].includes(action))return;
    event.preventDefault();this.keys.add(event.code);
    if(event.repeat)return;
    if(action==='recover')this.queuedRespawn=true;
    if(action==='flip')this.queuedFlip=true;
    if(action==='restart')this.reset();
  };
  private keyUp=(event:KeyboardEvent)=>{this.keys.delete(event.code);};
  private release=()=>this.keys.clear();
  private held(action:Action){return this.bindings[action].some(code=>this.keys.has(code));}
  private input() {
    let input=0;
    if(this.held('throttle'))input|=Input.Throttle;
    if(this.held('brake'))input|=Input.Brake;
    if(this.held('left'))input|=Input.Left;
    if(this.held('right'))input|=Input.Right;
    if(this.held('drift'))input|=Input.Drift;
    if(this.queuedRespawn)input|=Input.Respawn;
    if(this.queuedFlip)input|=Input.Flip;
    this.queuedRespawn=this.queuedFlip=false;
    return input;
  }
  /** Advance fixed physics ticks; `each` runs after every one. */
  advance(elapsed:number,each:(session:DriveSession)=>void) {
    this.accumulator+=Math.min(elapsed,.1);
    while(this.accumulator>=DT){
      this.sim.step(this.input());this.accumulator-=DT;
      const p=this.sim.car.translation(),q=this.sim.car.rotation();
      const forward=new THREE.Vector3(0,0,1).applyQuaternion(new THREE.Quaternion(q.x,q.y,q.z,q.w));
      const moved=new THREE.Vector3(p.x,p.y,p.z).sub(this.last).dot(forward);
      this.travel+=Math.abs(moved)<10?moved:0;this.last.set(p.x,p.y,p.z);
      each(this);
    }
  }
  pose():Pose {const p=this.sim.car.translation(),q=this.sim.car.rotation();return {p:[p.x,p.y,p.z],q:[q.x,q.y,q.z,q.w]};}
  /** Frame values for a Take. */
  frame():number[] {
    const p=this.sim.car.translation(),q=this.sim.car.rotation();
    return [p.x,p.y,p.z,q.x,q.y,q.z,q.w,this.sim.steering,this.sim.brake,this.travel].map(round);
  }
  get speedKmh(){return Math.round(this.sim.speed*this.track.metersPerUnit*3.6);}
  dispose() {
    removeEventListener('keydown',this.keyDown);removeEventListener('keyup',this.keyUp);removeEventListener('blur',this.release);
    this.sim.dispose();
  }
}
/** Default parking spot for a car with nothing placed, lined up behind the start line. */
export function defaultPose(track:Track,slot:number):Pose {
  const gate=spawnGate(track),side=new THREE.Vector3(gate.forward.z,0,-gate.forward.x),lane=slot%2?-3:3,back=Math.floor(slot/2)*-12;
  const p:[number,number,number]=[gate.position.x+gate.forward.x*(3+back)+side.x*lane,gate.position.y+.7,gate.position.z+gate.forward.z*(3+back)+side.z*lane];
  return {p,q:[gate.rotation.x,gate.rotation.y,gate.rotation.z,gate.rotation.w]};
}
