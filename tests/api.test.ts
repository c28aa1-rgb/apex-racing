import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store';
import { createApp } from '../server/app';
import { initPhysics } from '../shared/physics';
import { validateReplay } from '../shared/replay';
import { trackById } from '../shared/tracks';
import { driveTrack } from './driver';

test('full API: anonymous identity, real replay validation, best-only ranking, ghost fetch, auth and persistence',async()=>{
  await initPhysics(trackById('indianapolis')!);const directory=await mkdtemp(join(tmpdir(),'apex-api-test-'));
  const track=trackById('indianapolis')!;
  const store=new Store(undefined,directory);await store.init();const app=await createApp(store,run=>validateReplay(run));
  let playerId='';
  try{
    const {run}=driveTrack(track);
    assert.equal((await app.inject({url:'/api/health'})).statusCode,200);
    const playerResponse=await app.inject({method:'POST',url:'/api/players',payload:{nickname:'Test Driver'}});
    assert.equal(playerResponse.statusCode,201);const player=playerResponse.json();playerId=player.id;
    const headers={authorization:`Bearer ${player.token}`};
    assert.equal((await app.inject({method:'POST',url:'/api/runs',payload:run})).statusCode,401);
    assert.equal((await app.inject({method:'POST',url:'/api/runs',headers,payload:{...run,timeMs:1}})).statusCode,422);
    const saved=await app.inject({method:'POST',url:'/api/runs',headers,payload:run});
    assert.equal(saved.statusCode,201,saved.body);assert.equal(saved.json().improved,true);assert.equal(saved.json().entries[0].rank,1);
    const duplicate=await app.inject({method:'POST',url:'/api/runs',headers,payload:run});assert.equal(duplicate.json().improved,false);
    const board=(await app.inject({url:`/api/leaderboards/${track.id}`})).json();assert.equal(board.entries.length,1);
    assert.equal(board.entries[0].timeMs,run.timeMs);assert.equal(board.entries[0].nickname,'Test Driver');
    const replay=(await app.inject({url:`/api/replays/${board.entries[0].id}`})).json();assert.deepEqual(replay,run);
    assert.equal((await app.inject({method:'PUT',url:'/api/players/me',headers,payload:{nickname:'New Driver'}})).statusCode,200);
    assert.equal((await app.inject({url:`/api/leaderboards/${track.id}`})).json().entries[0].nickname,'New Driver');
    assert.equal((await app.inject({url:'/api/leaderboards/no-track'})).statusCode,404);
    assert.equal((await app.inject({method:'POST',url:'/api/players',payload:{nickname:'<script>'}})).statusCode,400);
    const rows=await store.query('SELECT token_hash FROM players WHERE id=$1',[player.id]);assert.notEqual(rows[0].token_hash,player.token);
  }finally{await app.close();await store.close();}
  const reopened=new Store(undefined,directory);await reopened.init();try{
    const entries=await reopened.leaderboard(track.id,track.version);assert.equal(entries.length,1);assert.equal(entries[0].playerId,playerId);
  }finally{await reopened.close();}
});
