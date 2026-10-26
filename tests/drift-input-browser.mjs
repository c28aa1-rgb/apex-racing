import { chromium } from '@playwright/test';
import { gameUrl, gameReady } from './browser-page.mjs';
import assert from 'node:assert/strict';
import { mkdir,writeFile } from 'node:fs/promises';
const browser=await chromium.launch({channel:'chrome',headless:true}),errors=[];
try{
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(gameUrl('/'));
  await gameReady(page,{track:false});
  await page.evaluate(async()=>{
    const {Simulation}=await import('/shared/physics.ts'),{handlingTrack}=await import('/tests/handling-harness.ts');
    const g=window.__apex;g.testFrame=g.frame;g.frame=()=>{};g.sim.dispose();g.sim=new Simulation(handlingTrack(),'porsche-963');g.sim.steeringStrength=1.1;g.sim.manual=true;g.sim.gear=2;g.setSettings({advancedDriving:true});g.state.mode='racing';
    await g.world.setCar('porsche-963');g.world.setTrack(g.sim.track);g.sim.car.setLinvel({x:0,y:0,z:20},true);
    document.getElementById('app').style.display='none';g.world.chase(g.sim,1/60,true);
  });
  await page.keyboard.down('ShiftLeft');
  await page.evaluate(()=>{window.__apex.sim.manual=false;});
  assert.equal(await page.evaluate(()=>window.__apex.input()),16,'Shift still commands drift in automatic');
  await page.evaluate(()=>{window.__apex.sim.manual=true;});
  assert.equal(await page.evaluate(()=>window.__apex.input()),0,'Shift does not command drift in manual');
  await page.keyboard.down('w');await page.keyboard.down('a');
  assert.equal(await page.evaluate(()=>window.__apex.input()),5);
  const held=await page.evaluate(async()=>{
    const {telemetry}=await import('/tests/handling-harness.ts'),g=window.__apex;
    g.world.skidMarks.clear();
    for(let tick=0;tick<240;tick++){g.sim.step(g.input());g.world.chase(g.sim,1/60);g.world.skidMarks.update(g.sim,true);}
    g.world.render();return {...telemetry(g.sim),marks:g.world.skidMarks.mesh.geometry.drawRange.count};
  });
  assert.ok(Math.abs(held.slip)>25&&Math.abs(held.slip)<65,JSON.stringify(held));
  assert.ok(held.speed>20*.65,'powered drift retains momentum');
  assert.ok(held.marks>0&&held.marks<=240*4*6,`drift draws bounded tire marks: ${JSON.stringify(held)}`);
  await mkdir('work/physics-audit',{recursive:true});
  await page.evaluate(async()=>{await new Promise(requestAnimationFrame);window.__apex.world.render();await new Promise(requestAnimationFrame);window.__apex.world.render();});
  await page.screenshot({path:'work/physics-audit/gear-drift-browser.png'});
  await page.keyboard.up('ShiftLeft');
  assert.equal(await page.evaluate(()=>window.__apex.input()),5);
  await page.keyboard.press('e');
  const shifted=await page.evaluate(async()=>{
    const {telemetry}=await import('/tests/handling-harness.ts'),g=window.__apex;for(let tick=0;tick<180;tick++)g.sim.step(g.input());return {...telemetry(g.sim),gear:g.sim.gear};
  });
  assert.equal(shifted.gear,3,'keyboard upshift reaches manual physics');
  assert.ok(Math.abs(shifted.slip)<Math.abs(held.slip)-5,'higher gear reduces slide');
  await page.keyboard.up('w');
  const released=await page.evaluate(()=>{const g=window.__apex;for(let tick=0;tick<120;tick++)g.sim.step(g.input());return g.sim.autoDrift;});
  assert.ok(released<.16&&released<held.drift,'lifting the throttle restores grip');
  await page.keyboard.down('w');
  await page.keyboard.up('a');
  const straight=await page.evaluate(()=>{const g=window.__apex;for(let tick=0;tick<180;tick++)g.sim.step(g.input());return g.sim.autoDrift;});
  assert.ok(straight<.003,'straightening the wheels must end the slide');
  const interpolated=await page.evaluate(async()=>{
    const {DT}=await import('/shared/physics.ts'),g=window.__apex,w=g.world,original=w.chase,position=g.sim.car.translation();let captured;
    g.sim.car.setRotation({x:0,y:Math.SQRT1_2,z:0,w:Math.SQRT1_2},true);
    g.previousFrame={p:{...position},q:{x:0,y:0,z:0,w:1}};g.accumulator=DT/2;g.awaitingPedal=true;g.keys.clear();g.state.mode='racing';
    w.chase=(_,__,___,frame)=>{captured=frame;};g.previous=performance.now();g.testFrame(g.previous);w.chase=original;
    return captured.q;
  });
  assert.ok(Math.abs(interpolated.y-Math.sin(Math.PI/8))<.001,'drift yaw must interpolate between physics ticks');
  await page.keyboard.up('w');await page.keyboard.down('ShiftRight');
  assert.equal(await page.evaluate(()=>window.__apex.input()),0,'neither Shift key commands drift in manual');
  await page.keyboard.up('ShiftRight');assert.deepEqual(errors,[]);
  const frameRates=[];
  for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
    await page.setViewportSize(viewport);
    for(const fps of [30,60,144]){
      const result=await page.evaluate(async fps=>{
        const {Simulation}=await import('/shared/physics.ts'),{handlingTrack}=await import('/tests/handling-harness.ts');
        const g=window.__apex,reference=new Simulation(handlingTrack(),'porsche-963');
        reference.manual=true;reference.gear=2;
        const command=tick=>tick<120?5:9;
        for(let i=0;i<180;i++)reference.step(command(i));
        const expected=reference.frame();reference.dispose();
        g.sim.dispose();g.sim=new Simulation(handlingTrack(),'porsche-963');g.sim.manual=true;g.sim.gear=2;
        g.previousFrame=undefined;g.accumulator=0;g.previous=0;g.awaitingPedal=false;g.state.mode='racing';
        const originalInput=g.input;g.input=()=>command(g.sim.ticks);
        for(let frame=1;frame<=fps*3;frame++)g.testFrame(frame*1000/fps+.000001);
        g.input=originalInput;
        const canvas=g.world.renderer.domElement,gl=canvas.getContext('webgl2');
        g.world.render();
        const pixels=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);
        gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
        const colors=new Set();for(let i=0;i<pixels.length;i+=1028)colors.add(`${pixels[i]},${pixels[i+1]},${pixels[i+2]}`);
        return {fps,ticks:g.sim.ticks,actual:g.sim.frame(),expected,colors:colors.size};
      },fps);
      assert.equal(result.ticks,180,`${fps} FPS: wrong physics tick count`);
      assert.deepEqual(result.actual,result.expected,`${fps} FPS changed the simulation`);
      assert.ok(result.colors>20,`${fps} FPS: blank canvas`);
      frameRates.push({viewport,fps,ticks:result.ticks,colors:result.colors});
    }
    await page.screenshot({path:`work/physics-audit/gear-drift-${viewport.width}.png`});
  }
  assert.deepEqual(errors,[]);
  const result={held,shifted,released,straight,frameRates,errors};console.log(result);
  await writeFile('work/physics-audit/gear-drift-browser.json',JSON.stringify(result,null,2));
}finally{await browser.close();}
