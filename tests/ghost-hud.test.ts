import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { initPhysics, Simulation, Input, PHYSICS_VERSION } from '../shared/physics';
import { TRACKS, orientation } from '../shared/tracks';
import type { Run } from '../shared/replay';
import { ghostCheckpointTimes, ghostGap, formatGhostGap } from '../src/ghost-timing';
import { minimapLayout, minimapHeading } from '../src/minimap';
import { Game, type GameState } from '../src/game';
import { handlingTrack } from './handling-harness';

before(()=>initPhysics());
const track=handlingTrack();
track.checkpoints=[20,45].map(z=>({...track.start,position:{x:0,y:0,z}}));
track.finish={...track.start,position:{x:0,y:0,z:80}};
function recordedRun(weather:'clear'|'rain'='clear') {
  const sim=new Simulation(track,'porsche-911-gt3'),inputs:number[]=[];
  sim.weather=weather;
  try{
    while(!sim.finished&&sim.ticks<2000){inputs.push(Input.Throttle);sim.step(Input.Throttle);}
    assert.ok(sim.finished);
    return {run:{trackId:track.id,trackVersion:track.version,physicsVersion:PHYSICS_VERSION,carId:sim.carSpec.id,timeMs:sim.timeMs,inputs,...(weather==='rain'?{weather}:{})} satisfies Run,splits:[...sim.splits]};
  }finally{sim.dispose();}
}
test('ghost checkpoints come from the same replay, including weather, before the live ghost arrives',async()=>{
  for(const weather of ['clear','rain'] as const){
    const {run,splits}=recordedRun(weather);
    assert.deepEqual(await ghostCheckpointTimes(track,run,()=>true),splits);
    assert.equal(splits.length,2);
    assert.equal(ghostGap(splits[0]-1200,splits[0]),-1200);
    assert.equal(ghostGap(splits[1]+2350,splits[1]),2350);
  }
});
test('checkpoint gaps carry a sign and three decimal places',()=>{
  assert.equal(formatGhostGap(-1200),'-1.200');assert.equal(formatGhostGap(2350),'+2.350');
  assert.equal(formatGhostGap(0),'+0.000');assert.equal(formatGhostGap(-17),'-0.017');
});
test('timing preparation yields and discards an abandoned race',async t=>{
  const {run}=recordedRun();let clock=0,active=true;
  t.mock.method(performance,'now',()=>clock+=6);
  const pending=ghostCheckpointTimes(track,run,()=>active);active=false;
  assert.equal(await pending,undefined);
});
test('a mismatched layout or forged ghost time cannot produce checkpoint comparisons',async()=>{
  const {run}=recordedRun();
  await assert.rejects(ghostCheckpointTimes(track,{...run,trackVersion:run.trackVersion+1},()=>true),/layout/);
  await assert.rejects(ghostCheckpointTimes(track,{...run,timeMs:run.timeMs-1000},()=>true),/timing/);
  await assert.rejects(ghostCheckpointTimes(track,{...run,inputs:[...run.inputs,0]},()=>true),/after the finish/);
});
test('the game compares matching checkpoints, not the cars positions or current elapsed times',()=>{
  const game=Object.create(Game.prototype) as unknown as {
    sim:{checkpoint:number;splits:number[]};state:Partial<GameState>;ghostSplits:number[];
    partyRace?:unknown;emit:(patch:Partial<GameState>)=>void;updateGhostSplit:()=>void;
  };
  game.state={ghost:true};game.emit=patch=>{game.state={...game.state,...patch};};
  game.sim={checkpoint:1,splits:[4000]};game.ghostSplits=[5200,9000];game.updateGhostSplit();
  assert.deepEqual(game.state.ghostSplit,{checkpoint:1,ms:-1200});
  game.sim={checkpoint:2,splits:[4000,11350]};game.updateGhostSplit();
  assert.deepEqual(game.state.ghostSplit,{checkpoint:2,ms:2350});
});
test('the finish marker uses the actual gate even when the map trace ends elsewhere',()=>{
  for(const source of TRACKS){
    const copy=structuredClone(source),last=copy.mapPath!.at(-1)!;
    copy.finish.position={x:last.x+30,y:last.y,z:last.z+40};
    const layout=minimapLayout(copy);
    assert.deepEqual(layout.finish,layout.project(copy.finish.position));
    assert.notDeepEqual(layout.finish,layout.project(last));
    assert.ok(layout.finish.x>=23&&layout.finish.x<=147&&layout.finish.y>=23&&layout.finish.y<=147);
  }
});
test('map headings follow native axes and degenerate traces stay finite',()=>{
  for(const [forward,angle] of [[{x:0,y:0,z:-1},0],[{x:1,y:0,z:0},90],[{x:0,y:0,z:1},180]] as const)
    assert.ok(Math.abs(Math.abs(minimapHeading(orientation(forward)))-angle)<.001);
  const copy=structuredClone(track);copy.mapPath=[{x:0,y:0,z:0}];copy.finish.position={x:0,y:0,z:0};
  assert.equal(minimapLayout(copy).line,'85,85');
});
