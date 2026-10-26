import {before,test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {CARS,DEFAULT_CAR} from '../shared/cars';
import {initPhysics,Simulation,Input,DT,PHYSICS_VERSION,WEATHERS,powerSlipDemand} from '../shared/physics';
import {engineState,TRANSMISSIONS} from '../shared/transmission';
import {CITY} from '../shared/tracks';
import {stepReplay,type Run} from '../shared/replay';
import {DEFAULT_BINDINGS,loadBindings} from '../src/controls';
import {handlingTrack,telemetry} from './handling-harness';

before(()=>initPhysics());

test('manual gear-driven drift works on the actual City street collision mesh',async()=>{
  await initPhysics(CITY);
  const angles:number[]=[];
  for(const gear of [1,2,TRANSMISSIONS[DEFAULT_CAR.id].gears]){
    const sim=new Simulation(CITY);sim.manual=true;sim.gear=gear;
    try{
      for(let i=0;i<30;i++)sim.step(0);sim.car.setLinvel({x:0,y:0,z:18},true);
      for(let i=0;i<60;i++)sim.step(Input.Throttle|Input.Left);
      const state=telemetry(sim);angles.push(Math.abs(state.slip));
      assert.equal(state.contacts,4);assert.equal(sim.offRoad,false);assert.equal(sim.hitCount,0);
      assert.ok(state.speed>14,'street drift retains momentum');
    }finally{sim.dispose();}
  }
  assert.ok(angles[0]>angles[1]&&angles[1]>angles[2]+12,`City gear angles: ${angles}`);
});

test('saved Shift and manual replays retain their pre-change physics snapshots',()=>{
  // Captured before changing handling, including both old transmission modes and Shift slides.
  const hashes=['c0b3da27b093f4f2d6d08c554d8d74979b8471e444663d6fe0bbfc15e4091d64','6da7e3cbd17006e6b976c23211cf74fa2a860ffc438cbf2e67b818558fc0c7bb','0661bd15b13f4e139d058f5e3d3ca76a1ee24551e10cbcadf17be942974670e0','a7c8b911da4d9a2dfa5082ddbf649e7c9abc399d701f7b66f83309733bfb9aff'];
  let index=0;
  for(const manual of [false,true])for(const drift of [false,true]){
    const sim=new Simulation(handlingTrack());sim.gear=2;
    const inputs=Array.from({length:600},(_,i)=>(i<420?Input.Throttle:0)|(i<180?Input.Left:i<360?Input.Right:0)|(drift?Input.Drift:0));
    const run:Run={trackId:sim.track.id,trackVersion:sim.track.version,carId:sim.carSpec.id,physicsVersion:PHYSICS_VERSION,timeMs:10000,inputs,manual};
    try{
      inputs.forEach(()=>stepReplay(sim,run));
      assert.equal(createHash('sha256').update(sim.world.takeSnapshot()).digest('hex'),hashes[index++]);
    }finally{sim.dispose();}
  }
});

test('Shift commands drift only in automatic; saved drift and custom bindings survive',()=>{
  assert.deepEqual(DEFAULT_BINDINGS.drift,['ShiftLeft']);
  const saved={...DEFAULT_BINDINGS,drift:['Space'],throttle:['KeyI','ArrowUp']};
  assert.deepEqual(loadBindings(saved),{...DEFAULT_BINDINGS,drift:['Space'],throttle:['KeyI','ArrowUp']});
  for(const manual of [false,true]){
    const a=new Simulation(handlingTrack()),b=new Simulation(handlingTrack());a.manual=b.manual=manual;
    try{
      for(let i=0;i<600;i++){const input=Input.Throttle|(i>120?Input.Left:0);a.step(input);b.step(input|Input.Drift);}
      if(manual)assert.deepEqual(a.world.takeSnapshot(),b.world.takeSnapshot());
      else {assert.notDeepEqual(a.world.takeSnapshot(),b.world.takeSnapshot());assert.ok(b.autoDrift>a.autoDrift+.2,'Shift engages automatic drift');}
    }finally{a.dispose();b.dispose();}
  }
});

test('drive torque reduces with taller gears, and requires speed, throttle and corner load',()=>{
  for(const car of CARS){
    const speed=engineState(car,0,1).top*.7,gears=TRANSMISSIONS[car.id].gears;
    let previous=Infinity;
    for(let gear=1;gear<=gears;gear++){
      const demand=powerSlipDemand(car,speed,gear,.8,1,0);
      assert.ok(demand<previous,`${car.id} gear ${gear}: rear torque must fall with each upshift`);previous=demand;
    }
    for(const [velocity,load,throttle,brake,strength] of [[0,1,1,0,1],[3,1,1,0,1],[speed,0,1,0,1],[speed,1,0,0,1],[speed,1,1,1,1],[speed,1,1,0,0],[engineState(car,0,1).top*1.1,1,1,0,1]]){
      assert.equal(powerSlipDemand(car,velocity,1,load,throttle,brake,strength),0,car.id);
    }
  }
});

test('every car power-slides without Shift, slides less in taller gears, countersteers and settles',()=>{
  for(const car of CARS){
    const angles:number[]=[];
    for(const gear of [1,2,TRANSMISSIONS[car.id].gears]){
      const sim=new Simulation(handlingTrack(),car.id);sim.manual=true;sim.gear=gear;
      try{
        for(let i=0;i<30;i++)sim.step(0);
        const initial=engineState(car,0,1).top*.7;sim.car.setLinvel({x:0,y:0,z:initial},true);
        for(let i=0;i<180;i++)sim.step(Input.Throttle|Input.Left);
        const slide=telemetry(sim);angles.push(Math.abs(slide.slip));
        if(gear===1){assert.ok(slide.slip < -25 && slide.slip > -70,car.id);assert.ok(slide.speed>initial*.65,car.id);assert.equal(sim.drifting,true);}
        for(let i=0;i<45;i++)sim.step(Input.Throttle|Input.Right);
        if(gear<=2)assert.ok(Math.abs(telemetry(sim).slip)<Math.abs(slide.slip)*.6,`${car.id}: countersteer`);
        for(let i=0;i<180;i++)sim.step(Input.Throttle);
        assert.ok(Math.abs(telemetry(sim).slip)<.4,`${car.id}: release`);assert.equal(sim.drifting,false);
      }finally{sim.dispose();}
    }
    assert.ok(angles[0]>angles[1]+5&&angles[1]>angles[2]+8,`${car.id}: gear angles ${angles}`);
  }
});

test('maximum drift carries a wide, nearly straight path instead of tightening the turn',()=>{
  const run=(strength:number)=>{
    const sim=new Simulation(handlingTrack());sim.manual=true;sim.gear=2;sim.driftStrength=strength;
    try{
      for(let i=0;i<30;i++)sim.step(0);sim.car.setLinvel({x:0,y:0,z:20},true);
      for(let i=0;i<360;i++)sim.step(Input.Throttle|Input.Left);
      return telemetry(sim);
    }finally{sim.dispose();}
  };
  const normal=run(1),maximum=run(2);
  assert.ok(Math.abs(maximum.slip)>45&&Math.abs(maximum.slip)<80);
  assert.ok(Math.abs(maximum.yawRate)<3);
  assert.ok(Math.abs(maximum.slip)>Math.abs(normal.slip)+8);
  assert.ok(maximum.speed>13,'wide slide retains useful momentum');
});

test('earlier gear-driven recordings keep their original rotation and exits',()=>{
  const hashes=['27cff9034673a3fd77608049513b1046d45941e12db1f8abfadc3822f7b768bf','84f2ea03f4980b9d90d20e96b4b01c425e78fec076de7c285a63721d07a058a5'];
  for(const manual of [false,true]){
    const sim=new Simulation(handlingTrack());sim.gear=2;
    const inputs=Array.from({length:600},(_,i)=>(i<420?Input.Throttle:0)|(i<180?Input.Left:i<360?Input.Right:0)|(!manual?Input.Drift:0));
    const run:Run={trackId:sim.track.id,trackVersion:sim.track.version,carId:sim.carSpec.id,physicsVersion:PHYSICS_VERSION,timeMs:10000,inputs,manual,gearDrift:true};
    try{
      inputs.forEach(()=>stepReplay(sim,run));
      assert.equal(createHash('sha256').update(sim.world.takeSnapshot()).digest('hex'),hashes[Number(manual)]);
    }finally{sim.dispose();}
  }
});

test('drift entry rotates more slowly in automatic and manual',()=>{
  for(const manual of [false,true]){
    const peak=(assisted:boolean)=>{
      const sim=new Simulation(handlingTrack());sim.manual=manual;sim.gear=2;sim.driftExit=assisted;
      try{
        for(let i=0;i<30;i++)sim.step(0);sim.car.setLinvel({x:0,y:0,z:18},true);
        let peak=0;
        for(let i=0;i<180;i++){sim.step(Input.Throttle|Input.Left|(!manual?Input.Drift:0));peak=Math.max(peak,Math.abs(telemetry(sim).yawRate));}
        return peak;
      }finally{sim.dispose();}
    };
    assert.ok(peak(true)<70&&peak(true)<peak(false)*.65,`${manual?'manual':'automatic'}: drift rotation stays controlled`);
  }
});

test('every manual car accelerates out by holding throttle and unwinding, without braking or shifting',()=>{
  for(const car of CARS)for(const gear of [1,2]){
    const sim=new Simulation(handlingTrack(),car.id);sim.manual=true;sim.gear=gear;
    try{
      for(let i=0;i<30;i++)sim.step(0);sim.car.setLinvel({x:0,y:0,z:engineState(car,0,1).top*.7},true);
      for(let i=0;i<180;i++)sim.step(Input.Throttle|Input.Left);
      const start=telemetry(sim);assert.ok(start.slip < -15,`${car.id}: established slide in gear ${gear}`);
      for(let i=0;i<60;i++)sim.step(Input.Throttle);
      assert.ok(Math.abs(telemetry(sim).slip)<1,`${car.id}: unwind catches slide within one second`);
      assert.equal(sim.drifting,false);assert.equal(sim.gear,gear);
      for(let i=0;i<30;i++)sim.step(Input.Throttle);
      assert.ok(sim.speed>start.speed+.3,`${car.id}: throttle must gain speed after the exit`);
    }finally{sim.dispose();}
  }
});

test('manual drift stays bounded across cars, gears, weather and maximum sliders',()=>{
  for(const car of CARS)for(const weather of WEATHERS)for(const gear of [1,2,TRANSMISSIONS[car.id].gears]){
    const sim=new Simulation(handlingTrack(),car.id);sim.manual=true;sim.gear=gear;sim.weather=weather;sim.driftStrength=sim.steeringStrength=2;
    try{
      for(let i=0;i<30;i++)sim.step(0);
      sim.car.setLinvel({x:0,y:0,z:engineState(car,0,gear).top*.7},true);let previous=telemetry(sim);
      for(let i=0;i<360;i++){
        sim.step((i<240?Input.Throttle:Input.Brake)|(i<120?Input.Left:i<240?Input.Right:0));
        const current=telemetry(sim),label=`${car.id} ${weather} ${gear}`;
        assert.ok(Object.values(current).every(Number.isFinite),label);
        assert.ok(Math.hypot(current.vx-previous.vx,current.vz-previous.vz)/DT<30,label);
        assert.ok(sim.autoDrift>=0&&sim.autoDrift<=1,label);
        assert.ok(sim.vehicle.wheelFrictionSlip(2)!>0&&sim.vehicle.wheelSideFrictionStiffness(2)!>0,label);
        assert.equal(current.contacts,4,label);previous=current;
      }
    }finally{sim.dispose();}
  }
});

test('gear-driven drift, gear changes, lifts and slider changes replay exactly',()=>{
  const a=new Simulation(handlingTrack()),b=new Simulation(handlingTrack());a.manual=true;
  const inputs=Array.from({length:900},(_,i)=>(i%180<140?Input.Throttle:0)|(i%300<150?Input.Left:Input.Right)|(i===140?Input.ShiftUp:i===420?Input.ShiftDown:0));
  const drift=inputs.map((_,i)=>i<300?1:i<600?2:.5);
  const run:Run={trackId:a.track.id,trackVersion:a.track.version,physicsVersion:PHYSICS_VERSION,carId:DEFAULT_CAR.id,timeMs:15000,inputs,drift,manual:true,gearDrift:true,driftExit:true};
  try{
    for(let i=0;i<inputs.length;i++){a.driftStrength=drift[i];a.step(inputs[i]);stepReplay(b,run);}
    assert.deepEqual(a.world.takeSnapshot(),b.world.takeSnapshot());assert.equal(a.gear,b.gear);
  }finally{a.dispose();b.dispose();}
});
