import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1600,height:1000}}),errors=[];
// Keep the owner's real circuit configuration untouched.
let config={starts:{},finishes:{},roads:{},maps:{},cockpits:{},checkpoints:{}};
page.on('pageerror',e=>errors.push(e.message));
await page.route('**/api/dev-circuit-config',async route=>{if(route.request().method()==='PUT')config=route.request().postDataJSON();await route.fulfill({json:config});});
try{
  await page.goto('http://127.0.0.1:5173/dev');await page.waitForFunction(()=>window.__apex?.state.trackReady&&window.__apex?.state.modelReady);
  await page.getByRole('button',{name:'Drive checkpoints',exact:true}).click();
  await page.getByRole('button',{name:'Start driving',exact:true}).click();
  await page.keyboard.press('r');assert.equal(await page.evaluate(()=>window.__apex.authoring),true,'restart preserves checkpoint authoring');
  await page.keyboard.down('w');await page.waitForTimeout(800);await page.keyboard.up('w');
  await page.keyboard.press('j');
  await page.getByText('01 checkpoints',{exact:true}).waitFor();
  await page.keyboard.down('w');await page.waitForTimeout(1100);await page.keyboard.up('w');await page.keyboard.press('j');
  await page.getByText('02 checkpoints',{exact:true}).waitFor();
  await page.screenshot({path:'work/checkpoint-recorder.png'});
  await page.keyboard.down('w');await page.waitForTimeout(500);await page.keyboard.up('w');await page.keyboard.press('k');
  await page.waitForFunction(()=>window.__apex.state.mode==='menu'&&window.__apex.state.track.checkpoints.length===2);
  await page.getByText('Saved 2 checkpoints, finish and minimap permanently.',{exact:true}).waitFor();
  const id=await page.evaluate(()=>window.__apex.state.track.id);
  assert.equal(config.checkpoints[id].length,2);assert.ok(config.finishes[id]);assert.ok(config.starts[id]);assert.ok(config.maps[id]?.length>=2,'checkpoint drive creates minimap path');
  await page.reload();await page.waitForFunction(()=>window.__apex?.state.trackReady&&window.__apex?.state.modelReady);
  assert.equal(await page.evaluate(()=>window.__apex.state.track.checkpoints.length),2,'saved gates load at boot');
  assert.ok(await page.evaluate(()=>window.__apex.state.track.mapPath?.length>=2),'saved minimap path loads at boot');
  await page.getByRole('button',{name:'Drive checkpoints',exact:true}).click();
  await page.getByRole('button',{name:'Restore project race gates'}).click();
  await page.waitForFunction(()=>window.__apex.state.track.checkpoints.length===4);
  await page.getByText('Project race gates restored. Road-width edits remain unchanged.',{exact:true}).waitFor();
  assert.equal(config.checkpoints[id],undefined);assert.equal(config.finishes[id],undefined);assert.deepEqual(errors,[]);
  console.log('Drive, checkpoint, finish, reload and restore passed');
}finally{await browser.close();}
