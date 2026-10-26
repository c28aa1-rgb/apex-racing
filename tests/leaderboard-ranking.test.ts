import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store';
import { TRACKS } from '../shared/tracks';
import { PHYSICS_VERSION } from '../shared/physics-version';
import type { Run } from '../shared/replay';

test('leaderboard ties share ranks and skip occupied places without changing row order',async()=>{
  const store=new Store();await store.init();
  const track=TRACKS[0],run:Run={trackId:track.id,trackVersion:track.version,physicsVersion:PHYSICS_VERSION,carId:'porsche-911-gt3',timeMs:1000,inputs:[1]};
  try{
    const players:{id:string}[]=[];
    for(const [i,time] of [3000,1000,2000,1000,2000].entries()){
      const player=await store.createPlayer(`Driver ${i}`);players.push(player);
      await store.save(player.id,{...run,timeMs:time});
      await store.query('UPDATE scores SET created_at=$2 WHERE player_id=$1',[player.id,new Date(Date.UTC(2026,0,1,0,0,i)).toISOString()]);
    }
    await store.save(players[0].id,{...run,trackVersion:track.version+1,timeMs:1});
    await store.save(players[0].id,{...run,trackId:TRACKS[1].id,timeMs:1});
    const board=await store.leaderboard(track.id,track.version);
    assert.deepEqual(board.map(row=>row.rank),[1,1,3,3,5]);
    assert.deepEqual(board.map(row=>row.playerId),[1,3,2,4,0].map(i=>players[i].id));
    assert.deepEqual((await store.leaderboard(track.id,track.version)).map(row=>row.id),board.map(row=>row.id));
    await store.save(players[0].id,run);
    const updated=await store.leaderboard(track.id,track.version);
    assert.deepEqual(updated.map(row=>row.rank),[1,1,1,4,4]);
    assert.equal(updated.find(row=>row.playerId===players[0].id)?.id,board[4].id,'rank changes preserve the saved replay');
  }finally{await store.close();}
});
