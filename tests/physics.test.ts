import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { initPhysics, Simulation, Input, MAX_TICKS, PHYSICS_VERSION, rotate } from '../shared/physics';
import { TRACKS, formatTime, medalFor, trackById } from '../shared/tracks';
import { buildRoadMesh } from '../shared/road';
import { runSchema, validateReplay } from '../shared/replay';
import { CARS } from '../shared/cars';
import { driveTrack } from './driver';
import RAPIER from '@dimforge/rapier3d-compat';
import { handlingTrack } from './handling-harness';

before(()=>initPhysics());
test('fallback route ribbons remain continuous with upward-facing geometry',()=>{
  for(const track of TRACKS){
    const copy=JSON.parse(JSON.stringify(track));assert.deepEqual(copy,track);
    assert.ok(track.model&&track.collision);assert.ok(track.length>1000);assert.ok(track.metersPerUnit>.5&&track.metersPerUnit<1.5);
    for(let i=0;i<track.segments.length;i++)assert.equal(track.segments[i].next,track.segments[i+1]?.id??null);
    const road=buildRoadMesh(track);assert.ok(road.points.length>track.segments.length+1);
    assert.equal(road.indices.length,(road.points.length-1)*6);
    const [a,b,c]=road.indices.slice(0,3),vertices=road.vertices;
    const ax=vertices[b*3]-vertices[a*3],az=vertices[b*3+2]-vertices[a*3+2];
    const bx=vertices[c*3]-vertices[a*3],bz=vertices[c*3+2]-vertices[a*3+2];
    assert.ok(az*bx-ax*bz>0,'road triangles must face upward');
    for(let i=0;i<road.points.length-1;i++) {
      assert.ok(Math.hypot(road.points[i+1].left.x-road.points[i].left.x,road.points[i+1].left.z-road.points[i].left.z)>0);
      assert.ok(Math.hypot(road.points[i+1].right.x-road.points[i].right.x,road.points[i+1].right.z-road.points[i].right.z)>0);
    }
  }
});
test('a complete keyboard-input lap replays deterministically through every checkpoint',async()=>{
  const track=trackById('indianapolis')!;await initPhysics(track);
  const result=driveTrack(track);assert.equal(result.finished,true);assert.equal(result.respawns,0);
  const validated=await validateReplay(result.run,true);assert.equal(validated.timeMs,result.run.timeMs);
  assert.equal(validated.checkpoints,track.checkpoints.length);assert.equal(validated.frames!.length,result.run.inputs.length+1);
});
test('simulation and ghost have identical snapshots for identical fixed-tick inputs',()=>{
  const a=new Simulation(TRACKS[0]),b=new Simulation(TRACKS[0]);
  try{for(let i=0;i<500;i++){const input=i<130?Input.Throttle:i<200?Input.Brake|Input.Left:i===250?Input.Respawn:Input.Throttle;a.step(input);b.step(input);}
    assert.deepEqual(a.frame(),b.frame());assert.deepEqual(a.world.takeSnapshot(),b.world.takeSnapshot());assert.equal(a.timeMs,b.timeMs);
  }finally{a.dispose();b.dispose();}
});
test('high-speed chassis collision still stops at a thin wall, including Daytona CCD mode',()=>{
  for(const id of ['collision-pad','daytona']){
    const sim=new Simulation({...handlingTrack(),id});
    try{
      sim.world.createCollider(RAPIER.ColliderDesc.cuboid(50,3,.025).setTranslation(0,2,15));
      sim.world.step();
      sim.car.setLinvel({x:0,y:0,z:90},true);
      for(let i=0;i<90;i++)sim.step(Input.Throttle|Input.Drift);
      assert.ok(sim.car.translation().z<15,`${id}: car passed through the barrier`);
      assert.ok(sim.speed<2,`${id}: impact did not stop forward motion`);
    }finally{sim.dispose();}
  }
});
test('a released car stays parked until the driver gives it an input',async()=>{
  const track=trackById('bugatti')!;await initPhysics(track);
  const sim=new Simulation(track);try{
    const parked={...sim.car.translation()};
    for(let i=0;i<300;i++)sim.step(0);
    const settled=sim.car.translation();
    assert.ok(Math.hypot(settled.x-parked.x,settled.z-parked.z)<.08,'idle chassis must not creep across the grid');
    assert.ok(Math.hypot(sim.car.linvel().x,sim.car.linvel().z)<.01,'parking hold must cancel residual planar velocity');
    assert.ok(Math.hypot(sim.car.angvel().x,sim.car.angvel().y,sim.car.angvel().z)<.01,'parking hold must cancel residual chassis rotation');
    for(let i=0;i<90;i++)sim.step(Input.Throttle);
    assert.ok(sim.speed*track.metersPerUnit>3,'throttle must release the parking hold immediately');
  }finally{sim.dispose();}
});
test('a newly spawned car has no residual suspension twist before the countdown',async()=>{
  const track=trackById('bugatti')!;await initPhysics(track);
  const sim=new Simulation(track);try{
    assert.ok(Math.hypot(sim.car.linvel().x,sim.car.linvel().y,sim.car.linvel().z)<1e-8);
    assert.ok(Math.hypot(sim.car.angvel().x,sim.car.angvel().y,sim.car.angvel().z)<1e-8);
  }finally{sim.dispose();}
});
test('garage cars have distinct physical setups and progressive pedals',()=>{
  assert.equal(new Set(CARS.map(car=>JSON.stringify(car.physics))).size,CARS.length);
  for(const car of CARS){assert.ok(car.physics.massKg>=800);assert.ok(car.physics.topSpeedKph>=240);assert.ok(car.physics.zeroToHundred>2);}
  const sim=new Simulation(TRACKS[0],CARS[0].id);try{
    sim.step(Input.Throttle);assert.ok(sim.throttle>0&&sim.throttle<1);
    const forward=rotate(sim.car.rotation(),{x:0,y:0,z:1});sim.car.setLinvel({x:forward.x*12,y:forward.y*12,z:forward.z*12},true);for(let i=0;i<5;i++)sim.step(Input.Brake);
    assert.ok(sim.brake>0&&sim.brake<1);
    assert.equal(Input.Drift,16,'Left Shift must use the recorded drift input bit');
  }finally{sim.dispose();}
});
test('brake transitions into reverse, high-speed steering adds progressive rear slip, and flip is speed-gated',()=>{
  const sim=new Simulation(TRACKS[0]);try{
    const initial={...sim.car.translation()},forward=rotate(sim.car.rotation(),{x:0,y:0,z:1});for(let i=0;i<75;i++)sim.step(Input.Brake);
    const moved=sim.car.translation();assert.ok(sim.forwardSpeed<-.2);assert.ok((moved.x-initial.x)*forward.x+(moved.y-initial.y)*forward.y+(moved.z-initial.z)*forward.z<0);assert.ok(sim.reverse>0);
    sim.car.setLinvel({x:forward.x*20,y:forward.y*20,z:forward.z*20},true);for(let i=0;i<18;i++)sim.step(Input.Left);
    assert.ok(sim.autoDrift>0&&sim.autoDrift<=.78);
    assert.equal(sim.flipCar(),false,'flip must be unavailable above 25 km/h');
    sim.car.setLinvel({x:0,y:0,z:0},true);sim.car.setRotation({x:.7071,y:0,z:0,w:.7071},true);
    assert.equal(sim.flipCar(),true);assert.ok(Math.abs(sim.car.rotation().x)<1e-5&&Math.abs(sim.car.rotation().z)<1e-5);
  }finally{sim.dispose();}
});
test('respawning keeps elapsed time and clears velocity without granting checkpoints',()=>{
  const sim=new Simulation(TRACKS[0]);try{for(let i=0;i<60;i++)sim.step(Input.Throttle);const time=sim.timeMs;
    sim.step(Input.Respawn);assert.ok(sim.timeMs>time);assert.equal(sim.respawns,1);assert.equal(sim.checkpoint,0);assert.ok(sim.speed<2);
    sim.step(Input.Respawn);assert.equal(sim.respawns,1,'holding C must not reset every tick');
  }finally{sim.dispose();}
});
test('fall recovery and reset use canonical initial state',()=>{
  const sim=new Simulation(TRACKS[0]);try{sim.car.setTranslation({x:0,y:sim.recoveryFloor-5,z:0},true);sim.step(0);assert.equal(sim.respawns,1);assert.ok(sim.car.translation().y>TRACKS[0].start.position.y);
  }finally{sim.dispose();}
  const a=new Simulation(TRACKS[0]),b=new Simulation(TRACKS[0]);assert.deepEqual(a.frame(),b.frame());a.dispose();b.dispose();
});
test('checkpoint order and directional finish cannot be skipped',()=>{
  const sim=new Simulation(TRACKS[0]);try{
    const finish=TRACKS[0].finish;sim.car.setTranslation({x:finish.position.x,y:finish.position.y+1,z:finish.position.z+1},true);
    sim.car.setLinvel({x:0,y:0,z:-40},true);sim.step(0);sim.step(0);assert.equal(sim.finished,false);assert.equal(sim.checkpoint,0);
  }finally{sim.dispose();}
});
test('validator rejects forged times, extra inputs, old versions and unfinished runs',async()=>{
  const {run}=driveTrack(trackById('indianapolis')!);
  await assert.rejects(validateReplay({...run,timeMs:1}),/does not match/);
  await assert.rejects(validateReplay({...run,inputs:[...run.inputs,0]}),/after the finish/);
  await assert.rejects(validateReplay({...run,trackVersion:999}),/version/);
  await assert.rejects(validateReplay({...run,physicsVersion:'old'}));
  await assert.rejects(validateReplay({...run,inputs:[1]}),/did not complete/);
  assert.equal(runSchema.safeParse({...run,inputs:[-1]}).success,false);
  assert.equal(runSchema.safeParse({...run,inputs:new Array(MAX_TICKS+1).fill(0)}).success,false);
  assert.equal(runSchema.safeParse({...run,inputs:[NaN]}).success,false);
  assert.equal(runSchema.safeParse({...run,extra:true}).success,false);
});
test('timer and medal boundaries are consistent',()=>{
  assert.equal(formatTime(61234),'01:01.234');assert.equal(formatTime(0),'00:00.000');
  assert.equal(medalFor(TRACKS[0],TRACKS[0].medals[0]),'Gold');assert.equal(medalFor(TRACKS[0],TRACKS[0].medals[0]+1),'Silver');
  assert.equal(PHYSICS_VERSION,'apex-rapier0193-v34');
});
