import test from 'node:test';
import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import { initPhysics, Input, Simulation } from '../shared/physics';
import { FinishDriver } from '../src/finish-driver';
import { handlingTrack } from './handling-harness';
import { TRACKS } from '../shared/tracks';
import { RACING_LINES } from '../shared/racing-lines';
import { racingLine } from '../shared/racing-line';

test('finish autopilot immediately slows and centers the real car without changing the scored run',async()=>{
  await initPhysics();const track=handlingTrack();track.mapPath=[{x:0,y:0,z:-100},{x:0,y:0,z:1500},{x:500,y:0,z:1500},{x:500,y:0,z:-100},{x:0,y:0,z:-100}];
  const sim=new Simulation(track),driver=new FinishDriver(track);
  try{
    sim.car.setTranslation({...sim.car.translation(),x:3},true);sim.car.setLinvel({x:0,y:0,z:65},true);sim.finished=true;sim.ticks=1234;
    const collider=sim.car.collider(0).handle;driver.begin(sim);
    driver.step(sim);assert.ok(sim.brake>0,'braking starts on the first finish tick');
    for(let i=1;i<300;i++){sim.step(Input.Brake|Input.Right|Input.Respawn);driver.step(sim);}
    assert.equal(sim.ticks,1234);assert.equal(sim.finishTicks,300);assert.equal(sim.respawns,0);assert.deepEqual(sim.splits,[]);
    assert.ok(sim.speed>14&&sim.speed<21,`safe cruise speed: ${sim.speed}`);assert.ok(Math.abs(sim.car.translation().x)<.5);assert.ok(sim.car.translation().z>100);
    assert.equal(sim.car.collider(0).handle,collider);assert.ok(sim.grounded);
    sim.world.createCollider(RAPIER.ColliderDesc.cuboid(20,4,.5).setTranslation(0,4,sim.car.translation().z+30));
    const wall=sim.car.translation().z+30;
    for(let i=0;i<180;i++)sim.stepFinish(0,65);
    assert.ok(sim.car.translation().z<wall,'the solid chassis cannot drive through a wall');assert.ok(sim.car.translation().y>0,'ground collision remains active');
  }finally{sim.dispose();}
});

test('fast, offset finishes settle onto every imported circuit without wall impacts',async t=>{
  for(const [carId,crossingSpeed] of [['porsche-911-gt3',65],['red-bull-rb19',90]] as const)
  for(const track of TRACKS)await t.test(`${track.id} ${carId}`,async()=>{
    await initPhysics(track);
    const line=racingLine(RACING_LINES[track.id],track.metersPerUnit);
    const path=Array.from({length:line.n},(_,i)=>({x:line.x[i],y:line.y[i],z:line.z[i]}));
    const sim=new Simulation(track,carId),driver=new FinishDriver(track,path),gate=track.finish;
    try{
      const p={x:gate.position.x+gate.forward.z*2/track.metersPerUnit,y:gate.position.y,z:gate.position.z-gate.forward.x*2/track.metersPerUnit};
      sim.car.setTranslation({...p,y:(sim.roadHeightAt(p)??p.y)+1},true);sim.car.setRotation(gate.rotation,true);
      for(let i=0;i<60;i++)sim.step(0);
      sim.car.setLinvel({x:gate.forward.x*crossingSpeed/track.metersPerUnit,y:0,z:gate.forward.z*crossingSpeed/track.metersPerUnit},true);
      sim.finished=true;driver.begin(sim);const ticks=sim.ticks,hits=sim.hitCount;let grounded=0;
      for(let i=0;i<1800;i++){driver.step(sim);grounded+=Number(sim.grounded);}
      const speed=sim.speed*track.metersPerUnit;
      t.diagnostic(JSON.stringify({track:track.id,carId,speed,hits:sim.hitCount-hits,grounded}));
      assert.equal(sim.ticks,ticks);assert.equal(sim.hitCount,hits,'post-finish driving must avoid walls');
      assert.ok(speed>5&&speed<22,'continues at a controlled speed');assert.ok(grounded>1710,'stays planted on the circuit');
      assert.notEqual(sim.roadHeightAt(sim.car.translation()),undefined,'rejoins asphalt');
    }finally{sim.dispose();}
  });
});

test('finish-only physics cannot advance an unfinished race',async()=>{
  await initPhysics();const sim=new Simulation(handlingTrack());
  try{const frame=sim.frame();sim.stepFinish(.3,50);assert.deepEqual(sim.frame(),frame);assert.equal(sim.finishTicks,0);}finally{sim.dispose();}
});
