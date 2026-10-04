import { chromium } from '@playwright/test';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const tag=process.argv[2]??'before';
assert.match(tag,/^[\w-]+$/);
const directory=`work/track-cleanup/${tag}`;await mkdir(directory,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[],results=[];
page.on('pageerror',e=>errors.push(e.message));
try{
  await page.goto('http://127.0.0.1:5173/');
  await page.waitForFunction(()=>window.__apex?.state.modelReady&&window.__apex.state.trackReady);
  await page.evaluate(()=>{window.__apex.frame=()=>{};document.getElementById('app').style.display='none';});
  if(process.argv.includes('--source'))await page.evaluate(()=>{
    const loader=window.__apex.world.loader,load=loader.loadAsync.bind(loader);
    loader.loadAsync=url=>load(url.replace(/\.(?:race|clean)\.glb$/,'.glb'));
  });
  const tracks=await page.evaluate(async()=>{
    const {TRACKS}=await import('/shared/tracks.ts');return TRACKS.map(t=>t.id);
  });
  const selected=process.argv.find(arg=>arg.startsWith('--track='))?.slice(8);
  for(const id of tracks.filter(id=>!selected||id===selected)){
    const views=await page.evaluate(async id=>{
      const {TRACKS,spawnGate}=await import('/shared/tracks.ts');
      const track=TRACKS.find(t=>t.id===id),w=window.__apex.world;w.setTrack(track);
      w.trackGroup.visible=false;w.car.visible=false;w.ghost.visible=false;
      w.editorMarker.visible=false;w.editorFinishMarker.visible=false;w.editorRoadGuide.visible=false;
      const spawn=spawnGate(track),views=[{label:'Saved/default start',position:spawn.position,forward:spawn.forward}];
      // Every authored route section is represented in the 24 evenly spaced
      // inspection positions. These are free-camera views, not simulated laps.
      for(let i=0;i<24;i++){
        const s=track.segments[Math.floor(i*track.segments.length/24)];
        const d={x:s.end.x-s.start.x,y:s.end.y-s.start.y,z:s.end.z-s.start.z},n=Math.hypot(d.x,d.y,d.z);
        views.push({label:`Route ${Math.round(i/24*100)}%`,position:s.start,forward:{x:d.x/n,y:d.y/n,z:d.z/n}});
      }
      return views;
    },id);
    if(process.argv.includes('--start-straight')){
      const {position:p,forward:f}=views[0];views.length=1;
      for(let i=1;i<21;i++)views.push({label:`Grid +${i*25} units`,position:{x:p.x+f.x*i*25,y:p.y+f.y*i*25,z:p.z+f.z*i*25},forward:f});
    }
    await page.waitForFunction(()=>window.__apex.world.venueGroup.children.length>0);
    for(let index=0;index<views.length;index++){
      const view=views[index];
      await page.evaluate(({position:p,forward:f})=>{
        const w=window.__apex.world;w.venueGroup.visible=true;
        w.camera.position.set(p.x-f.x*14,p.y+7,p.z-f.z*14);w.camera.up.set(0,1,0);
        w.camera.lookAt(p.x+f.x*65,p.y+f.y*50+1,p.z+f.z*65);
        w.camera.fov=68;w.camera.filmOffset=0;w.camera.updateProjectionMatrix();w.render();
      },view);
      await page.screenshot({path:`${directory}/${id}-${index}.png`});
    }
    const info=await page.evaluate(()=>{
      const w=window.__apex.world,meshes=[];
      w.venueGroup.traverse(o=>{if(!o.isMesh)return;const ms=Array.isArray(o.material)?o.material:[o.material];
        meshes.push({node:o.name,vertices:o.geometry.attributes.position?.count,materials:ms.map(m=>({name:m.name,opacity:m.opacity,transparent:m.transparent,alphaTest:m.alphaTest,map:!!m.map}))});});
      return meshes;
    });
    results.push({id,views,meshes:info});
    for(let batch=0;batch<3;batch++){
      const count=Math.min(12,views.length-batch*12);if(count<=0)continue;
      const canvas=createCanvas(1920,Math.ceil(count/4)*324),ctx=canvas.getContext('2d');ctx.fillStyle='#17232b';ctx.fillRect(0,0,canvas.width,canvas.height);
      for(let i=0;i<count;i++){
        const index=batch*12+i,img=await loadImage(`${directory}/${id}-${index}.png`),x=i%4*480,y=Math.floor(i/4)*324;
        ctx.drawImage(img,x,y,480,300);ctx.fillStyle='white';ctx.font='16px sans-serif';ctx.fillText(`${id} / ${index} / ${views[index].label}`,x+8,y+319);
      }
      await writeFile(`${directory}/${id}-sheet-${batch}.png`,canvas.toBuffer('image/png'));
    }
    console.log('Inspected',id,views.length,'views');
  }
  assert.deepEqual(errors,[]);await writeFile(`${directory}/audit.json`,JSON.stringify({results,errors}));
}finally{await browser.close();}
