import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const directory=process.argv[2]??'work/physics-audit';await mkdir(directory,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[],results=[];
page.on('pageerror',e=>errors.push(e.message));
try{
  await page.goto('http://127.0.0.1:5173/');
  await page.waitForFunction(()=>window.__apex?.state.modelReady&&window.__apex.state.trackReady);
  // Use the production renderer and supplied models, driven in fixed ticks so
  // each saved image can be compared to the exact same physics state in Node.
  await page.evaluate(()=>{const game=window.__apex;game.frame=()=>{};document.getElementById('app').style.display='none';});
  for(const carId of ['porsche-963','celica-gt4','bugatti-bolide','ferrari-488-gt3']){
    await page.evaluate(async carId=>{
      const {Simulation}=await import('/shared/physics.ts'),{handlingTrack}=await import('/tests/handling-harness.ts');
      const game=window.__apex;game.sim.dispose();game.sim=new Simulation(handlingTrack(),carId);game.sim.steeringStrength=1.1;
      await game.world.setCar(carId);game.world.setTrack(game.sim.track);
      game.world.chase(game.sim,1/60,true);game.world.render();
    },carId);
    for(const maneuver of ['power-left','reversal','brake-left']){
      const trace=await page.evaluate(async({carId,maneuver})=>{
        const {Simulation,rotate}=await import('/shared/physics.ts'),{handlingTrack,telemetry,MANEUVERS}=await import('/tests/handling-harness.ts');
        const game=window.__apex;game.sim.dispose();game.sim=new Simulation(handlingTrack(),carId);game.sim.steeringStrength=1.1;
        game.sim.car.setLinvel({x:0,y:0,z:44.704},true);game.world.chase(game.sim,1/60,true);
        const trace=[];
        for(let tick=0;tick<240;tick++){
          game.sim.step(MANEUVERS[maneuver](tick/60));game.world.chase(game.sim,1/60);
          if(tick%30===29){
            game.world.render();await new Promise(requestAnimationFrame);
            const s=telemetry(game.sim),q=game.world.car.quaternion,front=rotate(q,{x:0,y:0,z:1});
            const yaw=Math.atan2(front.x,front.z)*180/Math.PI;
            trace.push({...s,visualYaw:yaw,frontSteer:game.world.wheelGroups[0].rotation.y});
          }
        }
        return trace;
      },{carId,maneuver});
      assert.ok(trace.every(s=>Math.abs(Math.atan2(Math.sin((s.visualYaw-s.yaw)*Math.PI/180),Math.cos((s.visualYaw-s.yaw)*Math.PI/180)))<.015),'rendered yaw must follow the physics');
      results.push({carId,maneuver,trace});
      await page.screenshot({path:`${directory}/${carId}-${maneuver}.png`});
      console.log('Rendered',carId,maneuver);
    }
  }
  for(const [carId,trackId,mph] of [['porsche-963','bugatti',100],['celica-gt4','bugatti',40],['bugatti-bolide','spa',150]]){
    await page.evaluate(async({carId,trackId,mph})=>{
      const {TRACKS}=await import('/shared/tracks.ts'),{Simulation,initPhysics,rotate}=await import('/shared/physics.ts');
      const game=window.__apex,track=TRACKS.find(t=>t.id===trackId);await initPhysics(track);
      game.sim.dispose();game.sim=new Simulation(track,carId);game.sim.steeringStrength=1.1;
      await game.world.setCar(carId);game.world.setTrack(track);
      const forward=rotate(game.sim.car.rotation(),{x:0,y:0,z:1}),speed=mph*.44704/track.metersPerUnit;
      game.sim.car.setLinvel({x:forward.x*speed,y:forward.y*speed,z:forward.z*speed},true);
      game.world.camera.up.set(0,1,0);game.world.chase(game.sim,1/60,true);
    },{carId,trackId,mph});
    await page.waitForFunction(()=>window.__apex.world.venueGroup.children.length>0);
    const samples=[];
    for(const [phase,ticks,input] of [['straight',45,1],['steering-tap',20,5],['braking',85,2]]){
      samples.push(await page.evaluate(async({ticks,input})=>{
        const {telemetry}=await import('/tests/handling-harness.ts'),game=window.__apex;
        let lowest=Infinity;
        for(let i=0;i<ticks;i++){
          game.sim.step(input);game.world.chase(game.sim,1/60);game.world.car.updateMatrixWorld(true);
          for(const wheel of game.world.wheelGroups){
            const center=wheel.getWorldPosition(game.world.center.clone()),floor=game.sim.visibleGroundAt(center);
            if(floor!==undefined)lowest=Math.min(lowest,center.y-wheel.userData.radius-floor);
          }
        }
        game.world.render();return {...telemetry(game.sim),lowest};
      },{ticks,input}));
      await page.screenshot({path:`${directory}/circuit-${carId}-${phase}.png`});
    }
    results.push({carId,trackId,mph,samples});
    console.log('Circuit samples',carId,trackId,JSON.stringify(samples));
    await writeFile(`${directory}/browser-audit.json`,JSON.stringify({results,errors}));
    assert.ok(samples.every(s=>s.contacts>=3&&s.lowest>-.035),`${carId} on ${trackId}: rendered tires lost road contact`);
    console.log('Circuit render',carId,trackId,mph,'mph',samples.map(s=>({contacts:s.contacts,clearance:s.lowest})));
  }
  // Inspect an actual venue at the exact persistent lap obstruction.
  await page.evaluate(async()=>{
    const {TRACKS}=await import('/shared/tracks.ts'),w=window.__apex.world;
    w.setTrack(TRACKS.find(t=>t.id==='indianapolis'));
  });
  await page.waitForFunction(()=>window.__apex.world.venueGroup.children.length>0);
  await page.evaluate(()=>{
    const w=window.__apex.world;w.venueGroup.visible=true;w.car.visible=false;
    w.camera.position.set(-440,145,350);w.camera.up.set(0,0,-1);w.camera.lookAt(-440,10,350);
    w.camera.fov=60;w.camera.filmOffset=0;w.camera.updateProjectionMatrix();w.render();
  });
  await page.screenshot({path:`${directory}/indianapolis-barrier.png`});
  assert.deepEqual(errors,[]);
  await writeFile(`${directory}/browser-audit.json`,JSON.stringify({results,errors}));
}finally{await browser.close();}
