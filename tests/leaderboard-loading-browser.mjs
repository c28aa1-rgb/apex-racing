// Navigation fixture: replay physics are covered separately by ghost-hud and replay tests.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { gameUrl, gameReady } from './browser-page.mjs';

await mkdir('work/leaderboard-loading',{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-angle=metal','--enable-gpu']});
const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
page.on('pageerror',error=>errors.push(error.message));
let requestReady;
await page.route('**/api/replays/*',route=>requestReady(route));
try{
  await page.goto(gameUrl('/'));await gameReady(page);
  const run=await page.evaluate(async()=>{
    const g=window.__apex,{PHYSICS_VERSION}=await import('/shared/physics.ts');
    g.setSettings({pointerLock:false,reducedMotion:false});
    for(const name of ['raceGhost','watchRecord']){
      const original=g[name].bind(g);
      g[name]=async(...args)=>{await new Promise(resolve=>window.__releaseRecordSetup=resolve);return original(...args);};
    }
    return {trackId:g.state.track.id,trackVersion:g.state.track.version,physicsVersion:PHYSICS_VERSION,carId:g.state.car.id,timeMs:10000,inputs:Array(600).fill(0)};
  });
  await page.route('**/api/leaderboards/*',route=>route.fulfill({json:{entries:[{id:'loading-fixture',playerId:'fixture-driver',nickname:'Test driver',rank:1,carId:run.carId,timeMs:run.timeMs}]}}));
  const board=page.getByRole('dialog',{name:'Leaderboards',exact:true});
  const openBoard=async()=>{await page.getByRole('button',{name:'Leaderboards',exact:true}).click();await board.getByRole('table').waitFor();};
  for(const action of ['ghost','replay']){
    await openBoard();
    const request=new Promise(resolve=>{requestReady=resolve;});
    await board.getByRole('button',{name:action==='ghost'?"Race Test driver's ghost":"Watch Test driver's replay",exact:true}).click();
    const route=await request;
    await board.waitFor({state:'detached'});
    await page.locator('.track-loading').getByText(action==='ghost'?'Ghost race':'Replay',{exact:true}).waitFor();
    assert.equal(await page.locator('.track-loading').evaluate(el=>getComputedStyle(el).pointerEvents),'auto');
    await page.screenshot({path:`work/leaderboard-loading/${action}-download.png`});
    await route.fulfill({json:run});
    await page.waitForFunction(()=>typeof window.__releaseRecordSetup==='function');
    assert.ok(await page.locator('.track-loading').isVisible(),'loading remains during circuit/car setup');
    await page.evaluate(()=>{window.__releaseRecordSetup();delete window.__releaseRecordSetup;});
    await page.waitForFunction(action=>action==='ghost'?window.__apex.state.mode==='countdown':window.__apex.state.mode==='replay',action);
    await page.locator('.track-loading').waitFor({state:'detached'});
    assert.equal(await board.count(),0);
    await page.evaluate(()=>window.__apex.menu());
  }
  await page.evaluate(()=>window.__apex.setSettings({reducedMotion:true}));
  for(const action of ['ghost','replay']){
    await page.setViewportSize({width:1440,height:900});
    await openBoard();
    await page.setViewportSize({width:390,height:844});
    const request=new Promise(resolve=>{requestReady=resolve;});
    await board.getByRole('button',{name:action==='ghost'?"Race Test driver's ghost":"Watch Test driver's replay",exact:true}).click();
    const route=await request;
    await board.waitFor({state:'detached'});await page.locator('.track-loading').waitFor();
    await page.screenshot({path:`work/leaderboard-loading/${action}-mobile.png`});
    await route.fulfill({status:503,json:{error:'Replay download unavailable. Try again.'}});
    await board.getByText('Replay download unavailable. Try again.',{exact:true}).waitFor();
    await page.locator('.track-loading').waitFor({state:'detached'});
    assert.ok(await board.getByRole('button',{name:action==='ghost'?"Race Test driver's ghost":"Watch Test driver's replay",exact:true}).isEnabled(),'failed loads can be retried');
    await board.getByRole('button',{name:'Close dialog',exact:true}).click();await board.waitFor({state:'detached'});
  }
  assert.deepEqual(errors,[]);
  console.log('Replay/ghost dismiss leaderboard before download, keep loading through setup, start their modes, and restore actionable errors on mobile.');
}finally{await browser.close();}
