import {chromium} from '@playwright/test';
import {gameUrl,gameReady} from './browser-page.mjs';
import {createCanvas,loadImage} from '@napi-rs/canvas';
import {mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
await mkdir('work/cockpit-upgrade',{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
try{
  await page.goto(gameUrl('/'));await gameReady(page,{track:false});
  await page.evaluate(()=>{const g=window.__apex;g.frame=()=>{};g.setSettings({pointerLock:false});document.getElementById('app').style.display='none';});
  const ids=await page.evaluate(async()=>(await import('/shared/cars.ts')).CAR_IDS);
  for(const id of ids){
    const result=await page.evaluate(async id=>{
      const g=window.__apex,w=g.world;await g.selectCar(id);g.start(false);w.firstPerson=true;w.setCockpitOffset();w.chase(g.sim,0,true);w.render();
      const instruments=w.carRig.instruments,hash=()=>{const pixels=instruments.context.getImageData(0,0,instruments.canvas.width,instruments.canvas.height).data;let sum=0;for(let i=0;i<pixels.length;i+=13)sum=(Math.imul(sum,31)+pixels[i])|0;return sum;};
      const before=hash(),gear=4,{rotate}=await import('/shared/physics.ts'),f=rotate(g.sim.car.rotation(),{x:0,y:0,z:1});
      g.sim.car.setLinvel({x:f.x*50,y:0,z:f.z*50},true);g.sim.gear=gear;g.sim.throttle=.8;g.sim.brake=.2;g.sim.ticks=1200;
      w.chase(g.sim,.1);w.render();const after=hash(),version=instruments.texture.version;
      for(let i=0;i<6;i++){g.sim.ticks++;instruments.update(g.sim,.005,true);}const throttled=instruments.texture.version;
      g.sim.car.setLinvel({x:0,y:0,z:0},true);instruments.update(g.sim,1,false);const hidden=instruments.texture.version;
      const steering=w.carRig.steeringWheel,angleBefore=steering.quaternion.toArray();w.carRig.animate(.15,0,0);const angleAfter=steering.quaternion.toArray();
      w.carRig.animate(0,0,0);w.render();
      return {id,surfaces:instruments.surfaces.length,before,after,version,throttled,hidden,angleBefore,angleAfter,formulaMeshes:steering.children.length,draws:w.renderer.info.render.calls};
    },id);
    assert.ok(result.surfaces>0,id);assert.notEqual(result.before,result.after,`${id}: gauges should change with telemetry`);
    assert.equal(result.version,result.throttled,`${id}: throttle texture uploads`);assert.equal(result.version,result.hidden,`${id}: no hidden cockpit uploads`);
    assert.notDeepEqual(result.angleBefore,result.angleAfter,`${id}: wheel turns`);
    if(id==='red-bull-rb19')assert.ok(result.formulaMeshes<=6,'batch the new steering wheel');
    const path=`work/cockpit-upgrade/${id}-live.png`;await page.screenshot({path});
    const img=await loadImage(path),canvas=createCanvas(1440,900),ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);const pixels=ctx.getImageData(350,450,750,450).data,colors=new Set();
    for(let i=0;i<pixels.length;i+=128)colors.add(`${pixels[i]>>4}:${pixels[i+1]>>4}:${pixels[i+2]>>4}`);
    assert.ok(colors.size>25,`${id}: nonblank cockpit`);console.log(JSON.stringify(result));
  }
  await page.evaluate(async()=>{const g=window.__apex;await g.selectCar('red-bull-rb19');g.start(false);g.world.firstPerson=true;g.world.setCockpitOffset();});
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>{const g=window.__apex;g.world.chase(g.sim,.1,true);g.world.render();});
  await page.screenshot({path:'work/cockpit-upgrade/f1-mobile.png'});
  assert.deepEqual(errors,[]);console.log('All eleven cockpits: live telemetry, throttled uploads, steering animation, and rendered geometry passed.');
}finally{await browser.close();}
