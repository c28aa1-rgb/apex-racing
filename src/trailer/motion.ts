import { MathUtils } from 'three';

export type CarMotion={speed:number;endSpeed:number;offset:number;lane:number;endLane:number;direction:1|-1;delay:number};
export function defaultGhostMotion():CarMotion[] {
  return [
    {speed:64,endSpeed:72,offset:0,lane:1.5,endLane:1.5,direction:1,delay:0},
    {speed:70,endSpeed:78,offset:-12,lane:-1.5,endLane:-1.5,direction:1,delay:0},
    {speed:58,endSpeed:67,offset:-27,lane:1.5,endLane:1.5,direction:1,delay:.2},
    {speed:74,endSpeed:80,offset:-42,lane:-1.5,endLane:-1.5,direction:1,delay:.4},
  ];
}
/** Integrate a linear speed ramp analytically; frame rate never changes a take. */
export function motionAt(motion:CarMotion,time:number,duration:number) {
  const active=Math.max(0,time-motion.delay),span=Math.max(.01,duration-motion.delay),u=MathUtils.clamp(active/span,0,1);
  const from=motion.speed/3.6,to=motion.endSpeed/3.6;
  const distance=(from*active+(to-from)*Math.min(active,span)**2/(2*span)+(active>span?(to-from)*(active-span):0))*motion.direction;
  return {distance,position:motion.offset+distance,lane:MathUtils.lerp(motion.lane,motion.endLane,MathUtils.smoothstep(u,.1,.8)),speed:time<motion.delay?0:MathUtils.lerp(from,to,u)};
}
