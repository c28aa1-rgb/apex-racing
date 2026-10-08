import { chromium } from '@playwright/test';
import { gameUrl, gameReady } from './browser-page.mjs';
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:900}});
try{
  await page.goto(gameUrl('/'));
  await gameReady(page);
  for(const id of ['porsche-911-gt3','mazda-787b','bugatti-bolide']){
    await page.evaluate(id=>window.__apex.selectCar(id),id);
    await page.waitForFunction(()=>window.__apex.state.modelReady);
    await page.evaluate(()=>{
      const g=window.__apex,w=g.world;window.originalChase??=w.chase;
      w.chase=window.originalChase;g.start(false);g.pause();g.sim.steering=.23;g.sim.brake=1;w.firstPerson=false;
      w.chase(g.sim,1/60,true);w.chase=()=>{};
      document.querySelector('#app').style.visibility='hidden';
    });
    for(const angle of ['rear','front']){
      await page.evaluate(angle=>{
        const w=window.__apex.world,offset=w.center.clone().set(3.5,1.4,angle==='rear'?-5.5:5.5).applyQuaternion(w.car.quaternion);
        w.camera.position.copy(w.car.position).add(offset);w.camera.up.set(0,1,0);w.camera.lookAt(w.car.position);w.camera.fov=45;w.camera.updateProjectionMatrix();w.render();
      },angle);
      await page.screenshot({path:`work/${id}-rig-${angle}.png`});
    }
  }
}finally{await browser.close();}
