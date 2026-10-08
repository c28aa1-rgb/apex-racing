import {before,test} from 'node:test';
import assert from 'node:assert/strict';
import {CARS} from '../shared/cars';
import {initPhysics,Input,Simulation,PHYSICS_VERSION} from '../shared/physics';
import {engineState} from '../shared/transmission';
import {runSchema,stepReplay,type Run} from '../shared/replay';
import {handlingTrack} from './handling-harness';
import {awardFinish} from '../src/progression';
import {DEFAULT_BINDINGS,bindingChange,bindingConflicts,loadBindings} from '../src/controls';
import {Store} from '../server/store';
import {SkidMarks} from '../src/race-effects';
before(()=>initPhysics());

test('loaded tire slip produces black trails and clearing removes the old run',()=>{
  const sim=new Simulation(handlingTrack()),marks=new SkidMarks();
  try{for(let i=0;i<60;i++){sim.step(0);marks.update(sim,true);}assert.equal(marks.mesh.geometry.drawRange.count,0);
    sim.car.setLinvel({x:0,y:0,z:50},true);for(let i=0;i<180;i++){sim.step(Input.Throttle|Input.Left|Input.Drift);marks.update(sim,true);}
    assert.ok(marks.mesh.geometry.drawRange.count>30);assert.equal((marks.mesh.material as import('three').MeshBasicMaterial).color.getHex(),0);marks.clear();assert.equal(marks.mesh.geometry.drawRange.count,0);
  }finally{sim.dispose();marks.mesh.geometry.dispose();(marks.mesh.material as import('three').Material).dispose();}
});

test('manual cars require upshifts, obey their limiter and replay deterministically',()=>{
  for(const car of CARS){const track=handlingTrack(),low=new Simulation(track,car.id),shifted=new Simulation(track,car.id),replay=new Simulation(track,car.id),inputs:number[]=[];low.manual=shifted.manual=true;
    try{for(let i=0;i<900;i++){let input:number=Input.Throttle;if(i%20===0&&shifted.engine.load>.89)input|=Input.ShiftUp;inputs.push(input);low.step(Input.Throttle);shifted.step(input);}
      assert.equal(low.gear,1,car.id);assert.ok(low.speed<engineState(car,0,1).top*1.05,`${car.id} first-gear limiter`);assert.ok(shifted.gear>1,`${car.id} can upshift`);assert.ok(shifted.speed>low.speed*1.6,`${car.id} shifting unlocks speed`);
      const run:Run={trackId:track.id,trackVersion:track.version,physicsVersion:PHYSICS_VERSION,carId:car.id,timeMs:shifted.timeMs,inputs,manual:true};assert.ok(runSchema.safeParse(run).success);
      inputs.forEach(()=>stepReplay(replay,run));assert.deepEqual(shifted.world.takeSnapshot(),replay.world.takeSnapshot(),car.id);assert.equal(shifted.gear,replay.gear);assert.equal(shifted.engine.rpm,replay.engine.rpm);
      const reward=awardFinish({xp:0,finishes:0,medals:{},owned:[]},track,1,true);assert.equal(reward.breakdown.manual,100);assert.equal(reward.earned,450);
    }finally{low.dispose();shifted.dispose();replay.dispose();}
  }
});

test('shift keys are edge-triggered and unsafe downshifts are refused',()=>{
  const sim=new Simulation(handlingTrack());sim.manual=true;
  try{for(let i=0;i<60;i++)sim.step(Input.ShiftUp);assert.equal(sim.gear,2);sim.step(0);sim.step(Input.ShiftUp);assert.equal(sim.gear,3);
    for(let i=0;i<15;i++)sim.step(0);sim.car.setLinvel({x:0,y:0,z:70},true);sim.step(Input.ShiftDown);assert.equal(sim.gear,3,'overrev protection');sim.respawn();assert.equal(sim.gear,1);
  }finally{sim.dispose();}
});

