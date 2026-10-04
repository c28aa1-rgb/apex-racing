import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ValidationQueue} from '../server/validator';
import {initPhysics} from '../shared/physics';
import {trackById} from '../shared/tracks';
import {driveTrack} from './driver';

test('production worker replays real inputs and rejects forged times without blocking the API thread',async()=>{
  await initPhysics(trackById('indianapolis')!);const {run}=driveTrack(trackById('indianapolis')!);
  const queue=new ValidationQueue(new URL('../dist-server/validation-worker.mjs',import.meta.url));
  try{
    const result=await queue.validate(run);assert.equal(result.timeMs,run.timeMs);
    await assert.rejects(queue.validate({...run,timeMs:1}),/does not match/);
    const next=await queue.validate(run);assert.equal(next.timeMs,run.timeMs);
  }finally{await queue.close();}
});
