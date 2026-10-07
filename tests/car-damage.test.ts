import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CAR } from '../shared/cars';
import { initPhysics, Simulation, Input } from '../shared/physics';
import { DamageState, hitSeverity, MAX_DENTS } from '../src/car-damage';
import { handlingTrack } from './handling-harness';

before(()=>initPhysics());

test('impact severity scales with the speed change and is softer for car contact',()=>{
  assert.equal(hitSeverity(2,false),0);
  assert.ok(hitSeverity(6,false)>0&&hitSeverity(6,false)<.25,'a bump is light');
  assert.equal(hitSeverity(30,false),1);
  assert.ok(hitSeverity(14,true)<hitSeverity(14,false));
});

test('damage accumulates, caps at 1 and resets',()=>{
  const state=new DamageState(),push={x:0,y:0,z:-1};
  state.hit({x:0,y:0,z:2},push,.5);
  assert.ok(state.damage>.2&&state.damage<.3);
  for(let i=0;i<10;i++)state.hit({x:i,y:0,z:0},push,1);
  assert.equal(state.damage,1);
  state.reset();
  assert.equal(state.damage,0);assert.equal(state.dents.length,0);assert.deepEqual(state.scrape,[0,0]);
});

test('dents use a ring buffer, and repeat hits deepen the same dent',()=>{
  const state=new DamageState(),push={x:-1,y:0,z:0};
  state.hit({x:1,y:0,z:0},push,.5);state.hit({x:1,y:0,z:.05},push,.5);
  assert.equal(state.dents.length,1,'a hit on the same spot deepens the dent');
  const deeper=state.dents[0].depth;
  assert.ok(deeper>.025+.085*.5);
  for(let i=0;i<10;i++){state.hit({x:1,y:0,z:-2+i*1.5},push,.4);state.hit({x:1,y:0,z:-2+i*1.5},push,.4);}
  assert.equal(state.dents.length,MAX_DENTS);
  for(const dent of state.dents){assert.ok(dent.depth<=.15);assert.ok(dent.radius<=.75);}
  state.hit({x:9,y:9,z:9},push,.05);
  assert.ok(!state.dents.some(d=>d.centre.x===9),'scuffs too light to dent leave the dents alone');
});

test('wall scrapes wear the touching flank only',()=>{
  const state=new DamageState();
  state.rub(1,25,2);
  assert.equal(state.scrape[0],0);assert.ok(state.scrape[1]>.3);
  state.rub(-1,2,5);
  assert.equal(state.scrape[0],0,'crawling along a wall does not scratch');
});

test('a counted hit reports the direction toward what the car struck',()=>{
  const sim=new Simulation(handlingTrack(),DEFAULT_CAR.id);
  try{
    const p=sim.car.translation(),q=sim.car.rotation();
    sim.setObstacle('other',DEFAULT_CAR.id,{p:{x:p.x,y:p.y,z:p.z+12},q});
    for(let tick=0;tick<420&&sim.hitCount===0;tick++)sim.step(Input.Throttle);
    assert.equal(sim.hitCount,1);
    const n=sim.lastHitNormal;
    assert.ok(Math.abs(Math.hypot(n.x,n.y,n.z)-1)<1e-3,'unit length');
    assert.ok(n.z>.7,`the obstacle was dead ahead, normal ${JSON.stringify(n)}`);
  }finally{sim.dispose();}
});
