import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1600,height:1000}}),errors=[];
page.on('pageerror',error=>errors.push(error.message));
try{
  await page.goto('http://127.0.0.1:5173/dev');
  await page.waitForFunction(()=>window.__apex?.state.trackReady&&window.__apex?.state.modelReady);
  await page.getByRole('button',{name:'Cockpit camera',exact:true}).click();
  const select=page.getByRole('combobox');
  await select.evaluate(el=>el.addEventListener('pointerdown',event=>{el.dataset.pointerPrevented=String(event.defaultPrevented);}));
  await select.click();
  assert.equal(await select.getAttribute('data-pointer-prevented'),'false','mouse-look must not swallow the native car selector');
  await page.keyboard.press('Escape');
  const ids=await select.locator('option').evaluateAll(options=>options.map(o=>o.value));
  for(const id of process.argv.includes('--contact-only')?[]:ids){
    await select.selectOption(id);
    await page.waitForFunction(id=>window.__apex.state.car.id===id&&window.__apex.state.modelReady,id);
    await page.evaluate(()=>new Promise(requestAnimationFrame));
    const rig=await page.evaluate(()=>{
      const w=window.__apex.world;let draws=0,lamps=0,blur=0;
      w.car.traverse(o=>{if(o.isMesh){draws++;const mats=Array.isArray(o.material)?o.material:[o.material];if(mats.some(m=>m.userData.apexBrakeLamp))lamps++;if(/rim.*blur/i.test(o.name))blur++;}});
      return {wheels:w.wheelGroups.map(g=>({index:g.userData.index,radius:g.userData.radius,spins:!!g.getObjectByName('apex-wheel-spin'),center:g.position.toArray()})),steering:!!w.car.getObjectByName('apex-steering-wheel'),lamps,draws,blur};
    });
    assert.deepEqual(rig.wheels.map(w=>w.index),[0,1,2,3],id);
    assert.ok(rig.wheels.every(w=>w.radius>.24&&w.radius<.45&&w.spins),`${id} valid axles`);
    assert.ok(rig.steering,`${id} steering wheel`);assert.ok(rig.lamps>0,`${id} original rear lamps`);assert.equal(rig.blur,0);
    assert.ok(rig.draws<150,`${id}: animation must retain draw-call batching`);
    // Exercise the actual cockpit render branch, including previously merged
    // steering wheels and lights which share an atlas with the front lights.
    const animated=await page.evaluate(()=>{
      const game=window.__apex,w=game.world,spin=w.wheelGroups[0].getObjectByName('apex-wheel-spin');
      const before=spin.rotation.x;game.sim.steering=.15;game.sim.brake=.7;
      const f=game.sim.frame(),q=game.sim.car.rotation();
      f.p.x+=2*(q.x*q.z+q.w*q.y)*.3;f.p.z+=(1-2*(q.x*q.x+q.y*q.y))*.3;
      w.chase(game.sim,1/60,false,f);w.render();
      let bright=0;w.car.traverse(o=>{if(o.isMesh)for(const m of Array.isArray(o.material)?o.material:[o.material])if(m.userData.apexBrakeLamp)bright=Math.max(bright,m.emissiveIntensity);});
      const result={before,after:spin.rotation.x,front:w.wheelGroups[0].rotation.y,rear:w.wheelGroups[2].rotation.y,steering:w.car.getObjectByName('apex-steering-wheel').quaternion.toArray(),bright,firstPerson:w.firstPerson};
      game.sim.steering=0;game.sim.brake=0;return result;
    });
    assert.equal(animated.firstPerson,true);assert.notEqual(animated.before,animated.after,`${id} spins in cockpit`);
    assert.equal(animated.front,.15);assert.equal(animated.rear,0);assert.ok(animated.bright>3);assert.notEqual(animated.steering[3],1);
    console.log(id,JSON.stringify(rig));
    await page.screenshot({path:`work/${id}-rig-cockpit.png`});
  }
  await page.goto('http://127.0.0.1:5173/');
  await page.waitForFunction(()=>window.__apex?.state.trackReady&&window.__apex?.state.modelReady);
  await page.evaluate(()=>{window.__apex.selectCar('porsche-911-gt3');});
  await page.waitForFunction(()=>window.__apex.state.modelReady);
  await page.evaluate(()=>window.__apex.start(false));
  await page.keyboard.down('w');
  const contact=await page.evaluate(async()=>{
    let lowest=Infinity,checks=0,worst;const game=window.__apex;
    for(let i=0;i<180;i++){
      await new Promise(requestAnimationFrame);game.world.car.updateMatrixWorld(true);
      for(const wheel of game.world.wheelGroups){
        const center=wheel.getWorldPosition(game.world.center.clone()),floor=game.sim.visibleGroundAt(center);
        if(floor===undefined)continue;const gap=center.y-wheel.userData.radius-floor;
        if(gap<lowest){lowest=gap;worst={i,ticks:game.sim.ticks,index:wheel.userData.index,center:center.toArray(),floor,cached:game.world.visibleWheelFloors,grounded:game.sim.grounded,car:game.world.car.position.toArray()};}checks++;
      }
    }
    return {lowest,checks,speed:game.state.speed,worst};
  });
  await page.keyboard.up('w');console.log('contact diagnostic',JSON.stringify(contact));assert.ok(contact.checks>300);assert.ok(contact.lowest>-.035,`tire penetration: ${contact.lowest} m`);
  await page.screenshot({path:'work/road-clearance-rig.png'});console.log('visible road contact',contact);
  assert.deepEqual(errors,[]);
}finally{await browser.close();}
