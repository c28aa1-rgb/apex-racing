// Actual replay timing on a short, browser-local practice layout. No server circuit writes.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { gameUrl, gameReady } from './browser-page.mjs';

const shots=process.env.SHOTS??'work/ghost-hud';
await mkdir(shots,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-angle=metal','--enable-gpu']});
const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
page.on('pageerror',error=>errors.push(error.message));
try{
  await page.goto(gameUrl('/'));await gameReady(page);
  await page.evaluate(()=>{const g=window.__apex;g.setSettings({pointerLock:false});g.start(false);});
  await page.locator('[data-marker="finish"]').waitFor();
  await page.waitForTimeout(350);
  await page.screenshot({path:`${shots}/circuit-map.png`});
  await page.evaluate(()=>window.__apex.menu());
  const fixture=await page.evaluate(async()=>{
    const g=window.__apex;
    const {rotate,Input,PHYSICS_VERSION}=await import('/shared/physics.ts');
    const {stepReplay}=await import('/shared/replay.ts');
    // Reuse the game's loaded collision cache, including Vite's current HMR module identity.
    const Simulation=g.sim.constructor;
    const {applyCheckpoints,applyFinishPlacement}=await import('/src/dev-spawns.ts');
    g.setSettings({pointerLock:false,reducedMotion:false});
    const track=structuredClone(g.state.track),p=g.sim.car.translation(),f=rotate(g.sim.car.rotation(),{x:0,y:0,z:1}),heading=Math.atan2(f.x,f.z);
    const point=d=>{const at={x:p.x+f.x*d,y:p.y,z:p.z+f.z*d};at.y=g.sim.roadHeightAt(at)??p.y;return at;};
    applyCheckpoints(track,[12,24].map(d=>({position:point(d),heading})));
    applyFinishPlacement(track,{position:point(42),heading});
    track.mapPath=[point(-8),point(0),point(20),point(42),point(65)];
    const sim=new Simulation(track,g.state.car.id),inputs=[];
    try{
      while(!sim.finished&&sim.ticks<1200){const input=sim.ticks<60?0:Input.Throttle;inputs.push(input);sim.step(input);}
      if(!sim.finished)throw new Error('The reference ghost did not finish the short practice layout.');
      const run={trackId:track.id,trackVersion:track.version,physicsVersion:PHYSICS_VERSION,carId:g.state.car.id,timeMs:sim.timeMs,inputs};
      const splits=[...sim.splits];
      const check=new Simulation(track,run.carId);
      try{for(const input of inputs)stepReplay(check,run);if(!check.finished||check.timeMs!==run.timeMs)throw new Error(JSON.stringify({expected:run.timeMs,actual:check.timeMs,finished:check.finished,splits:check.splits,ref:splits}));}finally{check.dispose();}
      await g.raceGhost(track,run,'Reference driver');g.restart();
      return {splits,time:run.timeMs};
    }finally{sim.dispose();}
  });
  await page.waitForFunction(()=>['ready','unavailable'].includes(window.__apex.state.ghostTiming));
  assert.equal(await page.evaluate(()=>window.__apex.state.ghostTiming),'ready','the loaded ghost prepares valid checkpoint timings');
  assert.equal(await page.locator('[data-marker="start"]').count(),0);
  for(const marker of ['player','ghost','finish']){await page.locator(`[data-marker="${marker}"]`).waitFor();assert.equal(await page.locator(`[data-marker="${marker}"]`).count(),1);}
  await page.locator('.ghost-target').getByText('Reference driver',{exact:true}).waitFor();
  const finish=await page.evaluate(async()=>{
    const g=window.__apex,{minimapLayout}=await import('/src/minimap.ts');
    return {actual:minimapLayout(g.state.track).finish,last:minimapLayout(g.state.track).project(g.state.track.mapPath.at(-1))};
  });
  assert.notDeepEqual(finish.actual,finish.last,'test layout ends beyond the actual finish');
  assert.equal(await page.locator('[data-marker="finish"]').getAttribute('transform'),`translate(${finish.actual.x} ${finish.actual.y})`);
  // A changing clock must refresh the marker even when the rounded speed does not change.
  const before=await page.locator('[data-marker="player"]').getAttribute('transform');
  await page.evaluate(()=>{
    const g=window.__apex,p=g.sim.car.translation();g.sim.car.setTranslation({...p,x:p.x+6},true);
    g.emit({time:g.state.time+100,speed:g.state.speed});
  });
  await page.waitForFunction(before=>document.querySelector('[data-marker="player"]').getAttribute('transform')!==before,before);
  await page.evaluate(()=>window.__apex.restart());
  assert.equal(await page.locator('.ghost-gap').count(),0,'restart clears the last split');
  await page.keyboard.down('w');
  await page.waitForFunction(()=>window.__apex.state.ghostSplit?.checkpoint===1,null,{timeout:12000});
  await page.keyboard.up('w');
  const first=await page.evaluate(()=>{
    const g=window.__apex;g.awaitingPedal=true;g.keys.clear();
    return {split:g.state.ghostSplit,player:g.sim.splits[0],mode:g.state.mode};
  });
  assert.equal(first.mode,'racing');assert.equal(first.split.ms,first.player-fixture.splits[0]);assert.ok(first.split.ms<0,'faster driver shows a negative gap before the ghost reaches that gate');
  assert.match(await page.locator('.ghost-gap strong').innerText(),/^-/);await page.locator('.ghost-gap').getByText('Ahead',{exact:true}).waitFor();
  await page.waitForTimeout(250);await page.screenshot({path:`${shots}/desktop-ahead.png`});
  await page.keyboard.press('g');
  await page.locator('[data-marker="ghost"]').waitFor({state:'detached'});
  assert.equal(await page.locator('.ghost-gap').count(),0,'ghost off hides its comparison');
  await page.keyboard.press('g');
  await page.waitForFunction(()=>window.__apex.state.ghostTiming==='ready'&&window.__apex.state.ghostSplit?.checkpoint===1);
  assert.equal(await page.locator('[data-marker="ghost"]').count(),1);
  assert.equal(await page.evaluate(()=>window.__apex.state.ghostSplit.ms),first.split.ms,'toggle restores the selected ghost, not a different opponent');
  await page.setViewportSize({width:390,height:844});
  const layout=await page.evaluate(()=>{
    const box=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom};};
    return {map:box('.race-left'),timer:box('.timer-panel'),rpm:box('.tachometer'),speed:box('.speedometer')};
  });
  const overlap=(a,b)=>a.x<b.right&&b.x<a.right&&a.y<b.bottom&&b.y<a.bottom;
  assert.ok(layout.map.x>=0&&layout.map.right<=390&&layout.map.bottom<=844,'map and gap fit mobile');
  for(const key of ['timer','rpm','speed'])assert.ok(!overlap(layout.map,layout[key]),`map overlaps ${key}`);
  await page.waitForTimeout(250);await page.screenshot({path:`${shots}/mobile-ahead.png`});
  await page.evaluate(()=>{const g=window.__apex;g.chosenGhostName='WWWWWWWWWWWWWWWWWWWW';g.emit({notice:'Name fixture'});});
  await page.locator('.ghost-target').getByText('WWWWWWWWWWWWWWWWWWWW',{exact:true}).waitFor();
  assert.ok(await page.locator('.ghost-target>span>span').evaluate(el=>el.scrollWidth>el.clientWidth&&getComputedStyle(el).textOverflow==='ellipsis'),'long ghost names truncate within their row');
  await page.evaluate(()=>{const g=window.__apex;g.chosenGhostName='Reference driver';g.emit({notice:''});});
  for(const viewport of [{width:390,height:600},{width:1280,height:600},{width:844,height:390}]){
    await page.setViewportSize(viewport);
    const boxes=await page.evaluate(()=>Object.fromEntries(['.map-panel','.ghost-readout','.timer-panel','.tachometer','.speedometer','.camera-toggle'].map(selector=>{const r=document.querySelector(selector).getBoundingClientRect();return [selector,{x:r.x,y:r.y,right:r.right,bottom:r.bottom}];})));
    for(const name of ['.map-panel','.ghost-readout']){
      const box=boxes[name];assert.ok(box.x>=0&&box.right<=viewport.width&&box.y>=0&&box.bottom<=viewport.height,`${name} fits ${viewport.width}x${viewport.height}`);
      for(const other of ['.timer-panel','.tachometer','.speedometer','.camera-toggle'])assert.ok(!overlap(box,boxes[other]),`${name} overlaps ${other} at ${viewport.width}x${viewport.height}`);
    }
    assert.ok(!overlap(boxes['.camera-toggle'],boxes['.speedometer']),`camera covers speed at ${viewport.width}x${viewport.height}`);
    await page.screenshot({path:`${shots}/compact-${viewport.width}x${viewport.height}.png`});
  }
  // Restart on the same selected ghost and let it go first, then cross both checkpoints.
  await page.setViewportSize({width:1440,height:900});
  await page.evaluate(()=>{const g=window.__apex;g.setSettings({reducedMotion:true});g.restart();g.awaitingPedal=false;});
  await page.waitForTimeout(2300);await page.keyboard.down('w');
  await page.waitForFunction(()=>window.__apex.state.ghostSplit?.checkpoint===1,null,{timeout:12000});
  const behind=await page.evaluate(()=>window.__apex.state.ghostSplit.ms);
  assert.ok(behind>0,'slower driver shows a positive gap');assert.match(await page.locator('.ghost-gap strong').innerText(),/^\+/);
  await page.locator('.ghost-gap').getByText('Behind',{exact:true}).waitFor();
  await page.screenshot({path:`${shots}/desktop-behind.png`});
  await page.waitForFunction(()=>window.__apex.state.ghostSplit?.checkpoint===2,null,{timeout:12000});
  const second=await page.evaluate(()=>({split:window.__apex.state.ghostSplit,player:window.__apex.sim.splits[1]}));
  assert.equal(second.split.ms,second.player-fixture.splits[1],'the next checkpoint replaces the previous comparison');
  await page.keyboard.up('w');
  assert.deepEqual(errors,[]);
  console.log('Actual ghost replay: negative/positive gaps at matching checkpoints, current finish pin, steady-speed map updates, toggle/restart cleanup, and mobile layout pass.',{first:first.split.ms,behind,second:second.split.ms});
}finally{await browser.close();}
