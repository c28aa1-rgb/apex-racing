import * as THREE from 'three';
import { buildRoadMesh } from '../../shared/road';
import type { Track, Vec3 } from '../../shared/tracks';

export const SHOTS = [
  { id:'pit', name:'01 / Low tracking', duration:4, hour:13, city:false },
  { id:'grid', name:'02 / Starting grid', duration:4, hour:13, city:false },
  { id:'launch', name:'03 / Launch sweep', duration:4, hour:18, city:false },
  { id:'curb', name:'04 / Curb drift', duration:4, hour:22, city:true },
  { id:'drone', name:'05 / Pack chase', duration:6, hour:22, city:true },
  { id:'wheel', name:'06 / Wheel close-up', duration:4, hour:18, city:true },
  { id:'overtake', name:'07 / Barrier overtake', duration:6, hour:22, city:true },
  { id:'finish', name:'08 / Finish orbit', duration:5, hour:22, city:false },
] as const;
export type ShotId = typeof SHOTS[number]['id'];

/** Sample by distance so scrubbing and replay produce identical actor poses. */
export class ShotRoad {
  readonly points:{center:Vec3;forward:Vec3;distance:number;width:number}[];
  readonly length:number;
  readonly recorded:boolean;
  readonly closed:boolean;
  constructor(track:Track,path?:Vec3[]) {
    this.recorded=!!path;
    if(path){
      const clean=path.filter((p,i)=>!i||Math.hypot(p.x-path[i-1].x,p.y-path[i-1].y,p.z-path[i-1].z)>.05);
      if(clean.length<2)throw new Error('The recorded route is too short.');
      let distance=0;
      this.points=clean.map((p,i)=>{
        if(i){const prev=clean[i-1],gap=Math.hypot(p.x-prev.x,p.y-prev.y,p.z-prev.z);if(gap>100)throw new Error('The recorded route contains a jump. Record a continuous drive.');distance+=gap;}
        const before=clean[Math.max(0,i-1)],after=clean[Math.min(clean.length-1,i+1)];
        const forward=new THREE.Vector3(after.x-before.x,0,after.z-before.z).normalize();
        return {center:p,forward,distance,width:12};
      });
    }else this.points=buildRoadMesh(track).points;
    const first=this.points[0].center,last=this.points.at(-1)!.center;
    const gap=Math.hypot(first.x-last.x,first.y-last.y,first.z-last.z);
    this.closed=this.points.at(-1)!.distance>100&&gap<3;
    if(this.closed){
      if(gap>.001)this.points.push({...this.points[0],distance:this.points.at(-1)!.distance+gap});
      const before=this.points.at(-2)!.center,after=this.points[1].center;
      const forward=new THREE.Vector3(after.x-before.x,0,after.z-before.z).normalize();
      this.points[0].forward=forward;this.points.at(-1)!.forward=forward;
    }
    this.length=this.points.at(-1)!.distance;
  }
  sample(distance:number,lane=0) {
    const d=this.closed?THREE.MathUtils.euclideanModulo(distance,this.length):THREE.MathUtils.clamp(distance,0,this.length-.001);
    let lo=0,hi=this.points.length-1;
    while(lo+1<hi){const mid=(lo+hi)>>1;if(this.points[mid].distance<=d)lo=mid;else hi=mid;}
    const a=this.points[lo],b=this.points[hi],t=(d-a.distance)/(b.distance-a.distance);
    const forward=new THREE.Vector3().copy(a.forward).lerp(b.forward,t).normalize();
    const right=new THREE.Vector3(forward.z,0,-forward.x);
    const width=THREE.MathUtils.lerp(a.width,b.width,t);
    const position=new THREE.Vector3().copy(a.center).lerp(b.center,t).addScaledVector(right,THREE.MathUtils.clamp(lane,-width/2+1.4,width/2-1.4));
    return {position,forward,right};
  }
}

export function actorTravel(shot:ShotId,time:number,index:number) {
  if(shot==='pit'||shot==='grid')return 0;
  if(shot==='launch')return 2.4*time*time;
  if(shot==='finish')return time*5;
  return time*(shot==='wheel'?12:18)+(shot==='overtake'&&index===1?time*4-8:0);
}
