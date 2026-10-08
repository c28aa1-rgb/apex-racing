import { chromium } from '@playwright/test';
import { gameUrl, gameReady } from './browser-page.mjs';
import { mkdir } from 'node:fs/promises';

const directory='work/track-cleanup/overlays';await mkdir(directory,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
  const page=await browser.newPage({viewport:{width:1280,height:800}});
  await page.goto(gameUrl('/'));
  await gameReady(page);
  await page.evaluate(()=>{window.__apex.frame=()=>{};document.getElementById('app').style.display='none';});
  for(const [id,index,names]of [
    ['hungaroring',10,['drs_floor_a_01.001_10','drs_floor_a_01.001_11','drs_floor_a_01.001_12']],
    ['spa',3,['groove_custom.001','groove1.001','groove3.001','groove2.001']],
    ['marina-bay',20,['11001Mtl','11001Mtl_91','11001Mtl_92']]
  ]){
    await page.evaluate(async id=>{const {TRACKS}=await import('/shared/tracks.ts'),w=window.__apex.world;w.setTrack(TRACKS.find(t=>t.id===id));w.car.visible=false;w.ghost.visible=false;w.trackGroup.visible=false;w.garageGroup.visible=false;},id);
    await page.waitForFunction(()=>window.__apex.world.venueGroup.children.length>0);
    for(const variant of ['before','after']){
      await page.evaluate(async({id,index,names,variant})=>{
        const {TRACKS}=await import('/shared/tracks.ts'),t=TRACKS.find(t=>t.id===id),w=window.__apex.world;
        const s=t.segments[Math.floor((index-1)/24*t.segments.length)],p=s.start,dx=s.end.x-p.x,dz=s.end.z-p.z,l=Math.hypot(dx,dz);
        w.venueGroup.visible=true;w.camera.position.set(p.x-dx/l*14,p.y+7,p.z-dz/l*14);w.camera.lookAt(p.x+dx/l*65,p.y+1,p.z+dz/l*65);w.camera.fov=68;w.camera.updateProjectionMatrix();
        if(variant==='after')w.venueGroup.traverse(o=>{if(!o.isMesh)return;for(const m of Array.isArray(o.material)?o.material:[o.material])if(names.includes(m.name)){m.depthWrite=false;m.polygonOffset=true;m.polygonOffsetFactor=-4;m.polygonOffsetUnits=-8;m.needsUpdate=true;}});
        w.render();
      },{id,index,names,variant});
      await page.screenshot({path:`${directory}/${id}-${variant}.png`});
    }
  }
}finally{await browser.close();}
