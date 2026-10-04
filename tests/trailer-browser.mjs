import { chromium } from '@playwright/test';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

const directory='work/trailer-checks';await mkdir(directory,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:900}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
try {
  // Test-only driven traces, never written to the user's circuit configuration.
  const maps={
    bugatti:Array.from({length:36},(_,i)=>({x:18+i*.16,y:.11+i*.03,z:90-i*5})),
    'marina-bay':Array.from({length:71},(_,i)=>({x:-610-i*.16,y:47.3,z:400-i*5}))
  };
  await page.route('**/api/dev-circuit-config',route=>route.fulfill({json:{maps}}));
  await page.goto(`${process.env.GAME_URL??'http://127.0.0.1:5174'}/dev/trailer`);
  await page.waitForFunction(()=>window.__trailer?.ready,undefined,{timeout:120000});
  for(const shot of ['pit','grid','launch','curb','drone','wheel','overtake','finish']) {
    await page.evaluate(async shot=>{await window.__trailer.selectShot(shot);window.__trailer.playing=false;window.__trailer.seek(window.__trailer.duration/2);},shot);
    const state=await page.evaluate(()=>{
      const d=window.__trailer;
      const poses=d.actors.map(a=>a.root.position.toArray());d.seek(0);d.seek(d.duration/2);
      return {ready:d.ready,error:d.error,count:d.actors.length,poses,again:d.actors.map(a=>a.root.position.toArray()),camera:d.world.camera.position.toArray()};
    });
    assert.equal(state.ready,true,state.error);assert.equal(state.count,3);assert.deepEqual(state.poses,state.again);
    assert.ok(state.camera.every(Number.isFinite));
    await page.keyboard.press('h');
    const path=`${directory}/${shot}.png`;await page.screenshot({path});
    const img=await loadImage(path),canvas=createCanvas(img.width,img.height),ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);
    const pixels=ctx.getImageData(0,0,img.width,img.height).data,colors=new Set();
    for(let i=0;i<pixels.length;i+=128)colors.add(`${pixels[i]>>4},${pixels[i+1]>>4},${pixels[i+2]>>4}`);
    assert.ok(colors.size>25,`${shot}: blank canvas (${colors.size} colors)`);
    await page.keyboard.press('h');console.log(`${shot}: ${colors.size} colors, repeatable 3-car staging`);
  }
  await page.getByLabel('Cars',{exact:true}).selectOption('4');
  await page.waitForFunction(()=>window.__trailer.ready&&window.__trailer.actors.length===4);
  await page.getByLabel('Action',{exact:true}).selectOption('approach');
  const motion=await page.evaluate(()=>{
    const d=window.__trailer;d.playing=false;d.seek(0);
    const before=d.actors.map(a=>a.root.position.toArray());
    const separation=d.actors[0].root.position.distanceTo(d.actors[1].root.position);
    d.seek(1);
    return {before,after:d.actors.map(a=>a.root.position.toArray()),separation,afterGap:d.actors[0].root.position.distanceTo(d.actors[1].root.position),recorded:d.routeAvailable};
  });
  assert.equal(motion.recorded,true);assert.notDeepEqual(motion.before,motion.after);assert.ok(motion.afterGap<motion.separation);
  await page.getByRole('button',{name:'Play',exact:true}).click();
  await page.waitForFunction(()=>window.__trailer.time>.15);
  await page.getByRole('button',{name:'Pause',exact:true}).click();
  const before=await page.evaluate(()=>window.__trailer.time);
  await page.getByRole('button',{name:'Step one frame'}).click();
  assert.ok(Math.abs(await page.evaluate(()=>window.__trailer.time)-before-1/60)<1e-6);
  await page.getByRole('button',{name:'Reset shot'}).click();
  assert.equal(await page.evaluate(()=>window.__trailer.time),0);
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:`${directory}/mobile.png`});
  assert.equal(await page.locator('.trailer-transport').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  assert.equal(await page.locator('.trailer-panel').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  await page.getByRole('button',{name:'Hide controls'}).click();
  assert.equal(await page.locator('.trailer-ui').isVisible(),false);
  await page.keyboard.press('Escape');assert.equal(await page.locator('.trailer-ui').isVisible(),true);
  await page.getByLabel('Circuit',{exact:true}).selectOption('spa');
  await page.waitForFunction(()=>window.__trailer.ready&&!window.__trailer.routeAvailable);
  assert.equal(await page.getByRole('button',{name:'Play',exact:true}).isDisabled(),true);
  assert.equal(await page.getByLabel('Route position (m)').isDisabled(),true);
  assert.deepEqual(errors,[]);console.log('Passed transport, four cars, mobile layout, hidden controls and browser errors.');
}finally{await browser.close();}
