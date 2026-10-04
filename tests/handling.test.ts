import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { CARS } from '../shared/cars';
import { initPhysics, Input, Simulation, DT, PHYSICS_VERSION, rearSlipDemand, steeringLock } from '../shared/physics';
import { runSchema, stepReplay, type Run } from '../shared/replay';
import { handlingTrack, MANEUVERS, MPH, runManeuver, performanceRun, telemetry, type Maneuver } from './handling-harness';

before(()=>initPhysics());
test('replays preserve changes to the live steering and drift sliders',()=>{
  const track=handlingTrack(),a=new Simulation(track),b=new Simulation(track);
  const inputs=Array.from({length:600},(_,i)=>Input.Throttle|(i%240<120?Input.Left:Input.Right)|(i>=200&&i<400?Input.Drift:0));
  const steering=inputs.map((_,i)=>i<200?1.1:i<400?.7:1.35);
  const drift=inputs.map((_,i)=>i<200?0:i<400?2:.5);
  const run: Run={trackId:track.id,trackVersion:track.version,physicsVersion:PHYSICS_VERSION,carId:a.carSpec.id,timeMs:10000,inputs,steering,drift};
  try{
    assert.ok(runSchema.safeParse(run).success);
    assert.equal(runSchema.safeParse({...run,steering:[1.1]}).success,false);
    assert.equal(runSchema.safeParse({...run,steering:steering.map(()=>2.01)}).success,false);
    assert.equal(runSchema.safeParse({...run,drift:[1]}).success,false);
    assert.equal(runSchema.safeParse({...run,drift:drift.map(()=>2.01)}).success,false);
    for(let i=0;i<inputs.length;i++){a.steeringStrength=steering[i];a.driftStrength=drift[i];a.step(inputs[i]);stepReplay(b,run);}
    assert.deepEqual(a.world.takeSnapshot(),b.world.takeSnapshot());
  }finally{a.dispose();b.dispose();}
});

test('every car sustains a powered slide, countersteers and recovers grip',()=>{
  for(const car of CARS){
    const sim=new Simulation(handlingTrack(),car.id);sim.steeringStrength=1.5;
    try{
      sim.car.setLinvel({x:0,y:0,z:35},true);
      for(let i=0;i<180;i++)sim.step(Input.Throttle|Input.Left|Input.Drift);
      const slide=telemetry(sim);
      assert.ok(slide.slip < -10 && slide.slip > -35,`${car.id}: no controlled outward slide`);
      assert.ok(slide.speed>28,`${car.id}: powered drift lost too much momentum`);
      assert.equal(sim.drifting,true);
      for(let i=0;i<45;i++)sim.step(Input.Throttle|Input.Right|Input.Drift);
      const counter=telemetry(sim);
      assert.ok(Math.abs(counter.slip)<Math.abs(slide.slip)*.5,`${car.id}: countersteering failed to catch the rear`);
      assert.ok(counter.yawRate<0,`${car.id}: steering did not reverse the turn`);
      for(let i=0;i<120;i++)sim.step(Input.Throttle);
      assert.ok(Math.abs(telemetry(sim).slip)<.4,`${car.id}: grip did not recover`);
      assert.equal(sim.drifting,false);
    }finally{sim.dispose();}
  }
});

