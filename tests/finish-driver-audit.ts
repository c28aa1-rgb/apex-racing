import assert from 'node:assert/strict';
import { TRACKS } from '../shared/tracks';
import { initPhysics, Simulation } from '../shared/physics';
import { FinishDriver } from '../src/finish-driver';
import { applyStartPlacement, applyFinishPlacement, applyRoadWidthOverrides } from '../src/dev-spawns';

const config=await (await fetch('http://127.0.0.1:3001/api/dev-circuit-config')).json();
for(const track of TRACKS){
  applyStartPlacement(track,config.starts?.[track.id]);applyFinishPlacement(track,config.finishes?.[track.id]);applyRoadWidthOverrides(track,config.roads?.[track.id]);track.mapPath=config.maps?.[track.id];
  await initPhysics(track);
  const sim=new Simulation(track),gate=track.finish;
  sim.car.setTranslation({...gate.position,y:(sim.roadHeightAt(gate.position)??gate.position.y)+1},true);sim.car.setRotation(gate.rotation,true);
  for(let i=0;i<60;i++)sim.step(0);
  sim.car.setLinvel({x:gate.forward.x*35,y:0,z:gate.forward.z*35},true);sim.finished=true;
  const driver=new FinishDriver(track);driver.begin(sim);const time=sim.timeMs,collider=sim.car.collider(0).handle,start=sim.car.translation();
  let minHeight=Infinity,maxError=0,grounded=0;
  const steps=process.argv.includes('--long')?1800:600;
  for(let i=0;i<steps;i++){
    driver.step(sim);const p=sim.car.translation();minHeight=Math.min(minHeight,p.y-(sim.roadHeightAt(p)??p.y));grounded+=Number(sim.grounded);
    let error=Infinity;for(let j=0;j<driver.route.length;j++){const a=driver.route[j],b=driver.route[(j+1)%driver.route.length],dx=b.x-a.x,dz=b.z-a.z,t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.z-a.z)*dz)/(dx*dx+dz*dz||1)));error=Math.min(error,Math.hypot(p.x-a.x-dx*t,p.z-a.z-dz*t));}maxError=Math.max(error,maxError);
  }
  const result={track:track.id,map:track.mapPath?.length,speed:sim.speed,position:sim.car.translation(),travel:Math.hypot(sim.car.translation().x-start.x,sim.car.translation().z-start.z),minHeight,maxError,grounded};console.log(result);
  assert.equal(sim.timeMs,time);assert.equal(sim.car.collider(0).handle,collider);assert.equal(sim.car.collider(0).isSensor(),false);
  assert.ok(sim.speed>8,`${track.id} must keep driving`);assert.ok(minHeight>-.3,`${track.id} below road`);assert.ok(grounded>steps*.95,`${track.id} lost wheel contact`);
  if(track.mapPath||!track.localFinish)assert.ok(maxError<8,`${track.id} left center lane`);
  sim.dispose();
}
