import {test} from 'node:test';
import assert from 'node:assert/strict';
import {awardFinish,unlocked,UNLOCK_XP} from '../src/progression';
import {TRACKS} from '../shared/tracks';
import {CAR_IDS} from '../shared/cars';
import {PHYSICS_VERSION} from '../shared/physics';
import {runSchema,type Run} from '../shared/replay';
import {applyCheckpoints,applyFinishPlacement,applyStartPlacement,hasLocalStartPlacement,placementGate} from '../src/dev-spawns';
import {Store} from '../server/store';
import {createApp} from '../server/app';
import {ENGINE_VOICES} from '../src/race-audio';

test('all cars are unlocked while finishes still award progression XP',()=>{
  const start={xp:0,finishes:0,medals:{}},track=TRACKS[0];
  for(const id of CAR_IDS)assert.ok(unlocked(start,id),id);
  const first=awardFinish(start,track,track.medals[2]+1000);assert.equal(first.earned,200);assert.equal(first.career.finishes,1);
  assert.deepEqual(first.newCars,[]);
  const repeat=awardFinish(first.career,track,track.medals[2]+1000);assert.equal(repeat.earned,100);assert.deepEqual(repeat.newCars,[]);
  const gold=awardFinish(repeat.career,track,track.medals[0]);assert.equal(gold.earned,250);
  assert.equal(awardFinish(gold.career,track,track.medals[0]).earned,100,'medal bonus cannot be farmed');
  assert.deepEqual(Object.keys(UNLOCK_XP).sort(),[...CAR_IDS].sort());assert.deepEqual(Object.keys(ENGINE_VOICES).sort(),[...CAR_IDS].sort());
  assert.notDeepEqual(ENGINE_VOICES['red-bull-rb19'],ENGINE_VOICES['nascar-camry']);
});

test('drive-authored gates preserve position and heading; defaults restore',()=>{
  const track=structuredClone(TRACKS[0]),original=structuredClone(track.checkpoints),finish=structuredClone(track.finish),p={position:track.segments[3].start,heading:.75};
  applyCheckpoints(track,[p]);applyFinishPlacement(track,p);applyStartPlacement(track,p);
  assert.equal(track.checkpoints.length,1);assert.deepEqual(track.checkpoints[0].position,p.position);assert.equal(track.checkpoints[0].forward.x,Math.sin(.75));assert.ok(hasLocalStartPlacement(track));
  assert.ok(placementGate(track,p).segment>=0);applyCheckpoints(track);applyFinishPlacement(track);applyStartPlacement(track);
  assert.deepEqual(track.checkpoints,original);assert.deepEqual(track.finish,finish);assert.equal(hasLocalStartPlacement(track),false);
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
