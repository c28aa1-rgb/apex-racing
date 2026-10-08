import {chromium} from '@playwright/test';
import {gameUrl,gameReady} from './browser-page.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1600,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
try{
  await page.goto(gameUrl('/'));await gameReady(page);
  await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByLabel('Advanced driving',{exact:false}).check();
  await page.getByRole('button',{name:'Controls',exact:true}).click();
  await page.getByRole('button',{name:'Rebind Accelerate primary',exact:true}).click();await page.keyboard.press('i');
  await page.getByRole('button',{name:'Rebind Shift up primary',exact:true}).click();await page.keyboard.press('o');
  await page.getByRole('button',{name:'Rebind Brake / reverse primary',exact:true}).click();await page.keyboard.press('i');
  // A key may now do two jobs; the panel warns instead of refusing. Put Brake back afterwards so I only accelerates.
  await page.getByText('I now does two jobs: Brake / reverse and Accelerate.',{exact:true}).waitFor();
  await page.getByRole('button',{name:/^Rebind Brake \/ reverse primary/}).click();await page.keyboard.press('s');
  await page.screenshot({path:'work/rebind-controls.png'});await page.getByRole('button',{name:'Close dialog'}).click();
  await page.reload();await gameReady(page);
  assert.equal(await page.evaluate(()=>window.__apex.settings.bindings.throttle[0]),'KeyI');
  await page.getByRole('button',{name:'Race this track'}).click();await page.waitForTimeout(900);
  assert.equal(await page.evaluate(()=>window.__apex.state.countdown),6,'settle delay before lights');
  assert.equal(await page.evaluate(()=>window.__apex.sim.ticks),0);
  assert.ok(await page.evaluate(()=>window.__apex.world.startLight.position.distanceTo(window.__apex.world.camera.position))>19);
  await page.waitForFunction(()=>window.__apex.state.countdown===2);await page.screenshot({path:'work/distant-start-light.png'});
  await page.waitForFunction(()=>window.__apex.state.mode==='racing');await page.keyboard.press('r');
  await page.keyboard.press('w');await page.waitForTimeout(200);assert.equal(await page.evaluate(()=>window.__apex.sim.ticks),0,'old accelerator no longer starts clock');
  await page.keyboard.down('i');await page.waitForTimeout(1900);await page.keyboard.press('o');await page.waitForTimeout(150);await page.keyboard.up('i');
  assert.ok(await page.evaluate(()=>window.__apex.sim.ticks)>0);assert.equal(await page.evaluate(()=>window.__apex.sim.gear),2);assert.equal(await page.evaluate(()=>window.__apex.sim.manual),true);
  await page.screenshot({path:'work/manual-driving.png'});
  console.log('Audio',await page.evaluate(()=>({running:window.__apex.sound.context?.state,frequency:window.__apex.sound.engine?.frequency.value,rpm:window.__apex.sim.engine.rpm})));
  await page.keyboard.press('Escape');await page.getByRole('button',{name:'Settings & controls'}).click();await page.getByLabel('Advanced driving',{exact:false}).uncheck();await page.getByRole('button',{name:'Close dialog'}).click();
  assert.equal(await page.evaluate(()=>window.__apex.sim.manual),true,'mode locked for the current run');
  await page.getByRole('button',{name:'Restart run',exact:true}).click();assert.equal(await page.evaluate(()=>window.__apex.sim.manual),false);
  await page.evaluate(()=>window.__apex.menu());await page.getByRole('button',{name:'Garage',exact:true}).click();
  // The REP guide now lives in the garage.
  await page.getByText('How reputation works',{exact:true}).click();await page.getByText(/REP means reputation/).waitFor();await page.screenshot({path:'work/rep-guide.png'});
  await page.route('**/2015_nascar_toyota_camry.glb',async route=>{await new Promise(r=>setTimeout(r,1400));await route.continue();});
  await page.getByRole('button',{name:/NASCAR Camry/}).click();await page.getByText('Preparing NASCAR Camry',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.__apex.world.car.children.length),0,'no old placeholder while loading');await page.screenshot({path:'work/car-loading.png'});
  await page.waitForFunction(()=>window.__apex.state.modelReady);await page.locator('.car-loading').waitFor({state:'detached',timeout:3000});
  assert.equal(await page.evaluate(()=>window.__apex.world.skidMarks.mesh.material.color.getHex()),0);
  assert.deepEqual(errors,[]);console.log('Advanced driving, rebinding, delay, loading and black tire material passed');
}finally{await browser.close();}
