import {test} from 'node:test';
import assert from 'node:assert/strict';
import {recordFinish} from '../src/progression';
import {TRACKS} from '../shared/tracks';
import {TRACK_LAYOUTS} from '../shared/track-layouts';
import {CAR_IDS} from '../shared/cars';
import {PHYSICS_VERSION} from '../shared/physics';
import {runSchema,type Run} from '../shared/replay';
import {applyCheckpoints,applyFinishPlacement,applyStartPlacement,hasLocalStartPlacement,mergeCircuitSettings,placementGate} from '../src/dev-spawns';
import {Store} from '../server/store';
import {createApp} from '../server/app';
import {ENGINE_VOICES} from '../src/race-audio';

test('finishes and best medals are recorded per circuit; every car has its own engine voice',()=>{
  const track=TRACKS[0],first=recordFinish({finishes:0,medals:{}},track,track.medals[2]+1000);
  assert.deepEqual(first,{finishes:1,medals:{[track.id]:0}});
  const gold=recordFinish(first,track,track.medals[0]);assert.equal(gold.medals[track.id],3);
  assert.equal(recordFinish(gold,track,track.medals[2]+1000).medals[track.id],3,'a slower finish keeps the best medal');
  assert.deepEqual(Object.keys(ENGINE_VOICES).sort(),[...CAR_IDS].sort());
  assert.notDeepEqual(ENGINE_VOICES['red-bull-rb19'],ENGINE_VOICES['nascar-camry']);
});

test('drive-authored gates preserve position and heading; defaults restore',()=>{
  const track=structuredClone(TRACKS[0]),original=structuredClone(track.checkpoints),finish=structuredClone(track.finish),p={position:track.segments[3].start,heading:.75};
  applyCheckpoints(track,[p]);applyFinishPlacement(track,p);applyStartPlacement(track,p);
  assert.equal(track.checkpoints.length,1);assert.deepEqual(track.checkpoints[0].position,p.position);assert.equal(track.checkpoints[0].forward.x,Math.sin(.75));assert.ok(hasLocalStartPlacement(track));
  assert.ok(placementGate(track,p).segment>=0);applyCheckpoints(track);applyFinishPlacement(track);applyStartPlacement(track);
  assert.deepEqual(track.checkpoints,original);assert.deepEqual(track.finish,finish);assert.equal(hasLocalStartPlacement(track),false);
});

test('empty server circuit config does not erase locally saved annotations',()=>{
  const local={bugatti:{x:12},spa:{x:34}},server={spa:{x:56}};
  assert.deepEqual(mergeCircuitSettings(local,{}),local);
  assert.deepEqual(mergeCircuitSettings(local,server),{bugatti:{x:12},spa:{x:56}});
});

test('checked-in circuit layouts retain recovered grids, gates and road traces',()=>{
  for(const track of TRACKS){
    const layout=TRACK_LAYOUTS[track.id as keyof typeof TRACK_LAYOUTS];
    assert.deepEqual(track.start.position,layout.start.position,track.id);
    assert.deepEqual(track.finish.position,layout.finish.position,track.id);
    assert.deepEqual(track.checkpoints.map(g=>g.position),layout.checkpoints.map(p=>p.position),track.id);
    assert.ok(track.mapPath&&track.mapPath.length>=100,track.id);
    assert.ok(track.mapPath!.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)&&Number.isFinite(p.z)),track.id);
  }
});

test('replays retain drift samples and checkpoint layouts survive the API',async()=>{
  const store=new Store();await store.init();const app=await createApp(store,async()=>{throw new Error('Not used in storage test');});
  try{
    const track=TRACKS[0],run:Run={trackId:track.id,trackVersion:track.version,physicsVersion:PHYSICS_VERSION,carId:'nascar-camry',timeMs:50,inputs:[1,1,1],steering:[1.5,1.5,1.5],drift:[1.2,1.3,1.4]};
    const player=await store.createPlayer('Test Driver');await store.save(player.id,run);
    const board=await store.leaderboard(track.id,track.version),saved=await store.replay(board[0].id as string);assert.deepEqual(saved,run);
    assert.equal(runSchema.safeParse({...run,drift:[1.2]}).success,false);
    const placement={position:track.start.position,heading:.25},config={starts:{},finishes:{[track.id]:placement},roads:{},maps:{},cockpits:{},checkpoints:{[track.id]:[placement]}};
    const response=await app.inject({method:'PUT',url:'/api/dev-circuit-config',payload:config});assert.equal(response.statusCode,200,response.body);
    assert.deepEqual((await app.inject('/api/dev-circuit-config')).json(),config);
    const bad=await app.inject({method:'PUT',url:'/api/dev-circuit-config',payload:{...config,checkpoints:{[track.id]:[]}}});assert.equal(bad.statusCode,400);
  }finally{await app.close();await store.close();}
});

