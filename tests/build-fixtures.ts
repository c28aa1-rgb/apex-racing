import {mkdirSync,writeFileSync} from 'node:fs';
import {initPhysics} from '../shared/physics';
import {TRACKS} from '../shared/tracks';
import {driveTrack} from './driver';
import {validateReplay} from '../shared/replay';
await initPhysics();mkdirSync('work',{recursive:true});
const fixtures=[];
for(const track of TRACKS){await initPhysics(track);const {run,finished}=driveTrack(track);if(!finished)throw new Error(`${track.id}: test driver cannot complete the imported circuit`);
  const result=await validateReplay(run,true);fixtures.push({run,finishFrame:result.frames!.at(-1),frames:result.frames});}
writeFileSync('work/browser-fixtures.json',JSON.stringify(fixtures));console.log('Generated Node reference replays for browser compatibility checks.');
