import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {gameUrl,gameReady} from './browser-page.mjs';

const browser=await chromium.launch({channel:'chrome',headless:true}),errors=[];
try{
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(gameUrl('/'));await gameReady(page,{track:false});
  await page.evaluate(async()=>{
    const {CITY}=await import('/shared/tracks.ts'),g=window.__apex;
    g.frame=()=>{};g.setSettings({advancedDriving:true,pointerLock:false});
    await g.enterTraining(CITY);
  });
  await page.waitForFunction(()=>!window.__apex.state.venueLoad);
  const ready=await page.evaluate(()=>{const g=window.__apex;return {track:g.sim.track.id,manual:g.sim.manual,gearDrift:g.sim.gearDrift,traffic:!!g.world.traffic};});
  assert.equal(ready.track,'racing-city');assert.equal(ready.manual,true);assert.equal(ready.gearDrift,true);assert.equal(ready.traffic,true);
  await page.keyboard.down('ShiftLeft');
  assert.equal(await page.evaluate(()=>window.__apex.input()),0,'manual ignores Shift');
  await page.keyboard.down('w');await page.keyboard.down('a');
  const slide=await page.evaluate(async()=>{
    const {telemetry}=await import('/tests/handling-harness.ts'),g=window.__apex;
    for(let i=0;i<30;i++)g.sim.step(0);
    g.sim.car.setLinvel({x:0,y:0,z:18},true);
    for(let i=0;i<60;i++){
      g.sim.step(g.input());g.world.chase(g.sim,1/60);g.world.skidMarks.update(g.sim,true);
    }
    g.world.render();return {...telemetry(g.sim),marks:g.world.skidMarks.mesh.geometry.drawRange.count,hits:g.sim.hitCount};
  });
  assert.ok(slide.slip < -12&&slide.slip > -65,JSON.stringify(slide));
  assert.ok(slide.speed>14);assert.equal(slide.contacts,4);assert.equal(slide.hits,0);assert.ok(slide.marks>0);
  await mkdir('work/drift-port',{recursive:true});
  await page.evaluate(async()=>{await new Promise(requestAnimationFrame);window.__apex.world.render();await new Promise(requestAnimationFrame);window.__apex.world.render();});
  await page.screenshot({path:'work/drift-port/city-manual-drift.png'});
  await page.keyboard.up('a');
  const exit=await page.evaluate(async()=>{
    const {telemetry}=await import('/tests/handling-harness.ts'),g=window.__apex;
    for(let i=0;i<60;i++){g.sim.step(g.input());g.world.chase(g.sim,1/60);}
    return {...telemetry(g.sim),gear:g.sim.gear};
  });
  assert.ok(Math.abs(exit.slip)<3,'holding throttle and releasing steering exits the slide');
  assert.equal(exit.gear,1);
  await page.keyboard.up('w');
  await page.evaluate(()=>{window.__apex.setSettings({advancedDriving:false});window.__apex.restart();});
  const automatic=await page.evaluate(()=>({manual:window.__apex.sim.manual,input:window.__apex.input()}));
  assert.equal(automatic.manual,false);assert.equal(automatic.input,0,'restart clears held keys');
  await page.keyboard.up('ShiftLeft');await page.keyboard.down('ShiftLeft');
  assert.equal(await page.evaluate(()=>window.__apex.input()),16,'automatic keeps Shift');
  await page.keyboard.up('ShiftLeft');assert.deepEqual(errors,[]);
  const result={ready,slide,exit,automatic,errors};
  await writeFile('work/drift-port/city-browser.json',JSON.stringify(result,null,2));console.log(result);
}finally{await browser.close();}
