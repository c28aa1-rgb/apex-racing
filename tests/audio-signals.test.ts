import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CAR } from '../shared/cars';
import { initPhysics, Simulation, Input } from '../shared/physics';
import { handlingTrack } from './handling-harness';

before(()=>initPhysics());

test('driving on the pad reports road under all wheels and no false hits',()=>{
  const sim=new Simulation(handlingTrack(),DEFAULT_CAR.id);
  try{
    for(let tick=0;tick<240;tick++)sim.step(Input.Throttle);
    assert.deepEqual(sim.wheelSurface,[0,0,0,0]);
    assert.equal(sim.hitCount,0);
    assert.equal(sim.wallContact,false);
    assert.ok(sim.suspensionJolt<.01,`smooth road should not read as a kerb (jolt ${sim.suspensionJolt})`);
  }finally{sim.dispose();}
});

test('hitting another car registers one hit, flagged as a car, then a sustained contact',()=>{
  const sim=new Simulation(handlingTrack(),DEFAULT_CAR.id);
  try{
    const p=sim.car.translation(),q=sim.car.rotation();
    // Park a solid car 12 m ahead, in the lane the player is driving down.
    sim.setObstacle('other',DEFAULT_CAR.id,{p:{x:p.x,y:p.y,z:p.z+12},q});
    let hits=0,peak=0,touched=0;
    for(let tick=0;tick<420;tick++){
      const before=sim.hitCount;sim.step(Input.Throttle);
      if(sim.hitCount>before)hits+=sim.hitCount-before;
      peak=Math.max(peak,sim.wallSpeed);if(sim.wallContact)touched++;
    }
    assert.equal(hits,1,'a head-on hit counts once, however many ticks the contact lasts');
    assert.equal(sim.lastHitWithCar,true);
    assert.ok(sim.lastHitSpeed>3&&sim.lastHitSpeed<40,`impact speed change ${sim.lastHitSpeed} m/s`);
    assert.ok(touched>20,'pressing against the car keeps reporting contact for scrape sounds');
  }finally{sim.dispose();}
});
