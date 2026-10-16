import {test} from 'node:test';
import assert from 'node:assert/strict';
import {awardFinish,buyCar,hasAllCars,unlocked,UNLOCK_XP} from '../src/progression';
import {TRACKS} from '../shared/tracks';
import {TRACK_LAYOUTS} from '../shared/track-layouts';
import {CAR_IDS} from '../shared/cars';
import {PHYSICS_VERSION} from '../shared/physics';
import {runSchema,type Run} from '../shared/replay';
import {applyCheckpoints,applyFinishPlacement,applyStartPlacement,hasLocalStartPlacement,mergeCircuitSettings,placementGate} from '../src/dev-spawns';
import {Store} from '../server/store';
import {createApp} from '../server/app';
import {ENGINE_VOICES} from '../src/race-audio';

test('starter cars are free, others are bought with REP earned from finishes',()=>{
  const start={xp:0,finishes:0,medals:{},owned:[]},track=TRACKS[0];
  for(const id of CAR_IDS)assert.equal(unlocked(start,id),UNLOCK_XP[id]===0,id);
  assert.ok(CAR_IDS.filter(id=>UNLOCK_XP[id]===0).length>=2,'players start with a choice of cars');
  const first=awardFinish(start,track,track.medals[2]+1000);assert.equal(first.earned,200);assert.equal(first.career.finishes,1);
  assert.deepEqual(first.newCars,[]);
  const repeat=awardFinish(first.career,track,track.medals[2]+1000);assert.equal(repeat.earned,100);assert.deepEqual(repeat.newCars,['nascar-camry'],'300 REP makes the Camry affordable');
  const gold=awardFinish(repeat.career,track,track.medals[0]);assert.equal(gold.earned,250);
  assert.equal(awardFinish(gold.career,track,track.medals[0]).earned,100,'medal bonus cannot be farmed');
  assert.equal(buyCar(first.career,'nascar-camry'),undefined,'cannot buy without enough REP');
  assert.equal(buyCar(gold.career,'porsche-911-gt3'),undefined,'starter cars are never charged for');
  const bought=buyCar(gold.career,'nascar-camry')!;assert.ok(unlocked(bought,'nascar-camry'));assert.equal(bought.xp,gold.career.xp-UNLOCK_XP['nascar-camry']);
  assert.equal(buyCar(bought,'nascar-camry'),undefined,'a car is only bought once');
  assert.equal(awardFinish(bought,track,track.medals[2]+1000).career.owned.includes('nascar-camry'),true,'finishing keeps owned cars');
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

test('nicknames on the all-cars list unlock every car without spending REP',()=>{
  const store=new Map<string,string>(),previous=(globalThis as {localStorage?:unknown}).localStorage;
  (globalThis as {localStorage?:unknown}).localStorage={getItem:(k:string)=>store.get(k)??null,setItem:(k:string,v:string)=>void store.set(k,v),removeItem:(k:string)=>void store.delete(k)};
  try{
    const career={xp:0,finishes:0,medals:{},owned:[]},owned=()=>CAR_IDS.filter(id=>unlocked(career,id)).length;
    const as=(nickname:string)=>{for(const key of ['apex:player','apex:player:cloudflare'])store.set(key,JSON.stringify({id:'p',token:'t',nickname}));};
    assert.equal(hasAllCars(),false);assert.equal(owned(),3,'no nickname: starters only');
    as('Schwarber');assert.equal(owned(),CAR_IDS.length);
    as(' yoapop ');assert.equal(owned(),CAR_IDS.length);
    as('someone');assert.equal(owned(),3);
  }finally{(globalThis as {localStorage?:unknown}).localStorage=previous;}
});
