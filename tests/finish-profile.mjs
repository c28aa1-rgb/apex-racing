import {chromium} from '@playwright/test';
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  await page.goto('http://127.0.0.1:5173/');await page.waitForFunction(()=>window.__apex?.state.modelReady);
  await page.evaluate(()=>{const g=window.__apex;g.setSettings({pointerLock:false});g.start(false);});
  await page.waitForTimeout(1500);
  console.log(await page.evaluate(async()=>{
    const g=window.__apex,w=g.world,frames=[],programsBefore=w.renderer.info.programs.length;
    let last=performance.now(),finishCPU=0,firstRenderCPU=0;
    for(let i=0;i<65;i++){
      await new Promise(requestAnimationFrame);const now=performance.now();frames.push(now-last);last=now;
      if(i===10){const f=g.state.track.finish.forward;g.sim.car.setLinvel({x:f.x*65,y:0,z:f.z*65},true);g.sim.finished=true;const start=performance.now();g.finish();finishCPU=performance.now()-start;const renderStart=performance.now();w.render();firstRenderCPU=performance.now()-renderStart;}
    }
    return {finishCPU,firstRenderCPU,programsBefore,programsAfter:w.renderer.info.programs.length,aroundFinish:frames.slice(8,17),maxFrame:Math.max(...frames),speed:g.sim.speed};
  }));
}finally{await browser.close();}
