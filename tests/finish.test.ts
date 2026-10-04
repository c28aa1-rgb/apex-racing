import test from 'node:test';
import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import { initPhysics, Input, Simulation } from '../shared/physics';
import { FinishDriver } from '../src/finish-driver';
import { handlingTrack } from './handling-harness';

test('finish autopilot keeps speed and centers the real car without changing the scored run',async()=>{
  await initPhysics();const track=handlingTrack();track.mapPath=[{x:0,y:0,z:-100},{x:0,y:0,z:1500},{x:500,y:0,z:1500},{x:500,y:0,z:-100},{x:0,y:0,z:-100}];
  const sim=new Simulation(track),driver=new FinishDriver(track);
  try{
    sim.car.setTranslation({...sim.car.translation(),x:3},true);sim.car.setLinvel({x:0,y:0,z:65},true);sim.finished=true;sim.ticks=1234;
    const collider=sim.car.collider(0).handle;driver.begin(sim);
    for(let i=0;i<300;i++){sim.step(Input.Brake|Input.Right|Input.Respawn);driver.step(sim);}
    assert.equal(sim.ticks,1234);assert.equal(sim.finishTicks,300);assert.equal(sim.respawns,0);assert.deepEqual(sim.splits,[]);
    assert.ok(sim.speed>62&&sim.speed<68);assert.ok(Math.abs(sim.car.translation().x)<.5);assert.ok(sim.car.translation().z>310);
    assert.equal(sim.car.collider(0).handle,collider);assert.ok(sim.grounded);
    sim.world.createCollider(RAPIER.ColliderDesc.cuboid(20,4,.5).setTranslation(0,4,sim.car.translation().z+30));
    const wall=sim.car.translation().z+30;
    for(let i=0;i<180;i++)sim.stepFinish(0,65);
    assert.ok(sim.car.translation().z<wall,'the solid chassis cannot drive through a wall');assert.ok(sim.car.translation().y>0,'ground collision remains active');
  }finally{sim.dispose();}
});

test('finish-only physics cannot advance an unfinished race',async()=>{
  await initPhysics();const sim=new Simulation(handlingTrack());
  try{const frame=sim.frame();sim.stepFinish(.3,50);assert.deepEqual(sim.frame(),frame);assert.equal(sim.finishTicks,0);}finally{sim.dispose();}
});
