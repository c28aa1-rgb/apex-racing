import { Input, Simulation, MAX_TICKS, PHYSICS_VERSION, rotate, type RunOrigin } from '../shared/physics';
import { type Track } from '../shared/tracks';
import type { Run } from '../shared/replay';
import { DEFAULT_CAR, type CarId } from '../shared/cars';

// Test-only driver. Follows the authored centerline with actual keyboard inputs.
// It neither moves the rigid body directly nor bypasses checkpoints.
export function driveTrack(track: Track, carId:CarId=DEFAULT_CAR.id, origin?: RunOrigin, onTick?: (sim: Simulation) => void): {run:Run;finished:boolean;respawns:number;position:unknown;debug?:unknown} {
  const sim=new Simulation(track,carId,origin);const inputs:number[]=[];let segment=0,respawns=0,stuck=0,recover=0,recoveries=0;
  while(!sim.finished&&sim.ticks<MAX_TICKS){
    const p=sim.car.translation();
    let s=track.segments[segment],dx=s.end.x-s.start.x,dz=s.end.z-s.start.z,len=Math.hypot(dx,dz);
    let along=((p.x-s.start.x)*dx+(p.z-s.start.z)*dz)/len;
    while(along>len-1&&segment<track.segments.length-1){
      s=track.segments[++segment];dx=s.end.x-s.start.x;dz=s.end.z-s.start.z;len=Math.hypot(dx,dz);
      along=((p.x-s.start.x)*dx+(p.z-s.start.z)*dz)/len;
    }
    const look=Math.min(sim.speed*.4+6,Math.max(3,len*.35));let idx=segment;
    let distance=Math.max(0,along)+look,target=s.end;
    for(let j=0;j<5;j++){
      const seg=track.segments[idx],length=Math.hypot(seg.end.x-seg.start.x,seg.end.z-seg.start.z);
      if(distance<=length||idx===track.segments.length-1){const t=Math.min(distance/length,1);target={x:seg.start.x+(seg.end.x-seg.start.x)*t,y:seg.start.y,z:seg.start.z+(seg.end.z-seg.start.z)*t};break;}
      distance-=length;idx++;
    }
    const q=sim.car.rotation();const yaw=Math.atan2(2*(q.w*q.y+q.x*q.z),1-2*(q.y*q.y+q.x*q.x));
    let error=Math.atan2(target.x-p.x,target.z-p.z)-yaw;
    while(error>Math.PI)error-=Math.PI*2;while(error< -Math.PI)error+=Math.PI*2;
    let targetSpeed=Math.abs(error)>.2?11:Math.abs(error)>.08?22:42;
    // Brake before short bends; a target beyond the bend otherwise cuts straight
    // through a chicane. Recompute progress after advancing to the next segment.
    let remaining=Math.max(0,len-along);
    for(let j=segment;j<Math.min(segment+6,track.segments.length-1);j++){
      const a=track.segments[j],b=track.segments[j+1];
      const al=Math.hypot(a.end.x-a.start.x,a.end.z-a.start.z),bl=Math.hypot(b.end.x-b.start.x,b.end.z-b.start.z);
      const angle=Math.acos(Math.max(-1,Math.min(1,((a.end.x-a.start.x)*(b.end.x-b.start.x)+(a.end.z-a.start.z)*(b.end.z-b.start.z))/(al*bl))));
      const cornerSpeed=Math.sqrt(3*Math.min(al,bl)*track.metersPerUnit/Math.max(.01,angle));
      targetSpeed=Math.min(targetSpeed,Math.sqrt(cornerSpeed*cornerSpeed+2*5*remaining*track.metersPerUnit));
      remaining+=bl;
    }
    let input=sim.speed<targetSpeed/track.metersPerUnit?Input.Throttle:sim.speed>(targetSpeed+2)/track.metersPerUnit?Input.Brake:0;
    const up=rotate(q,{x:0,y:1,z:0}),angular=sim.car.angvel();
    const yawRate=angular.x*up.x+angular.y*up.y+angular.z*up.z;
    const correction=error-yawRate*.35;
    if(correction>.025)input|=Input.Left;else if(correction<-.025)input|=Input.Right;
    stuck=sim.speed*track.metersPerUnit<.7?stuck+1:0;
    if(stuck>100&&!sim.grounded){input=Input.Flip;stuck=0;}
    else if(stuck>150){recover=90;recoveries++;stuck=0;}
    if(recover>0){
      input=Input.Brake|(error>0?Input.Right:Input.Left);recover--;
    } else if(recoveries>2&&sim.speed*track.metersPerUnit<.5){
      input=Input.Respawn;recoveries=0;
    }
    inputs.push(input);sim.step(input);onTick?.(sim);
    if(sim.respawns!==respawns){respawns=sim.respawns;segment=sim.checkpoint?track.checkpoints[sim.checkpoint-1].segment:0;}
  }
  const result={run:{trackId:track.id,trackVersion:track.version,physicsVersion:PHYSICS_VERSION,carId,timeMs:sim.timeMs,inputs,...(origin?{origin}:{})} satisfies Run,finished:sim.finished,respawns:sim.respawns,position:sim.frame().p};sim.dispose();return result;
}
