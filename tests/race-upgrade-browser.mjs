import { chromium } from '@playwright/test';
import { gameUrl, gameReady } from './browser-page.mjs';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const headed=process.argv.includes('--headed');
const browser=await chromium.launch({channel:'chrome',headless:!headed});
const page=await browser.newPage({viewport:{width:1600,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
await mkdir('work',{recursive:true});
try{
  await page.goto(gameUrl('/'));
  await gameReady(page);
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByRole('button',{name:'Camera',exact:true}).click();
  await page.getByLabel('Mouse sensitivity').fill('1.5');
  await page.screenshot({path:'work/race-settings.png'});
  await page.getByRole('button',{name:'Sound',exact:true}).click();
  await page.getByRole('slider',{name:'Master volume'}).fill('0.4');
  await page.getByRole('button',{name:'Close dialog'}).click();
  assert.equal(await page.evaluate(()=>window.__apex.settings.volume),.4);
  await page.bringToFront();
  await page.getByRole('button',{name:'Race this track'}).click();
  if(headed)await page.waitForFunction(()=>!!document.pointerLockElement);
  await page.waitForFunction(()=>window.__apex.state.countdown===2);
  await page.screenshot({path:'work/race-start-light.png'});
  await page.waitForFunction(()=>window.__apex.state.mode==='racing');
  await page.keyboard.press('r');
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(()=>window.__apex.sim.ticks),0,'restart clock is frozen');
  await page.keyboard.press('a');
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(()=>window.__apex.sim.ticks),0,'steering does not start clock');
  await page.keyboard.down('w');await page.waitForTimeout(600);await page.keyboard.up('w');
  assert.ok(await page.evaluate(()=>window.__apex.sim.ticks)>0,'pedal starts clock');
  console.log('race flow',await page.evaluate(()=>({mode:window.__apex.state.mode,locked:!!document.pointerLockElement,time:window.__apex.state.time})));
  await page.keyboard.press('Escape');await page.evaluate(()=>document.exitPointerLock());
  await page.waitForFunction(()=>window.__apex.state.mode==='paused');
  await page.evaluate(()=>window.__apex.menu());
  await page.getByRole('button',{name:'Garage',exact:true}).click();
  for(const id of ['nascar-camry','red-bull-rb19']){
    await page.evaluate(id=>window.__apex.selectCar(id),id);
    await page.waitForFunction(id=>window.__apex.state.car.id===id&&window.__apex.state.modelReady,id,{timeout:60000});
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(()=>window.__apex.world.wheelGroups.length),4,`${id} has four animated wheels`);
    assert.ok(await page.evaluate(()=>!!window.__apex.world.car.getObjectByName('apex-steering-wheel')),`${id} has a steering wheel`);
    const animation=await page.evaluate(()=>{
      const w=window.__apex.world,spin=w.wheelGroups[0].getObjectByName('apex-wheel-spin'),steering=w.car.getObjectByName('apex-steering-wheel');
      const before={spin:spin.rotation.x,steering:steering.quaternion.toArray()};w.carRig.animate(.25,1.2,.5);
      return {before,spin:spin.rotation.x,front:w.wheelGroups[0].rotation.y,rear:w.wheelGroups[2].rotation.y,steering:steering.quaternion.toArray()};
    });
    assert.notEqual(animation.spin,animation.before.spin,`${id} tires spin`);assert.equal(animation.front,.25,`${id} front tires steer`);assert.equal(animation.rear,0,`${id} rear tires stay straight`);assert.notDeepEqual(animation.steering,animation.before.steering,`${id} steering wheel turns`);
    console.log(id,await page.evaluate(()=>({wheels:window.__apex.world.wheelGroups.map(w=>({position:w.position.toArray(),radius:w.userData.radius})),model:window.__apex.world.car.children.map(o=>o.name)})));
    await page.screenshot({path:`work/${id}-garage.png`});
    // Cars are bought with REP now; own this one in the test career so it may race.
    await page.evaluate(id=>{const c=window.__apex.career;if(!c.owned.includes(id))c.owned.push(id);},id);
    await page.evaluate(()=>window.__apex.start());
    assert.equal(await page.evaluate(()=>window.__apex.state.mode),'countdown','unlocked vehicle starts race');
    await page.evaluate(()=>window.__apex.menu());
  }
  assert.deepEqual(errors,[]);console.log('Browser flow passed');
}finally{await browser.close();}
