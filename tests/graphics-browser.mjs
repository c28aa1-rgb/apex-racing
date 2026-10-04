import { chromium } from '@playwright/test';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const directory='work/graphics';
await mkdir(directory,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1280,height:800},deviceScaleFactor:2});
const errors=[],results=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('console',message=>{if(message.type()==='error'&&/THREE|WebGL|shader/i.test(message.text()))errors.push(message.text());});
try{
  await page.goto(process.env.GAME_URL??'http://127.0.0.1:5173/');
  await page.waitForFunction(()=>window.__apex?.state.trackReady&&window.__apex.state.modelReady);
  await page.evaluate(()=>{window.__apex.frame=()=>{};document.getElementById('app').style.display='none';});
  const tracks=await page.evaluate(async()=>{const {TRACKS}=await import('/shared/tracks.ts');return TRACKS.map(t=>t.id);});
  for(const id of tracks){
    await page.evaluate(async id=>{const {TRACKS}=await import('/shared/tracks.ts');window.__apex.world.setTrack(TRACKS.find(t=>t.id===id));},id);
    await page.waitForFunction(()=>window.__apex.world.venueGroup.children.length>0);
    for(const cockpit of [false,true]){
      const result=await page.evaluate(async({id,cockpit})=>{
        const {TRACKS,spawnGate}=await import('/shared/tracks.ts');
        const w=window.__apex.world,{position:p,forward:f}=spawnGate(TRACKS.find(t=>t.id===id));
        w.car.visible=false;w.ghost.visible=false;w.trackGroup.visible=false;w.venueGroup.visible=true;
        w.camera.position.set(p.x-f.x*5,p.y+(cockpit?1.2:4),p.z-f.z*5);
        w.camera.lookAt(p.x+f.x*80,p.y+f.y*80+1,p.z+f.z*80);
        w.camera.near=cockpit?.025:.2;w.camera.fov=68;w.camera.filmOffset=0;w.camera.updateProjectionMatrix();
        const overlays=[];
        w.venueGroup.traverse(o=>{if(o.isMesh)for(const m of Array.isArray(o.material)?o.material:[o.material])if(m.userData.apexRoadOverlay)overlays.push({bias:m.polygonOffset,depthWrite:m.depthWrite,transparent:m.transparent,order:o.renderOrder,shader:m.customProgramCacheKey()});});
        const start=performance.now();for(let i=0;i<6;i++){w.camera.position.x+=.002;w.render();}
        return {id,cockpit,ms:(performance.now()-start)/6,logDepth:w.renderer.capabilities.logarithmicDepthBuffer,overlays};
      },{id,cockpit});
      assert.equal(result.logDepth,true);
      assert.ok(result.overlays.every(m=>m.bias&&(!m.transparent||!m.depthWrite)));
      assert.ok(result.overlays.every(m=>m.order<0&&m.shader==='apex-road-decal-log-depth-v1'));
      const path=`${directory}/${id}-${cockpit?'cockpit':'chase'}.png`;
      await page.screenshot({path,scale:'css'});
      const img=await loadImage(path),canvas=createCanvas(1280,800),ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);
      const pixels=ctx.getImageData(0,300,1280,500).data,colors=new Set();
      for(let i=0;i<pixels.length;i+=256)colors.add(`${pixels[i]>>4},${pixels[i+1]>>4},${pixels[i+2]>>4}`);
      assert.ok(colors.size>20,`${id}: blank or flat canvas`);
      results.push({...result,colors:colors.size});
    }
  }
  for(const quality of ['cinematic','performance','balanced']){
    const result=await page.evaluate(quality=>{const g=window.__apex,w=g.world;g.setSettings({graphicsQuality:quality});w.render();const textureAnisotropy=new Set();for(const root of [w.venueGroup,w.car])root.traverse(o=>{if(o.isMesh)for(const m of Array.isArray(o.material)?o.material:[o.material])for(const value of Object.values(m))if(value?.isTexture)textureAnisotropy.add(value.anisotropy);});return {ratio:w.renderer.getPixelRatio(),shadows:w.renderer.shadowMap.enabled,passes:w.composer?.passes.length??0,maxAnisotropy:Math.max(...textureAnisotropy)};},quality);
    assert.equal(result.shadows,quality!=='performance');
    assert.equal(result.passes,quality==='cinematic'?4:0);
    assert.equal(result.ratio,quality==='cinematic'?1.25:quality==='balanced'?1:.85);
    assert.equal(result.maxAnisotropy,quality==='cinematic'?8:quality==='balanced'?2:1);
  }
  const adaptive=await page.evaluate(()=>{const g=window.__apex,w=g.world;w.adaptResolution(35);w.adaptResolution(35);const low=w.renderer.getPixelRatio();w.adaptResolution(60);w.adaptResolution(60);w.adaptResolution(60);const recovered=w.renderer.getPixelRatio();g.setSettings({graphicsQuality:'performance'});g.setSettings({graphicsQuality:'balanced'});return {low,recovered};});
  assert.ok(adaptive.low<1&&adaptive.recovered>adaptive.low);
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>window.__apex.world.render());
  await page.screenshot({path:`${directory}/mobile.png`,scale:'css'});
  const dimensions=await page.evaluate(()=>{const w=window.__apex.world;return {width:w.renderer.domElement.width,height:w.renderer.domElement.height,aspect:w.camera.aspect};});
  assert.equal(dimensions.width,390);assert.equal(dimensions.height,844);
  assert.equal(dimensions.aspect,390/844);
  await page.reload();await page.waitForFunction(()=>window.__apex?.state.modelReady);
  assert.equal(await page.evaluate(()=>window.__apex.settings.graphicsQuality),'balanced');
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByRole('button',{name:'Graphics',exact:true}).click();
  await page.getByLabel('Graphics quality').selectOption('cinematic');
  assert.equal(await page.evaluate(()=>window.__apex.settings.graphicsQuality),'cinematic');
  assert.equal(await page.locator('.settings-panel').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  await page.screenshot({path:`${directory}/mobile-settings.png`,scale:'css'});
  assert.deepEqual(errors,[]);
  await writeFile(`${directory}/results.json`,JSON.stringify({results,errors},null,2));
  console.log(`Passed: ${tracks.length} tracks, cockpit/chase canvas checks, three presets, resize, persistence, no renderer errors.`);
}finally{await browser.close();}
