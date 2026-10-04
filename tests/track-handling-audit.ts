import { writeFile, mkdir } from 'node:fs/promises';
import { CARS } from '../shared/cars';
import { Input, Simulation, initPhysics, rotate, PHYSICS_VERSION } from '../shared/physics';
import { TRACKS, trackById } from '../shared/tracks';
import { MPH, telemetry } from './handling-harness';
import { driveTrack } from './driver';
import { applyStartPlacement, applyFinishPlacement, applyRoadWidthOverrides } from '../src/dev-spawns';

await initPhysics();
const saved=process.argv.includes('--saved');
if(saved){
  const response=await fetch('http://127.0.0.1:3001/api/dev-circuit-config');
  if(!response.ok)throw new Error('Could not read the saved circuit placements');
  const config=await response.json();
  for(const track of TRACKS){applyStartPlacement(track,config.starts?.[track.id]);applyFinishPlacement(track,config.finishes?.[track.id]);applyRoadWidthOverrides(track,config.roads?.[track.id]);track.mapPath=config.maps?.[track.id];}
}
const results=[];
for(const track of TRACKS){
  await initPhysics(track);
  for(const car of CARS){
    const sim=new Simulation(track,car.id);
    try{
      const parked=telemetry(sim);
      for(let i=0;i<120;i++)sim.step(i%60<30?Input.Left:Input.Right);
      const idle=telemetry(sim);sim.respawn();
      for(let i=0;i<180;i++)sim.step(Input.Throttle);
      const launch=telemetry(sim);
      const forward=rotate(sim.car.rotation(),{x:0,y:0,z:1});
      sim.car.setLinvel({x:forward.x*100*MPH/track.metersPerUnit,y:0,z:forward.z*100*MPH/track.metersPerUnit},true);
      let previous=telemetry(sim),maxG=0,minimumContacts=4;
      for(let i=0;i<60;i++){
        sim.step(i<30?Input.Throttle:Input.Brake);const current=telemetry(sim);
        maxG=Math.max(maxG,Math.hypot(current.vx-previous.vx,current.vz-previous.vz)*60*track.metersPerUnit/9.81);
        minimumContacts=Math.min(minimumContacts,current.contacts);previous=current;
      }
      results.push({track:track.id,car:car.id,idleTravel:Math.hypot(idle.x-parked.x,idle.z-parked.z),launchMph:launch.speed*track.metersPerUnit/MPH,maxG,minimumContacts,final:previous});
    }finally{sim.dispose();}
  }
  console.log(`Checked ${track.name} with all nine cars`);
}
const track=trackById('indianapolis')!,sim=new Simulation(track);
const contactProbe=[];
try{
  sim.car.setTranslation({x:-510,y:11.4,z:350},true);
  sim.car.setRotation({x:0,y:Math.SQRT1_2,z:0,w:Math.SQRT1_2},true);
  for(let i=0;i<480;i++){
    sim.step(Input.Throttle);
    if(i%30===0)contactProbe.push({...telemetry(sim),floor:sim.visibleGroundAt(sim.car.translation())});
    if(i>150&&sim.speed<1){
      sim.world.contactPairsWith(sim.car.collider(0),c=>{
        sim.world.contactPair(sim.car.collider(0),c,m=>{
          if(m.numSolverContacts()) console.log('Chassis contact',JSON.stringify({normal:m.normal(),points:Array.from({length:m.numSolverContacts()},(_,j)=>({p:m.solverContactPoint(j),depth:m.solverContactDist(j)}))}));
        });
      });break;
    }
  }
}finally{sim.dispose();}
const lap=saved?undefined:driveTrack(track);
await mkdir('work/physics-audit',{recursive:true});
await writeFile(`work/physics-audit/tracks-${saved?'saved-':''}${PHYSICS_VERSION}.json`,JSON.stringify({results,contactProbe,lap}));
console.table(results.filter(r=>r.maxG>4||r.idleTravel>.04||r.minimumContacts<3).map(({final,...r})=>r));
if(lap)console.log('Indianapolis lap',{finished:lap.finished,respawns:lap.respawns,position:lap.position});
