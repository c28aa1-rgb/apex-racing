import { CARS, type CarId } from '../shared/cars';
import { DT, Input, Simulation, rotate } from '../shared/physics';
import { TRACKS, type Track } from '../shared/tracks';

export const MPH = .44704;
export const DEG = 180 / Math.PI;
export function handlingTrack(): Track {
  const gate = {position:{x:0,y:0,z:0},forward:{x:0,y:0,z:1},rotation:{x:0,y:0,z:0,w:1},width:6000,segment:0};
  return {...TRACKS[0],id:'handling-pad',collision:undefined,model:undefined,spawn:undefined,mapPath:undefined,metersPerUnit:1,
    start:gate,checkpoints:[],finish:{...gate,position:{x:0,y:0,z:7500}},
    segments:[{id:'pad',next:null,start:{x:0,y:0,z:-2000},end:{x:0,y:0,z:8000},width:6000,surface:'road',rails:false}]};
}
export function telemetry(sim: Simulation) {
  const p=sim.car.translation(),q=sim.car.rotation(),v=sim.car.linvel(),w=sim.car.angvel();
  const side=rotate(q,{x:1,y:0,z:0}),front=rotate(q,{x:0,y:0,z:1}),up=rotate(q,{x:0,y:1,z:0});
  const lateral=v.x*side.x+v.y*side.y+v.z*side.z,forward=v.x*front.x+v.y*front.y+v.z*front.z;
  const yawRate=w.x*up.x+w.y*up.y+w.z*up.z,half=sim.carSpec.dimensions.wheelbaseM/2;
  return {t:sim.timeMs/1000,x:p.x,y:p.y,z:p.z,vx:v.x,vy:v.y,vz:v.z,speed:Math.hypot(v.x,v.z),
    forward,lateral,slip:Math.atan2(lateral,Math.max(.1,Math.abs(forward)))*DEG,
    yaw:Math.atan2(front.x,front.z)*DEG,yawRate:yawRate*DEG,steer:sim.steering*DEG,up:up.y,
    frontLateral:lateral+yawRate*half,rearLateral:lateral-yawRate*half,
    contacts:[0,1,2,3].filter(i=>sim.vehicle.wheelIsInContact(i)).length,drift:sim.autoDrift};
}
export type Maneuver = keyof typeof MANEUVERS;
export const MANEUVERS = {
  coast: (_:number)=>0,
  throttle: (_:number)=>Input.Throttle,
  left: (_:number)=>Input.Left,
  right: (_:number)=>Input.Right,
  'power-left': (_:number)=>Input.Throttle|Input.Left,
  brake: (_:number)=>Input.Brake,
  'brake-left': (_:number)=>Input.Brake|Input.Left,
  release: (t:number)=>t<1.5?Input.Left:0,
  reversal: (t:number)=>t<1.5?Input.Left:Input.Right,
  slalom: (t:number)=> (Math.floor(t/.75)%2?Input.Right:Input.Left)|Input.Throttle,
  'both-pedals': (_:number)=>Input.Throttle|Input.Brake,
};
export function runManeuver(carId:CarId,mph:number,maneuver:Maneuver,seconds=5,strength=1.1,manualDrift=false) {
  const sim=new Simulation(handlingTrack(),carId);sim.steeringStrength=strength;
  try {
    for(let i=0;i<30;i++)sim.step(0);
    sim.car.setLinvel({x:0,y:0,z:mph*MPH},true);
    const start=telemetry(sim),samples=[start];let previous=start,maxG=0,maxSlipStep=0,maxSpeedGain=0,airTicks=0,maxYaw=0,minUp=1,stoppingDistance:number|null=null,distance=0;
    for(let i=0;i<seconds/DT;i++) {
      sim.step(MANEUVERS[maneuver](i*DT)|(manualDrift?Input.Drift:0));const s=telemetry(sim);
      maxG=Math.max(maxG,Math.hypot(s.vx-previous.vx,s.vz-previous.vz)/DT/9.81);
      if(previous.speed>5&&s.speed>5)maxSlipStep=Math.max(maxSlipStep,Math.abs(s.slip-previous.slip));
      maxSpeedGain=Math.max(maxSpeedGain,s.speed-previous.speed);
      maxYaw=Math.max(maxYaw,Math.abs(s.yawRate));minUp=Math.min(minUp,s.up);if(s.contacts===0)airTicks++;
      distance+=Math.hypot(s.x-previous.x,s.z-previous.z);
      if(stoppingDistance===null&&mph>0&&s.forward<.5)stoppingDistance=distance;
      if(i%3===2)samples.push(s);previous=s;
    }
    return {carId,mph,maneuver,manualDrift,maxG,maxSlipStep,maxSpeedGain,airTicks,maxYaw,minUp,stoppingDistance,
      displacement:Math.hypot(previous.x-start.x,previous.z-start.z),maxSlip:Math.max(...samples.filter(s=>s.speed>5).map(s=>Math.abs(s.slip)),0),
      final:previous,samples};
  } finally { sim.dispose(); }
}
export function performanceRun(carId:CarId) {
  const sim=new Simulation(handlingTrack(),carId);let sixty:number|null=null;
  try {
    for(let i=0;i<3600;i++){sim.step(Input.Throttle);if(sixty===null&&sim.speed>=60*MPH)sixty=(i+1)*DT;}
    const topMph=sim.speed/MPH;
    sim.car.setLinvel({x:0,y:0,z:60*MPH},true);sim.car.setAngvel({x:0,y:0,z:0},true);sim.car.setRotation({x:0,y:0,z:0,w:1},true);
    let feet=0,previous={...sim.car.translation()},stopTime:number|null=null;
    for(let i=0;i<600;i++){sim.step(Input.Brake);const p=sim.car.translation();feet+=Math.hypot(p.x-previous.x,p.z-previous.z)*3.28084;previous={...p};if(sim.forwardSpeed<.5){stopTime=(i+1)*DT;break;}}
    return {carId,sixty,topMph,brakeFeet:feet,stopTime,nominalMph:CARS.find(c=>c.id===carId)!.physics.topSpeedKph/1.609344};
  }finally{sim.dispose();}
}
