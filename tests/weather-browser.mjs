import {chromium} from '@playwright/test';
import {gameUrl,gameReady} from './browser-page.mjs';
import {createCanvas,loadImage} from '@napi-rs/canvas';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
await mkdir('work/weather',{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
try{
  await page.goto(gameUrl('/'));await gameReady(page,{track:false});
  await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Graphics',exact:true}).click();
  await page.getByLabel('Weather',{exact:true}).selectOption('rain');
  assert.equal(await page.evaluate(()=>window.__apex.settings.weather),'rain');
  // The menu shows a static preview; load the circuit so the overview camera has a venue to render.
  await page.reload();await gameReady(page);
  assert.equal(await page.evaluate(()=>window.__apex.settings.weather),'rain');
  await page.evaluate(()=>{document.getElementById('app').style.display='none';});
  for(const mobile of [false,true]){
    await page.setViewportSize(mobile?{width:390,height:844}:{width:1440,height:900});
    for(const preset of ['clear','rain','snow','fog']){
      const state=await page.evaluate(preset=>{const g=window.__apex,w=g.world;g.setSettings({weather:preset});w.overview(0,true);w.render();return {far:w.scene.fog.far,distance:w.camera.position.distanceTo(w.center),radius:w.trackRadius,image:w.renderer.domElement.toDataURL('image/png')};},preset);
      assert.ok(state.far>state.distance+state.radius,'overview fog must leave the whole circuit visible');
      // The menu has no render loop, so a page screenshot can catch a cleared canvas: read the frame just drawn instead.
      const path=`work/weather/overview-${preset}-${mobile?'mobile':'desktop'}.png`;await writeFile(path,Buffer.from(state.image.split(',')[1],'base64'));
      const image=await loadImage(path),canvas=createCanvas(image.width,image.height),c=canvas.getContext('2d');c.drawImage(image,0,0);const data=c.getImageData(0,0,image.width,image.height).data,colors=new Set();
      for(let i=0;i<data.length;i+=64)colors.add(`${data[i]>>4}:${data[i+1]>>4}:${data[i+2]>>4}`);
      assert.ok(colors.size>70,`${preset}: overview must render track geometry, not just fog`);
    }
  }
  await page.evaluate(()=>{const g=window.__apex;g.setSettings({pointerLock:false});g.start(false);document.getElementById('app').style.display='none';});
  const metrics=[];
  for(const mobile of [false,true]){
    await page.setViewportSize(mobile?{width:390,height:844}:{width:1440,height:900});
    for(const preset of ['clear','rain','snow','fog']){
      await page.evaluate(preset=>window.__apex.setSettings({weather:preset}),preset);await page.waitForTimeout(700);
      const before=await page.evaluate(()=>Array.from(window.__apex.world.weather.geometry.getAttribute('position').array).slice(0,30));
      await page.waitForTimeout(100);
      const state=await page.evaluate(()=>{const w=window.__apex.world;return {visible:w.weather.group.visible,positions:Array.from(w.weather.geometry.getAttribute('position').array).slice(0,30),count:w.weather.geometry.drawRange.count,draws:w.renderer.info.render.calls,fog:w.scene.fog.far};});
      assert.equal(state.visible,preset==='rain'||preset==='snow');
      if(state.visible){assert.notDeepEqual(before,state.positions,'weather animates');assert.ok(state.count<=1800);}
      const path=`work/weather/${preset}-${mobile?'mobile':'desktop'}.png`;await page.screenshot({path});
      const image=await loadImage(path),canvas=createCanvas(image.width,image.height),c=canvas.getContext('2d');c.drawImage(image,0,0);const pixels=c.getImageData(0,0,image.width,image.height).data,colors=new Set();let sum=0;
      for(let i=0;i<pixels.length;i+=64){colors.add(`${pixels[i]>>4}:${pixels[i+1]>>4}:${pixels[i+2]>>4}`);sum+=pixels[i]+pixels[i+1]+pixels[i+2];}assert.ok(colors.size>25,'nonblank rendered scene');
      metrics.push({preset,mobile,draws:state.draws,fog:state.fog,colors:colors.size,sum});
    }
  }
  assert.equal(metrics[0].draws,metrics[3].draws+1,'fog disables the sky without adding passes');
  await page.evaluate(()=>{const g=window.__apex;g.setSettings({weather:'snow'});g.menu();g.setGarage(true);});await page.waitForTimeout(200);
  assert.equal(await page.evaluate(()=>window.__apex.world.weather.group.visible),false,'no indoor snow');
  assert.deepEqual(errors,[]);console.log(JSON.stringify(metrics,null,2));
}finally{await browser.close();}
