import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CARS } from '../shared/cars';
import { initPhysics, Simulation, rotate } from '../shared/physics';
import { orientation, trackById, type Vec3 } from '../shared/tracks';

// Recorded Spa approach, compression and uphill exit; no live editor required.
const path: Vec3[] = JSON.parse(readFileSync(new URL('./fixtures/spa-eau-rouge.json', import.meta.url), 'utf8'));
test('all cars cross Spa Eau Rouge without support chatter or chassis snags', async t => {
  const track=structuredClone(trackById('spa')!);
  track.mapPath=path;
  const heading=Math.atan2(path[96].x-path[95].x,path[96].z-path[95].z);
  const forward={x:Math.sin(heading),y:0,z:Math.cos(heading)};
  track.spawn={...track.start,position:path[95],forward,rotation:orientation(forward)};
  await initPhysics(track);
  for(const car of CARS)await t.test(car.id,()=>{
    const sim=new Simulation(track,car.id);
    try{
      sim.finished=true;
      const f=rotate(sim.car.rotation(),{x:0,y:0,z:1});
      sim.car.setLinvel({x:f.x*45,y:f.y*45,z:f.z*45},true);
      let index=95,maxTilt=0,airTicks=0,stalls=0;
      for(let tick=0;tick<1500&&index<150;tick++){
        const p={...sim.car.translation()};let nearest=Infinity;
        for(let i=Math.max(0,index-3);i<Math.min(path.length,index+15);i++){
          const distance=Math.hypot(path[i].x-p.x,path[i].z-p.z);
          if(distance<nearest){nearest=distance;index=i;}
        }
        const target=path[index+3],f=rotate(sim.car.rotation(),{x:0,y:0,z:1});
        let error=Math.atan2(target.x-p.x,target.z-p.z)-Math.atan2(f.x,f.z);
        error=Math.atan2(Math.sin(error),Math.cos(error));
        sim.stepFinish(error*.8,Math.abs(error)>.25?13:Math.abs(error)>.08?30:55);
        const up=rotate(sim.car.rotation(),{x:0,y:1,z:0}),w=sim.car.angvel(),yaw=w.x*up.x+w.y*up.y+w.z*up.z;
        if(tick>40)maxTilt=Math.max(maxTilt,Math.hypot(w.x-up.x*yaw,w.y-up.y*yaw,w.z-up.z*yaw));
        // The car is dropped in at 100 mph on the downhill approach; ignore that first settling hop and count chatter after it.
        if(tick>40&&![0,1,2,3].some(i=>sim.vehicle.wheelIsInContact(i)))airTicks++;
        const after=sim.car.translation();
        if(sim.speed>10&&Math.hypot(after.x-p.x,after.z-p.z)<sim.speed/120)stalls++;
        assert.ok(up.y>.97,'chassis follows the road without rolling');
      }
      t.diagnostic(JSON.stringify({car:car.id,index,maxTilt,airTicks,stalls}));
      assert.ok(index>=150,'reaches the uphill exit');
      // Tyres ride the real (baked, capped) Eau Rouge kerbs now, not a hidden 24 m-smoothed skin: a kerb strike
      // gives a one-tick roll transient up to ~1.6 rad/s. Same limit as tests/smooth-audit.ts spikes.
      assert.ok(maxTilt<2,`pitch/roll spike: ${maxTilt.toFixed(2)} rad/s`);
      assert.ok(airTicks<10,`lost all wheel contact on ${airTicks} ticks`);
      assert.equal(stalls,0);assert.equal(sim.respawns,0);
    }finally{sim.dispose();}
  });
});
