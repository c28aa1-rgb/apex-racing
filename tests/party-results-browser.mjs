// Current-race standings remain available after the provisional and final results are dismissed.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { gameUrl, gameReady } from './browser-page.mjs';

const shots=process.env.SHOTS??'work/party-results';
await mkdir(shots,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-angle=metal','--enable-gpu']});
const errors=[];
const party=(page,path,method,body)=>page.evaluate(async({path,method,body})=>{
  const {read}=await import('/src/storage.ts'),{requestParty}=await import('/src/use-party.ts');
  return requestParty(path,read('player',null).token,method,body);
},{path,method,body});
async function driver(name){
  const context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(gameUrl('/'));
  await page.evaluate(async name=>{
    const {api,write}=await import('/src/storage.ts');
    write('player',await api('/players',{nickname:name}));write('settings',{pointerLock:false,reducedMotion:true});
  },name);
  await page.reload();await gameReady(page,{track:false});return page;
}
try{
  const a=await driver('Alpha'),b=await driver('Bravo');
  assert.equal(await a.getByLabel('Medal target times').count(),0,'track menu has no medal targets');
  const created=await party(a,'','POST',{carId:'porsche-911-gt3',settings:{laps:1}});
  await party(b,'/join','POST',{carId:'porsche-911-gt3',code:created.lobby.code});
  for(const page of [a,b])await page.getByRole('button',{name:'Party',exact:true}).click();
  await a.waitForTimeout(2200);await party(a,'/start','POST');
  for(const page of [a,b])await page.waitForFunction(()=>window.__apex.state.mode==='racing',null,{timeout:120000});
  const raceId=await a.evaluate(()=>window.__apex.partyRace.id);
  const finish=page=>page.evaluate(()=>{
    const g=window.__apex,gate=g.state.track.finish;
    g.sim.car.setTranslation({...gate.position,y:(g.sim.roadHeightAt(gate.position)??gate.position.y)+1},true);
    g.sim.car.setRotation(gate.rotation,true);g.sim.car.setLinvel({x:gate.forward.x*35,y:0,z:gate.forward.z*35},true);
    g.sim.finished=true;
  });
  await finish(a);await a.waitForFunction(()=>window.__apex.state.mode==='party-finished');
  await a.getByRole('button',{name:'Standings',exact:true}).click();
  const results=a.getByRole('dialog',{name:'Race standings'});
  await results.waitFor();await results.getByText('Live standings',{exact:false}).waitFor();
  assert.equal(await results.locator('li').count(),2);
  await results.getByText('Alpha',{exact:false}).waitFor();await results.getByText('Bravo',{exact:true}).waitFor();
  await results.getByRole('button',{name:'Close standings'}).click();
  await results.waitFor({state:'detached'});
  await a.getByRole('button',{name:'Standings',exact:true}).click();await results.waitFor();
  await a.keyboard.press('Escape');await results.waitFor({state:'detached'});
  await a.waitForFunction(()=>document.activeElement?.textContent?.includes('Standings'),null,{timeout:3000});
  assert.equal(await a.getByRole('button',{name:'Standings',exact:true}).evaluate(node=>node===document.activeElement),true,'focus returns to standings button');
  await finish(b);await b.waitForFunction(()=>window.__apex.state.mode==='party-finished');
  await results.getByText('Final standings',{exact:false}).waitFor({timeout:10000});
  assert.equal(await results.locator('li').count(),2,'only this race is listed');
  await a.screenshot({path:`${shots}/desktop.png`});
  await results.getByRole('button',{name:'Back to track',exact:true}).click();
  await a.waitForTimeout(1000);
  assert.equal(await results.count(),0,'final standings stay closed while watching');
  assert.equal(await a.evaluate(()=>window.__apex.partyRace.id),raceId,'closing results does not leave the race');
  await a.setViewportSize({width:390,height:844});
  const button=a.getByRole('button',{name:'Standings',exact:true});
  const buttonBox=await button.boundingBox();
  assert.ok(buttonBox&&buttonBox.x>=0&&buttonBox.x+buttonBox.width<=390,'standings button fits mobile');
  await button.click();await results.waitFor();
  const bounds=await results.boundingBox();
  assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=390&&bounds.y>=0&&bounds.y+bounds.height<=844,'standings fit mobile');
  assert.equal(await results.evaluate(node=>node.scrollWidth>node.clientWidth),false,'no horizontal clipping');
  await a.screenshot({path:`${shots}/mobile.png`});
  await a.keyboard.press('Tab');
  assert.equal(await a.evaluate(()=>document.querySelector('.party-results').contains(document.activeElement)),true,'keyboard focus stays in standings');
  assert.deepEqual(errors,[]);
  await results.getByRole('button',{name:'Close standings'}).click();
  await party(a,'/reopen','POST');await party(a,'/me','DELETE');await party(b,'/me','DELETE');
  console.log('Provisional/final standings reopen without leaving; native dialog focus, Escape, and mobile bounds pass.');
}finally{await browser.close();}
