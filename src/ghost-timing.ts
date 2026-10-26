import { Simulation } from '../shared/physics';
import { stepReplay, type Run } from '../shared/replay';
import type { Track } from '../shared/tracks';

/** Replay ahead cooperatively, so a faster driver can get a negative split without waiting for the ghost. */
export async function ghostCheckpointTimes(track:Track,run:Run,active:()=>boolean):Promise<number[]|undefined> {
  if(run.trackId!==track.id||run.trackVersion!==track.version)throw new Error('Ghost layout does not match this circuit.');
  const sim=new Simulation(track,run.carId,run.origin);
  try {
    let deadline=performance.now()+5;
    for(let i=0;i<run.inputs.length;i++){
      if(!active())return;
      stepReplay(sim,run);
      if(sim.finished&&i!==run.inputs.length-1)throw new Error('Ghost contains inputs after the finish.');
      if(performance.now()>=deadline){await new Promise<void>(resolve=>setTimeout(resolve,0));deadline=performance.now()+5;}
    }
    if(!active())return;
    if(!sim.finished||sim.timeMs!==run.timeMs)throw new Error('Ghost timing does not match its replay.');
    return [...sim.splits];
  }finally{sim.dispose();}
}

export const ghostGap=(player:number,ghost:number)=>player-ghost;
export const formatGhostGap=(ms:number)=>`${ms<0?'-':'+'}${(Math.abs(ms)/1000).toFixed(3)}`;
