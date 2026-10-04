import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir,writeFile } from 'node:fs/promises';
import { createCanvas,loadImage } from '@napi-rs/canvas';
const browser=await chromium.launch({channel:'chrome',headless:true}),results=[],errors=[];
const directory='work/physics-audit/wheel-attachment';await mkdir(directory,{recursive:true});
try{
  const page=await browser.newPage({viewport:{width:1000,height:650}});
  page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:5173/');
  await page.waitForFunction(()=>window.__apex?.state.modelReady&&window.__apex.state.trackReady);
  const ids=await page.evaluate(async()=>{window.__apex.frame=()=>{};document.getElementById('app').style.display='none';return(await import('/shared/cars.ts')).CARS.map(c=>c.id);});
  for(const id of ids){
    const result=await page.evaluate(async id=>{
      const {Simulation}=await import('/shared/physics.ts'),{handlingTrack}=await import('/tests/handling-harness.ts');
      const g=window.__apex,w=g.world;g.sim.dispose();g.sim=new Simulation(handlingTrack(),id);g.sim.steeringStrength=1.1;
      await w.setCar(id);w.setTrack(g.sim.track);g.sim.car.setLinvel({x:0,y:0,z:100*.44704},true);w.chase(g.sim,1/60,true);
      let offset=0,lowest=Infinity,highest=-Infinity,maxStep=0,previousY;
      for(let tick=0;tick<360;tick++){
        g.sim.step(tick<90?1:tick<240?21:2);
        // Reproduce a body-height filter lag after a road-height transition.
        if(tick===100){w.visualCarPosition.y+=.35;w.visualSuspensionLift+=.25;}
        w.chase(g.sim,1/60);w.car.updateMatrixWorld(true);
        if(previousY!==undefined)maxStep=Math.max(maxStep,Math.abs(w.car.position.y-previousY));previousY=w.car.position.y;
        for(const wheel of w.wheelGroups){
          offset=Math.max(offset,Math.abs(wheel.position.y-wheel.userData.rest[1]));
          const p=wheel.getWorldPosition(w.center.clone()),floor=g.sim.visibleGroundAt(p);
          if(floor!==undefined){const clearance=p.y-wheel.userData.radius-floor;lowest=Math.min(lowest,clearance);highest=Math.max(highest,clearance);}
        }
      }
      const p=w.car.position;w.camera.position.set(p.x+5,p.y+1.3,p.z+7);w.camera.lookAt(p.x,p.y-.15,p.z);w.camera.fov=40;w.camera.updateProjectionMatrix();w.render();
      const groundedResult={id,wheels:w.wheelGroups.length,offset,lowest,highest,maxStep};
      // Keep the floor close enough that the old unconditional visual ray
      // would pull tires down. These controlled contact masks specifically
      // isolate the renderer's behavior with 0, 1 and 2 supporting wheels.
      const originalContact=g.sim.vehicle.wheelIsInContact.bind(g.sim.vehicle),partial=[];
      for(const count of [0,1,2]){
        g.sim.vehicle.wheelIsInContact=i=>i<count;
        const frame=g.sim.frame();frame.p={...frame.p,y:frame.p.y+.35};
        w.chase(g.sim,1/60,true,frame);w.car.updateMatrixWorld(true);
        partial.push({contacts:count,bodyError:Math.abs(w.car.position.y-frame.p.y),
          unloadedQueries:w.visibleWheelFloors.slice(count).filter(f=>f!==undefined).length,
          maxOffset:Math.max(...w.wheelGroups.map(wheel=>Math.abs(wheel.position.y-wheel.userData.rest[1])))});
      }
      g.sim.vehicle.wheelIsInContact=originalContact;
      // Also launch the actual simulation from a settled four-contact pose.
      g.sim.dispose();g.sim=new Simulation(handlingTrack(),id);
      for(let tick=0;tick<60;tick++)g.sim.step(0);
      const startY=g.sim.car.translation().y;g.sim.car.setLinvel({x:0,y:6,z:0},true);
      let airTicks=0,airBodyError=0,airOffset=0,peak=0,unloadedBodyError=0,unloadedFloorQueries=0;
      for(let tick=0;tick<90;tick++){
        g.sim.step(0);w.chase(g.sim,1/60,true);w.car.updateMatrixWorld(true);
        peak=Math.max(peak,g.sim.car.translation().y-startY);
        const loaded=[0,1,2,3].filter(i=>g.sim.vehicle.wheelIsInContact(i)&&(g.sim.vehicle.wheelSuspensionForce(i)??0)>0);
        if(loaded.length<3)unloadedBodyError=Math.max(unloadedBodyError,Math.abs(w.car.position.y-g.sim.car.translation().y));
        unloadedFloorQueries+=w.visibleWheelFloors.filter((f,i)=>!loaded.includes(w.wheelGroups[i].userData.index)&&f!==undefined).length;
        if(![0,1,2,3].some(i=>g.sim.vehicle.wheelIsInContact(i))){
          airTicks++;airBodyError=Math.max(airBodyError,Math.abs(w.car.position.y-g.sim.car.translation().y));
          airOffset=Math.max(airOffset,...w.wheelGroups.map(wheel=>Math.abs(wheel.position.y-wheel.userData.rest[1])));
        }
      }
      return {...groundedResult,partial,airTicks,airBodyError,airOffset,peak,unloadedBodyError,unloadedFloorQueries};
    },id);
    results.push(result);console.log(result);
    assert.equal(result.wheels,4,`${id}: missing wheel rig`);
    assert.ok(result.offset<=.045001,`${id}: wheel separated from the body`);
    assert.ok(result.lowest>-.035,`${id}: tire clipped into the flat road`);
    assert.ok(result.highest<.065,`${id}: tire floated above the flat road`);
    assert.ok(result.maxStep<.05,`${id}: body fit introduced a vertical snap`);
    assert.ok(result.partial.every(r=>r.bodyError<1e-6&&r.unloadedQueries===0&&r.maxOffset<=.045001),`${id}: partial contact pinned the model to the road`);
    assert.ok(result.airTicks>=15&&result.peak>.5,`${id}: car could not lift off`);
    assert.ok(result.airBodyError<1e-6&&result.airOffset<=.045001,`${id}: airborne wheels detached or pulled the body toward the floor`);
    assert.ok(result.unloadedBodyError<1e-6&&result.unloadedFloorQueries===0,`${id}: visual correction cancelled takeoff while unloaded rays still reached the road`);
    await page.screenshot({path:`${directory}/${id}.png`});
  }
  const canvas=createCanvas(1500,1047),ctx=canvas.getContext('2d');ctx.fillStyle='#152c37';ctx.fillRect(0,0,1500,1047);
  for(const [i,r]of results.entries()){const x=i%3*500,y=Math.floor(i/3)*349;ctx.drawImage(await loadImage(`${directory}/${r.id}.png`),x,y,500,325);ctx.fillStyle='white';ctx.font='16px sans-serif';ctx.fillText(r.id,x+8,y+343);}
  await writeFile(`${directory}/sheet.png`,canvas.toBuffer('image/png'));
  assert.deepEqual(errors,[]);await writeFile(`${directory}/results.json`,JSON.stringify({results,errors},null,2));
}finally{await browser.close();}
