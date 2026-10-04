import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRACKS } from '../shared/tracks';
import { actorTravel, ShotRoad } from '../src/trailer/shots';
import { defaultGhostMotion, motionAt } from '../src/trailer/motion';

test('shot route sampling is deterministic, finite and bounded at both ends',()=>{
  for(const track of TRACKS){
    const road=new ShotRoad(track);
    for(const distance of [-100,0,40,road.length/2,road.length,road.length+100]){
      const a=road.sample(distance,100),b=road.sample(distance,100);
      assert.deepEqual(a.position,b.position);
      assert.ok(a.position.toArray().every(Number.isFinite));
      assert.ok(Math.abs(a.forward.length()-1)<1e-6);
      assert.ok(a.position.distanceTo(road.sample(distance).position)<=Math.max(...track.segments.map(s=>s.width))/2);
    }
  }
});
test('recorded paths replace the timing guide, retain endpoints and reject teleports',()=>{
  const path=[{x:100,y:5,z:0},{x:100,y:5,z:10},{x:110,y:5,z:10}];
  const road=new ShotRoad(TRACKS[0],path);
  assert.equal(road.recorded,true);assert.equal(road.length,20);
  assert.deepEqual(road.sample(5).position.toArray(),[100,5,5]);
  assert.deepEqual(road.sample(-5).position.toArray(),[100,5,0]);
  assert.ok(road.sample(25).position.distanceTo(road.sample(20).position)<.001);
  assert.throws(()=>new ShotRoad(TRACKS[0],[path[0],{x:500,y:0,z:0}]),/jump/);
});
test('independent motion supports acceleration, delay, opposing directions and separation',()=>{
  const base={speed:36,endSpeed:72,offset:0,lane:0,endLane:3,direction:1 as const,delay:0};
  assert.equal(motionAt(base,10,10).distance,150);
  assert.equal(motionAt({...base,delay:2},1,10).distance,0);
  assert.equal(motionAt({...base,direction:-1},10,10).distance,-150);
  assert.equal(motionAt(base,10,10).lane,3);
  const ghosts=defaultGhostMotion();
  assert.equal(ghosts.length,4);
  assert.notEqual(motionAt(ghosts[0],4,8).distance,motionAt(ghosts[1],4,8).distance);
  assert.ok(motionAt(ghosts[1],0,8).position<motionAt(ghosts[0],0,8).position);
  assert.deepEqual(motionAt(base,3,10),motionAt(base,3,10));
});
test('closed recordings join without a position or heading jump',()=>{
  const path=[{x:0,y:0,z:0},{x:0,y:0,z:50},{x:50,y:0,z:50},{x:50,y:0,z:0},{x:1,y:0,z:0}];
  const road=new ShotRoad(TRACKS[0],path);
  assert.equal(road.closed,true);assert.equal(road.length,200);
  const before=road.sample(road.length-.0001),after=road.sample(.0001);
  assert.ok(before.position.distanceTo(after.position)<.001);
  assert.ok(before.forward.distanceTo(after.forward)<.001);
});
test('staged motion supports stationary shots, launch and a repeatable overtake',()=>{
  assert.equal(actorTravel('pit',4,0),0);
  assert.equal(actorTravel('grid',4,3),0);
  assert.ok(actorTravel('launch',4,0)>actorTravel('launch',2,0)*2);
  assert.ok(actorTravel('overtake',6,1)>actorTravel('overtake',6,0));
  assert.equal(actorTravel('drone',3,0),actorTravel('drone',3,2));
});
