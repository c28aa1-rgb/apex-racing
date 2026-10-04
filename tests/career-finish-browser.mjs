import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}});
try{
  await page.goto('http://127.0.0.1:5173/');await page.waitForFunction(()=>window.__apex?.state.modelReady&&window.__apex?.state.trackReady);
  // Short, local test layout on the real Bugatti start straight. No server writes.
  await page.evaluate(async()=>{const g=window.__apex,{applyCheckpoints,applyFinishPlacement}=await import('/src/dev-spawns.ts'),{rotate}=await import('/shared/physics.ts');const p=g.sim.car.translation(),f=rotate(g.sim.car.rotation(),{x:0,y:0,z:1}),heading=Math.atan2(f.x,f.z),point=d=>{const pos={x:p.x+f.x*d,y:p.y,z:p.z+f.z*d};pos.y=g.sim.visibleGroundAt(pos)??p.y;return {position:pos,heading};};applyCheckpoints(g.state.track,[point(12),point(24)]);applyFinishPlacement(g.state.track,point(40));g.setSettings({advancedDriving:true,pointerLock:false});await g.select(g.state.track);g.start(false);});
  await page.keyboard.down('w');await page.waitForFunction(()=>window.__apex.state.mode==='finished',null,{timeout:20000});await page.keyboard.up('w');
  const reward=await page.evaluate(()=>({xp:window.__apex.career.xp,breakdown:window.__apex.reward.breakdown,manual:window.__apex.state.run.manual,checkpoints:window.__apex.state.checkpoint}));
  assert.equal(reward.xp,450);assert.equal(reward.breakdown.manual,100);assert.equal(reward.manual,true);assert.equal(reward.checkpoints,2);
  await page.getByText('XP breakdown',{exact:true}).click();await page.screenshot({path:'work/career-finish.png'});
  assert.equal(await page.getByRole('button',{name:'Submit to leaderboard'}).count(),0,'custom layout does not rank online');
  await page.getByRole('button',{name:'Watch replay',exact:true}).click();await page.waitForFunction(()=>window.__apex.state.mode==='menu',null,{timeout:20000});assert.equal(await page.evaluate(()=>window.__apex.career.xp),450,'watching a replay awards no XP');
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('apex:career:v1')).xp),450);
  console.log('Real-physics custom finish earned 450 XP; replay earned none; career persisted');
}finally{await browser.close();}
