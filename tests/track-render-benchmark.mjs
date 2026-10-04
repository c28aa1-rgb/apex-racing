import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
const browser=await chromium.launch({channel:'chrome',headless:true}),results=[];
try{
  for(const variant of ['legacy','clean']){
    const page=await browser.newPage({viewport:{width:1280,height:800}});
    await page.goto('http://127.0.0.1:5173/');
    await page.waitForFunction(()=>window.__apex?.state.modelReady&&window.__apex.state.trackReady);
    const ids=await page.evaluate(async variant=>{
      const {TRACKS}=await import('/shared/tracks.ts'),g=window.__apex,w=g.world;g.frame=()=>{};
      document.getElementById('app').style.display='none';
      if(variant==='legacy'){
        const loader=w.loader,load=loader.loadAsync.bind(loader),split=w.splitVenueForCulling.bind(w);
        loader.loadAsync=url=>load(url.replace('.clean.glb','.race.glb'));w.splitVenueForCulling=root=>split(root,420,64);
      }
      return TRACKS.map(t=>t.id);
    },variant);
    for(const id of ids){
      await page.evaluate(async id=>{
        const {TRACKS}=await import('/shared/tracks.ts'),w=window.__apex.world;w.setTrack(TRACKS.find(t=>t.id===id));
        w.car.visible=false;w.ghost.visible=false;w.trackGroup.visible=false;w.garageGroup.visible=false;
      },id);
      await page.waitForFunction(()=>window.__apex.world.venueGroup.children.length>0);
      const samples=await page.evaluate(async id=>{
        const {TRACKS,spawnGate}=await import('/shared/tracks.ts'),t=TRACKS.find(t=>t.id===id),w=window.__apex.world,gl=w.renderer.getContext();
        w.venueGroup.visible=true;const samples=[];
        for(const fraction of [0,.25,.5,.75]){
          const s=t.segments[Math.floor(t.segments.length*fraction)],p=fraction===0?spawnGate(t).position:s.start;
          const f=fraction===0?spawnGate(t).forward:{x:s.end.x-s.start.x,y:s.end.y-s.start.y,z:s.end.z-s.start.z};
          const length=Math.hypot(f.x,f.z);w.camera.position.set(p.x-f.x/length*14,p.y+7,p.z-f.z/length*14);
          w.camera.lookAt(p.x+f.x/length*65,p.y+1,p.z+f.z/length*65);w.camera.fov=68;w.camera.updateProjectionMatrix();
          for(let i=0;i<5;i++){w.render();gl.finish();await new Promise(requestAnimationFrame);}
          const times=[];
          for(let i=0;i<16;i++){const start=performance.now();w.render();gl.finish();times.push(performance.now()-start);await new Promise(requestAnimationFrame);}
          times.sort((a,b)=>a-b);samples.push({fraction,triangles:w.renderer.info.render.triangles,calls:w.renderer.info.render.calls,medianMs:times[8]});
        }return samples;
      },id);
      results.push({id,variant,samples});console.log(variant,id,samples.map(s=>({tris:s.triangles,ms:s.medianMs})));
    }await page.close();
  }
  await writeFile('work/track-cleanup/render-benchmark.json',JSON.stringify(results,null,2));
}finally{await browser.close();}
