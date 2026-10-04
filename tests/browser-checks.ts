import { validateReplay, type Run } from '../shared/replay';
import { initPhysics, Simulation, type Frame } from '../shared/physics';
import { TRACKS } from '../shared/tracks';
import { RaceWorld } from '../src/world';

type Fixture={run:Run;finishFrame:Frame;frames:Frame[]};
document.querySelector('#run')!.addEventListener('click',async()=>{
  const results=document.querySelector('#results')!;results.replaceChildren();
  const add=(message:string)=>{const li=document.createElement('li');li.textContent=message;results.append(li);};
  try{
    const fixtures:Fixture[]=await(await fetch('/work/browser-fixtures.json')).json();
    for(const fixture of fixtures){
      const result=await validateReplay(fixture.run,true);
      const identical=JSON.stringify(result.frames)===JSON.stringify(fixture.frames);
      if(!identical)throw new Error(`${fixture.run.trackId}: browser/Node trajectory mismatch`);
      add(`PASS ${fixture.run.trackId}: ${result.ticks} ticks, ${result.timeMs} ms; every browser frame matches Node exactly.`);
    }
    await initPhysics();const sim=new Simulation(TRACKS[0]),world=new RaceWorld(document.querySelector('#benchmark')!);world.setTrack(TRACKS[0]);
    let count=0;const started=performance.now();
    const benchmark=(now:number)=>{sim.step(fixtures[0].run.inputs[count]??1);world.chase(sim,1/60);world.render();count++;
      if(count<150)requestAnimationFrame(benchmark);else{
        const fps=Math.round(count*1000/(now-started));add(`PASS WebGL render: ${count} frames, ${fps} average FPS, ${world.renderer.info.render.calls} draw calls.`);sim.dispose();
        document.querySelector('#details')!.textContent='All browser checks complete.';
      }
    };requestAnimationFrame(benchmark);
  }catch(error){add(`FAIL ${error instanceof Error?error.message:String(error)}`);}
});
