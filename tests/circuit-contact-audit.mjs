import { chromium } from '@playwright/test';
import { gameUrl, gameReady } from './browser-page.mjs';
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  await page.goto(gameUrl('/'));
  await gameReady(page);
  console.log(JSON.stringify(await page.evaluate(async()=>{
    const {TRACKS}=await import('/shared/tracks.ts'),{Simulation,initPhysics,rotate}=await import('/shared/physics.ts');
    const g=window.__apex,w=g.world;g.frame=()=>{};const track=TRACKS.find(t=>t.id==='bugatti');await initPhysics(track);
    g.sim.dispose();g.sim=new Simulation(track,'celica-gt4');g.sim.steeringStrength=1.1;await w.setCar('celica-gt4');w.setTrack(track);
    const f=rotate(g.sim.car.rotation(),{x:0,y:0,z:1}),speed=40*.44704/track.metersPerUnit;g.sim.car.setLinvel({x:f.x*speed,y:f.y*speed,z:f.z*speed},true);w.chase(g.sim,1/60,true);
    const worst=[];
    for(let tick=0;tick<150;tick++){
      g.sim.step(tick<45?1:tick<65?5:2);w.chase(g.sim,1/60);w.car.updateMatrixWorld(true);
      for(const [i,wheel] of w.wheelGroups.entries()){
        const center=wheel.getWorldPosition(w.center.clone()),floor=g.sim.visibleGroundAt(center),clearance=center.y-wheel.userData.radius-floor;
        if(clearance<-.035){worst.push({tick,i,center:center.toArray(),floor,clearance,rest:wheel.userData.rest,local:wheel.position.toArray(),cachedFloor:w.visibleWheelFloors[i],position:g.sim.car.translation()});}
      }
    }
    return worst.sort((a,b)=>a.clearance-b.clearance).slice(0,8);
  }),null,2));
}finally{await browser.close();}
