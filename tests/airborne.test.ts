import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { CARS } from '../shared/cars';
import { initPhysics, Simulation, DT } from '../shared/physics';
import { handlingTrack } from './handling-harness';

before(()=>initPhysics());
for(const car of CARS)test(`${car.shortName}: suspension allows takeoff, free fall and landing`,()=>{
  const sim=new Simulation(handlingTrack(),car.id);
  try{
    for(let tick=0;tick<60;tick++)sim.step(0);
    const initialY=sim.car.translation().y;
    assert.equal([0,1,2,3].filter(i=>sim.vehicle.wheelIsInContact(i)).length,4);
    // Start on the floor, not teleported into the air: smoothing must allow the
    // existing upward impulse through the first still-contacted takeoff ticks.
    sim.car.setLinvel({x:0,y:6,z:0},true);
    let peak=initialY,airTicks=0,ballisticTicks=0,landed=false;
    for(let tick=0;tick<180;tick++){
      const wasAirborne=!sim.grounded,previousVy=sim.car.linvel().y;
      sim.step(0);
      const contacts=[0,1,2,3].filter(i=>sim.vehicle.wheelIsInContact(i)).length;
      peak=Math.max(peak,sim.car.translation().y);
      if(!contacts){
        airTicks++;
        if(wasAirborne){
          const acceleration=(sim.car.linvel().y-previousVy)/DT;
          assert.ok(acceleration < -20 && acceleration > -24,`${car.id}: air motion was constrained (${acceleration})`);
          ballisticTicks++;
        }
      }else if(airTicks&&contacts===4)landed=true;
    }
    assert.ok(peak-initialY>.5,`${car.id}: smoothing cancelled takeoff`);
    assert.ok(airTicks>=15&&ballisticTicks>=10,`${car.id}: wheels stayed attached to the ground`);
    assert.ok(landed,`${car.id}: did not regain wheel support`);
    assert.equal(sim.respawns,0);
    assert.ok(Math.abs(sim.car.translation().y-initialY)<.05,`${car.id}: suspension did not settle after landing`);
  }finally{sim.dispose();}
});
