import { chromium } from '@playwright/test';
import { gameUrl, gameReady } from './browser-page.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
const out='work/cockpit-upgrade';await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:900}});
const picks={
  'ferrari-488-gt3':[[720,602]],'mclaren-720s-gt3':[[720,618]],'bugatti-bolide':[[745,565]],
  'peugeot-9x8':[[720,736]],'porsche-963':[[725,746]],'mazda-787b':[[728,639]],
  'porsche-911-gt3':[[720,600],[820,623],[619,623],[885,663],[551,663]],
  'skyline-r34':[[652,635],[779,635]],'celica-gt4':[[748,586]],'nascar-camry':[[718,435]],
};
try{
  await page.goto(gameUrl('/'));await gameReady(page,{track:false});
  await page.evaluate(()=>{const g=window.__apex;g.frame=()=>{};g.setSettings({pointerLock:false});document.getElementById('app').style.display='none';});
  const ids=process.argv.slice(2);const results=[];
  for(const id of ids.length?ids:await page.evaluate(async()=> (await import('/shared/cars.ts')).CAR_IDS)){
    const result=await page.evaluate(async ({id,picks})=>{
      const g=window.__apex,w=g.world;await g.selectCar(id);g.start(false);w.firstPerson=true;w.setCockpitOffset();w.chase(g.sim,0,true);w.render();
      const parts=[];w.car.traverse(o=>{if(o.isMesh&&/dash|gauge|instrument|dial|display|steer|cockpit|interior/i.test(o.name)){o.geometry.computeBoundingBox();const b=o.geometry.boundingBox;parts.push({name:o.name,min:b.min.toArray(),max:b.max.toArray()});}});
      const wheel=w.car.getObjectByName('apex-steering-wheel');
      const T=await import('/node_modules/.vite/deps/three.js');
      const hits=(picks??[]).map(([x,y])=>{const ray=new T.Raycaster();ray.setFromCamera(new T.Vector2(x/1440*2-1,1-y/900*2),w.camera);return ray.intersectObject(w.car,true).slice(0,5).map(h=>({name:h.object.name,p:w.car.worldToLocal(h.point.clone()).toArray(),normal:h.face.normal.clone().transformDirection(h.object.matrixWorld).applyQuaternion(w.car.quaternion.clone().invert()).toArray(),distance:h.distance}));});
      return {id,eye:w.cockpitEye?.toArray(),steering:wheel?.position.toArray(),axis:wheel?.userData.axis,parts,hits,draws:w.renderer.info.render.calls};
    },{id,picks:picks[id]});
    await page.screenshot({path:`${out}/${id}.png`});results.push(result);console.log(JSON.stringify(result));
  }
  await writeFile(`${out}/audit.json`,JSON.stringify(results,null,2));
}finally{await browser.close();}