test('maximum steering and drift settings keep positive tire grip and bounded forces',()=>{
  for(const car of CARS)for(const mph of [30,100,200]){
    const sim=new Simulation(handlingTrack(),car.id);sim.steeringStrength=2;sim.driftStrength=2;
    try{
      sim.car.setLinvel({x:0,y:0,z:mph*MPH},true);let previous=telemetry(sim);
      for(let i=0;i<480;i++){
        sim.step((i<240?Input.Throttle:Input.Brake)|Input.Drift|(i<180?Input.Left:i<360?Input.Right:0));
        const current=telemetry(sim);
        assert.ok(Object.values(current).every(Number.isFinite),`${car.id}: non-finite state`);
        assert.ok(sim.autoDrift>=0&&sim.autoDrift<=1,`${car.id}: unbounded rear breakaway`);
        assert.ok(sim.vehicle.wheelFrictionSlip(2)!>0&&sim.vehicle.wheelSideFrictionStiffness(2)!>0,`${car.id}: negative tire grip`);
        assert.ok(Math.hypot(current.vx-previous.vx,current.vz-previous.vz)/DT<30,`${car.id}: tire impulse exceeded 3 g`);
        assert.equal(current.contacts,4,`${car.id}: lost flat-pad contact`);
        previous=current;
      }
    }finally{sim.dispose();}
  }
});
for(const car of CARS)test(`${car.shortName}: 176 handling scenarios, with and without Left Shift, from stationary to 200 mph`,()=>{
  for(const manual of [false,true])for(const mph of [0,5,15,30,60,100,150,200])for(const maneuver of Object.keys(MANEUVERS) as Maneuver[]){
    const result=runManeuver(car.id,mph,maneuver,5,1.1,manual),label=`${car.id} ${mph} mph ${maneuver} shift=${manual}`;
    assert.ok(result.samples.every(s=>Object.values(s).every(Number.isFinite)),`${label}: non-finite state`);
    assert.equal(result.airTicks,0,`${label}: wheel contact lost on a flat floor`);
    assert.ok(result.minUp>.995,`${label}: chassis accumulated tilt`);
    assert.ok(result.maxG<3,`${label}: ${result.maxG.toFixed(2)} g tire impulse`);
    assert.ok(result.maxSlipStep<1.2,`${label}: sideslip jumped ${result.maxSlipStep.toFixed(2)} degrees in one tick`);
    if(mph===0&&['coast','left','right','release','reversal','both-pedals'].includes(maneuver))assert.ok(result.displacement<.01,`${label}: moved while parked`);
    if(['coast','throttle','brake','both-pedals'].includes(maneuver))assert.ok(Math.abs(result.final.x)<.025,`${label}: unexpected lateral drift`);
    if(['coast','left','right','reversal','release'].includes(maneuver))assert.ok(result.maxSpeedGain<.002,`${label}: steering added energy without the throttle`);
    if(mph>=15&&maneuver==='left')assert.ok(result.samples[20].yaw>0,`${label}: turned against the steering input`);
    if(mph>=15&&maneuver==='right')assert.ok(result.samples[20].yaw<0,`${label}: turned against the steering input`);
    if(mph>=30&&maneuver==='reversal')assert.ok(result.final.yawRate<0,`${label}: could not countersteer`);
    if(maneuver==='release'&&result.final.speed>5){assert.ok(Math.abs(result.final.yawRate)<.15,`${label}: still turning after release`);assert.ok(Math.abs(result.final.slip)<.4,`${label}: slide did not settle`);}
    if(mph>=60&&maneuver==='power-left')assert.ok(result.final.rearLateral<result.final.frontLateral-.1,`${label}: rear axle must step farther outward than the front`);
    if(mph===100&&maneuver==='power-left'){
      assert.ok(result.maxSlip>(manual?10:1)&&result.maxSlip<(manual?35:6),`${label}: slip outside the natural / controlled-drift envelope (${result.maxSlip})`);
      if(manual)assert.ok(result.final.speed>mph*MPH*.65,`${label}: drift scrubbed away cruising speed`);
    }
  }
});

test('all cars approach their configured top speed and have plausible acceleration and braking',t=>{
  for(const car of CARS){
    const result=performanceRun(car.id);
    assert.ok(result.sixty!==null&&result.sixty>car.physics.zeroToHundred*.75&&result.sixty<car.physics.zeroToHundred*1.2,car.id);
    assert.ok(result.topMph>result.nominalMph*.98&&result.topMph<result.nominalMph+1,`${car.id}: ${result.topMph} mph against ${result.nominalMph}`);
    const expectedFeet=car.physics.brakeDistance*.932*3.28084;
    assert.ok(result.brakeFeet>expectedFeet*.85&&result.brakeFeet<expectedFeet+50,`${car.id}: stopping distance outside tuning plus pedal-ramp allowance`);
    t.diagnostic(`${car.shortName}: 0–60 ${result.sixty?.toFixed(2)} s, top ${result.topMph.toFixed(1)} mph, 60–0 ${result.brakeFeet.toFixed(0)} ft (includes progressive brake application)`);
  }
});

