import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const carId=process.argv[2]??'nascar-camry';
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
  const page=await browser.newPage({viewport:{width:1280,height:800}});
  await page.goto('http://127.0.0.1:5173/');
  await page.waitForFunction(()=>window.__apex?.state.modelReady&&window.__apex.state.trackReady);
  const result=await page.evaluate(async carId=>{
    const game=window.__apex;
    const {TRACKS,orientation}=await import('/shared/tracks.ts');
    const {Input}=await import('/shared/physics.ts');
    const track=structuredClone(TRACKS.find(item=>item.id==='daytona'));
    const forward={x:.05,y:0,z:-.99875};
    track.spawn={...track.start,position:{x:810.5,y:.75,z:-450},forward,rotation:orientation(forward)};
    game.frame=()=>{};
    await game.select(track);
    await game.selectCar(carId);
    game.start(false);
    const sim=game.sim,world=game.world;
    sim.steeringStrength=1.5;
    sim.car.setLinvel({x:4,y:0,z:carId==='red-bull-rb19'?-90:-80},true);
    let previousOffset,maxOffsetJump=0,minWheelGap=Infinity;
    for(let tick=0;tick<150;tick++){
      const p=sim.car.translation(),q=sim.car.rotation();
      let segment=8,distance=Infinity;
      for(let i=7;i<=13;i++){
        const line=track.segments[i],dx=line.end.x-line.start.x,dz=line.end.z-line.start.z;
        const t=Math.max(0,Math.min(1,((p.x-line.start.x)*dx+(p.z-line.start.z)*dz)/(dx*dx+dz*dz)));
        const d=Math.hypot(p.x-line.start.x-dx*t,p.z-line.start.z-dz*t);
        if(d<distance){distance=d;segment=i;}
      }
      let remaining=60,target=track.segments[segment].end;
      for(let i=segment;i<track.segments.length;i++){
        const line=track.segments[i],dx=line.end.x-line.start.x,dz=line.end.z-line.start.z,length=Math.hypot(dx,dz);
        const t=i===segment?Math.max(0,Math.min(1,((p.x-line.start.x)*dx+(p.z-line.start.z)*dz)/(length*length))):0;
        const available=(1-t)*length;
        if(remaining<=available){target={x:line.start.x+dx*(t+remaining/length),z:line.start.z+dz*(t+remaining/length)};break;}
        remaining-=available;
      }
      const yaw=Math.atan2(2*(q.w*q.y+q.x*q.z),1-2*(q.y*q.y+q.x*q.x));
      let error=Math.atan2(target.x-p.x,target.z-p.z)-yaw;
      while(error>Math.PI)error-=2*Math.PI;
      while(error< -Math.PI)error+=2*Math.PI;
      sim.step(Input.Throttle|(error>.012?Input.Left:error<-.012?Input.Right:0));
      world.chase(sim,1/60);
      const offset=world.car.position.y-sim.car.translation().y;
      if(previousOffset!==undefined)maxOffsetJump=Math.max(maxOffsetJump,Math.abs(offset-previousOffset));
      previousOffset=offset;
      world.car.updateMatrixWorld(true);
      for(const wheel of world.wheelGroups){
        const center=wheel.getWorldPosition(world.center.clone()),floor=sim.visibleGroundAt(center);
        if(floor!==undefined)minWheelGap=Math.min(minWheelGap,center.y-wheel.userData.radius-floor);
      }
    }
    return {maxOffsetJump,minWheelGap,respawns:sim.respawns};
  },carId);
  assert.ok(result.maxOffsetJump<.15,`car jumps ${result.maxOffsetJump.toFixed(3)} m in one frame`);
  assert.ok(result.minWheelGap>(carId==='red-bull-rb19'?-.08:-.04),`tire penetrates ${(-result.minWheelGap).toFixed(3)} m into the road`);
  assert.equal(result.respawns,0,'car must not fall through the road');
  console.log(`Daytona ${carId} visual bank transition:`,result);
}finally{await browser.close();}
