import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CAR } from '../shared/cars';
import { TRANSMISSIONS } from '../shared/transmission';
import { initPhysics, Simulation, Input } from '../shared/physics';
import { handlingTrack } from './handling-harness';

before(()=>initPhysics());
const gears=TRANSMISSIONS[DEFAULT_CAR.id].gears;
function launch(gear:number,manual:boolean,seconds=6){
  const sim=new Simulation(handlingTrack(),DEFAULT_CAR.id);
  try{
    sim.manual=manual;sim.gear=gear;
    for(let t=0;t<60;t++)sim.step(0);
    for(let t=0;t<seconds*60;t++){sim.step(Input.Throttle);if(manual)sim.gear=gear;}
    return sim.speed*sim.track.metersPerUnit;
  }finally{sim.dispose();}
}

test('manual: leaving the car in top gear from a standstill barely moves it',()=>{
  const top=launch(gears,true),first=launch(1,true);
  assert.ok(first>15,`first gear launches (${first.toFixed(1)} m/s)`);
  assert.ok(top<first*.25,`top gear lugs (${top.toFixed(1)} m/s vs ${first.toFixed(1)} in first)`);
});

test('manual: each taller gear launches no better than the one below',()=>{
  const speeds=Array.from({length:gears},(_,i)=>launch(i+1,true,4));
  for(let i=1;i<speeds.length;i++)assert.ok(speeds[i]<=speeds[i-1]+.5,`gear ${i+1} (${speeds[i].toFixed(1)}) vs gear ${i} (${speeds[i-1].toFixed(1)})`);
});

test('automatic gearbox is unaffected',()=>{
  assert.ok(launch(1,false)>30);
});