test('downshifting off-throttle slows the car through engine braking; refused downshifts are counted',()=>{
  const track=handlingTrack(),coast=(gear:number)=>{
    const sim=new Simulation(track);sim.manual=true;
    try{for(let i=0;i<30;i++)sim.step(0);sim.gear=gear;sim.car.setLinvel({x:0,y:0,z:22},true);const start=sim.speed;for(let i=0;i<90;i++)sim.step(0);return start-sim.speed;}
    finally{sim.dispose();}
  };
  const auto=(()=>{const sim=new Simulation(track);try{for(let i=0;i<30;i++)sim.step(0);sim.car.setLinvel({x:0,y:0,z:22},true);const start=sim.speed;for(let i=0;i<90;i++)sim.step(0);return start-sim.speed;}finally{sim.dispose();}})();
  const high=coast(5),low=coast(2);
  assert.ok(low>high*1.3,`lower gear drags harder (${low.toFixed(2)} vs ${high.toFixed(2)})`);
  assert.ok(low>auto,`manual engine braking exceeds automatic coasting (${low.toFixed(2)} vs ${auto.toFixed(2)})`);
  const sim=new Simulation(track);sim.manual=true;
  try{for(let i=0;i<30;i++)sim.step(0);sim.gear=4;sim.car.setLinvel({x:0,y:0,z:70},true);sim.step(Input.ShiftDown);assert.equal(sim.gear,4);assert.equal(sim.blockedShifts,1);
    sim.step(0);for(let i=0;i<20;i++)sim.step(0);sim.car.setLinvel({x:0,y:0,z:8},true);assert.ok(sim.shiftReady);sim.step(Input.ShiftDown);assert.equal(sim.gear,3);assert.ok(!sim.shiftReady,'gearbox busy right after a shift');
  }finally{sim.dispose();}
});

test('party cars are solid: driving into another car stops you instead of passing through or riding over it',()=>{
  const track=handlingTrack(),run=(blocked:boolean)=>{
    const sim=new Simulation(track);
    try{for(let i=0;i<30;i++)sim.step(0);const p=sim.car.translation(),q=sim.car.rotation(),ahead={x:p.x,y:p.y,z:p.z+14};
      for(let i=0;i<150;i++){if(blocked)sim.setObstacle('other','ferrari-488-gt3',{p:ahead,q});sim.step(1);}
      const end=sim.car.translation();return {travelled:end.z-p.z,height:end.y-p.y};
    }finally{sim.dispose();}
  };
  const free=run(false),hit=run(true);
  assert.ok(free.travelled>20,`open road ${free.travelled.toFixed(1)} m`);
  assert.ok(hit.travelled<12,`stopped by the other car at ${hit.travelled.toFixed(1)} m`);
  assert.ok(hit.height<1.2,`did not climb onto it (${hit.height.toFixed(2)} m)`);
  const sim=new Simulation(track);try{sim.setObstacle('x','ferrari-488-gt3',{p:{x:0,y:0,z:0},q:{x:0,y:0,z:0,w:1}});sim.setObstacle('x','ferrari-488-gt3',undefined);sim.step(0);}finally{sim.dispose();}
});

test('key rebinding preserves alternates, allows shared keys with a warning, and validates stored bindings',()=>{
  assert.equal(DEFAULT_BINDINGS.camera[0],'KeyC');assert.equal(DEFAULT_BINDINGS.recover[0],'KeyF');assert.equal(DEFAULT_BINDINGS.flip[0],'KeyX');
  const changed=bindingChange(DEFAULT_BINDINGS,'throttle',0,'KeyI');assert.equal(changed.bindings?.throttle[0],'KeyI');assert.equal(changed.bindings?.throttle[1],'ArrowUp');assert.equal(DEFAULT_BINDINGS.throttle[0],'KeyW');
  assert.deepEqual(loadBindings(changed.bindings),changed.bindings);const shared=bindingChange(DEFAULT_BINDINGS,'throttle',0,'KeyS');assert.equal(shared.error,undefined);assert.deepEqual(shared.shared,['brake']);assert.deepEqual(bindingConflicts(shared.bindings!).get('KeyS'),['throttle','brake']);const {lookBack:_,...older}=DEFAULT_BINDINGS;assert.deepEqual(loadBindings(older),DEFAULT_BINDINGS);assert.ok(bindingChange(DEFAULT_BINDINGS,'throttle',0,'Escape').error);assert.deepEqual(loadBindings({throttle:['BadKey']}),DEFAULT_BINDINGS);
});

test('optional manual replay data survives idempotent database expansion; legacy rows stay unchanged',async()=>{
  const store=new Store();await store.init();await store.init();
  try{const player=await store.createPlayer('Manual driver'),track=handlingTrack(),run:Run={trackId:track.id,trackVersion:track.version,physicsVersion:PHYSICS_VERSION,carId:CARS[0].id,timeMs:50,inputs:[1,129,1],manual:true};await store.save(player.id,run);const rows=await store.leaderboard(track.id,track.version);assert.deepEqual(await store.replay(rows[0].id as string),run);
    const old=await store.createPlayer('Automatic driver'),legacy={...run,manual:undefined,inputs:[1,1,1]};delete legacy.manual;await store.save(old.id,legacy);const board=await store.leaderboard(track.id,track.version);assert.deepEqual(await store.replay(board.find(r=>r.playerId===old.id)!.id as string),legacy);
  }finally{await store.close();}
});