test('seeded mixed inputs, steering strengths and Left Shift remain stable and deterministic',()=>{
  for(const car of CARS)for(const strength of [.7,1.1,1.35]){
    const a=new Simulation(handlingTrack(),car.id),b=new Simulation(handlingTrack(),car.id);
    try{
      a.steeringStrength=b.steeringStrength=strength;
      for(const sim of [a,b])sim.car.setLinvel({x:0,y:0,z:150*MPH},true);
      let seed=12345,input=0,previous=telemetry(a);
      for(let tick=0;tick<1800;tick++){
        if(tick%20===0){seed=(Math.imul(seed,1664525)+1013904223)>>>0;input=seed>>>27;}
        a.step(input);b.step(input);
        const current=telemetry(a),g=Math.hypot(current.vx-previous.vx,current.vz-previous.vz)/DT/9.81;
        assert.ok(g<3,`${car.id} ${strength}: mixed-input spike ${g} g`);
        assert.ok(current.up>.995,`${car.id}: mixed-input tilt`);previous=current;
      }
      assert.deepEqual(a.world.takeSnapshot(),b.world.takeSnapshot(),`${car.id}: replay changed the physics`);
    }finally{a.dispose();b.dispose();}
  }
});

test('Left Shift drift scales with speed and wheel load, and does nothing parked or straight',()=>{
  for(const speed of [0,2,4])assert.equal(rearSlipDemand(speed,1,1,0,true),0);
  for(const speed of [10,30,60])assert.equal(rearSlipDemand(speed,0,1,0,true),0);
  assert.ok(rearSlipDemand(35,.8,1,0,true)>rearSlipDemand(15,.8,1,0,true));
  assert.ok(rearSlipDemand(35,.8,1,0,true)>rearSlipDemand(35,.2,1,0,true));
  assert.ok(rearSlipDemand(35,.8,1,0,true)>rearSlipDemand(35,.8,1,0,false));
  assert.ok(rearSlipDemand(35,.8,1,1,true)<rearSlipDemand(35,.8,1,0,true));
  assert.equal(rearSlipDemand(35,.8,1,0,true,0),0);
  assert.ok(rearSlipDemand(35,.8,1,0,true,2)>rearSlipDemand(35,.8,1,0,true,1));
});

test('high-speed steering keeps arcade turn authority',()=>{
  const result=runManeuver('porsche-911-gt3',150,'power-left',2);
  assert.ok(result.final.yaw>20,`150 mph turn only reached ${result.final.yaw.toFixed(1)} degrees`);
});

test('holding steering builds turn authority',()=>{
  const sim=new Simulation(handlingTrack(),'porsche-911-gt3'),speed=150*MPH;
  try{
    sim.car.setLinvel({x:0,y:0,z:speed},true);
    const tuning=sim.carSpec.physics,arcadeGrip=6*Math.max(0,Math.min(1,(speed-25)/35));
    const base=steeringLock(tuning.steerAngle,speed,sim.carSpec.dimensions.wheelbaseM,11+tuning.downforce*5+arcadeGrip).lock;
    for(let i=0;i<180;i++)sim.step(Input.Throttle|Input.Left);
    assert.ok(sim.steering>base*1.15,`held steering reached only ${(sim.steering/base).toFixed(2)}× base lock`);
  }finally{sim.dispose();}
});

test('200% steering has visibly tighter high-speed turns',()=>{
  const normal=runManeuver('porsche-911-gt3',150,'power-left',2,1.3);
  const arcade=runManeuver('porsche-911-gt3',150,'power-left',2,2);
  assert.ok(arcade.final.yaw>normal.final.yaw+10,`200% added only ${(arcade.final.yaw-normal.final.yaw).toFixed(1)} degrees`);
  assert.ok(arcade.maxG<3,`200% turn reached ${arcade.maxG.toFixed(2)} g`);
});
