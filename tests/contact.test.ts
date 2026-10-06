import { test } from 'node:test';
import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { Matrix4, Vector3 } from 'three';
import { initPhysics, Input, rotate, Simulation, steeringLock } from '../shared/physics';
import { TRACKS, orientation } from '../shared/tracks';
import { CARS, carById, DEFAULT_CAR } from '../shared/cars';

// These anonymous material indices were visually checked against the embedded
// texture sheets. Sample the renderer's GLBs independently of collision bins.
const asphalt: Record<string, number[]> = {
  hungaroring: [16,48], barcelona: [68,76], indianapolis: [1,2,4,5,7],
  daytona: [70,73], 'marina-bay': [16,96,98]
};
test('visible asphalt in every GLB has physical contact, including away from timing routes', async t => {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  for (const track of TRACKS) await t.test(track.id, async () => {
    await initPhysics(track);
    // The rendered runtime model: its road is baked smooth, and collision is regenerated from it.
    const sim = new Simulation(track), doc = await io.read(`public/models/tracks/${track.runtimeModel ?? track.model}`);
    const materials = doc.getRoot().listMaterials(), samples: {p:Vector3;name:string;alpha:string}[] = [];
    doc.getRoot().getDefaultScene()!.traverse(node => {
      const mesh = node.getMesh(); if (!mesh) return;
      const matrix = new Matrix4().fromArray(node.getWorldMatrix());
      for (const p of mesh.listPrimitives()) {
        const m = p.getMaterial(); if (!m || p.getMode() !== 4) continue;
        if (!(asphalt[track.id]?.includes(materials.indexOf(m)) ?? /asph|^road(?:real|\d|_|$)|tarmac/i.test(m.getName()))) continue;
        const position = p.getAttribute('POSITION')!, indices = p.getIndices(), count = indices?.getCount() ?? position.getCount();
        const stride = Math.max(1, Math.floor(count / 3 / 24)) * 3;
        for (let i = 0; i + 2 < count; i += stride) {
          const element: number[] = [], vertices = [0,1,2].map(j => {
            position.getElement(indices ? indices.getScalar(i+j) : i+j, element);
            return new Vector3().fromArray(element).applyMatrix4(matrix);
          });
          const [a,b,c] = vertices, normal = b.clone().sub(a).cross(c.clone().sub(a));
          if (normal.length() < .2 || Math.abs(normal.y) / normal.length() < .85) continue;
          samples.push({p:a.clone().add(b).add(c).multiplyScalar(1/3),name:m.getName(),alpha:m.getAlphaMode()});
        }
      }
    });
    try {
      assert.ok(samples.length > 10, `${track.id}: insufficient asphalt samples`);
      t.diagnostic(`${track.id}: ${samples.length} independently sampled asphalt points`);
      for (const {p,name,alpha} of samples) {
        const hit = sim.world.castRay(new RAPIER.Ray({x:p.x,y:p.y+.3,z:p.z}, {x:0,y:-1,z:0}), .65, false, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC);
        // Transparent asphalt-joint decals float slightly above the real floor;
        // they should be supported by it, not become a second collision layer.
        assert.ok(hit && hit.timeOfImpact < (alpha==='BLEND' ? .5 : .34), `${track.id}: missed rendered asphalt (${name}, ${alpha}) at ${p.toArray()}; hit=${hit?.timeOfImpact}`);
      }
      for (let i=0;i<120;i++) sim.step(0);
      assert.equal(sim.respawns, 0, 'spawn must not drop through the model');
      assert.ok([0,1,2,3].some(i=>sim.vehicle.wheelIsInContact(i)));
    } finally { sim.dispose(); }
  });
});

test('all eleven cars accelerate with four-wheel asphalt contact; retired selection falls back safely', async () => {
  const track=TRACKS[0]; await initPhysics(track);
  assert.equal(CARS.length,11); assert.equal(carById('nascar-ss').id,DEFAULT_CAR.id);
  for (const car of CARS) {
    const sim=new Simulation(track,car.id);
    try {
      for(let i=0;i<180;i++)sim.step(Input.Throttle);
      assert.ok(sim.forwardSpeed>8,car.id); assert.equal(sim.respawns,0,car.id);
      assert.equal([0,1,2,3].filter(i=>sim.vehicle.wheelIsInContact(i)).length,4,car.id);
    } finally { sim.dispose(); }
  }
});

test('each imported circuit starts with its tyres on the visible (baked) road',async()=>{
  for(const track of TRACKS){await initPhysics(track);const sim=new Simulation(track);try{
    assert.ok([0,1,2,3].filter(i=>sim.vehicle.wheelIsInContact(i)).length>=2,track.id);
    const ground=sim.vehicle.wheelGroundObject([0,1,2,3].find(i=>sim.vehicle.wheelIsInContact(i))!);
    assert.equal(ground?.isSensor(),false,`${track.id}: tyres must rest on the visible venue road, not a hidden helper`);
  }finally{sim.dispose();}}
});

test('wheels stay on the road down the Bugatti acceleration straight',async()=>{
  const track=TRACKS.find(track=>track.id==='bugatti') ?? TRACKS[0];await initPhysics(track);const sim=new Simulation(track);
  try{
    let supportedFrames=0;
    for(let frame=0;frame<300;frame++){
      sim.step(Input.Throttle);
      if([0,1,2,3].filter(i=>sim.vehicle.wheelIsInContact(i)).length>=2)supportedFrames++;
    }
    assert.ok(supportedFrames>285,`${track.id}: road contact for only ${supportedFrames}/300 frames`);
    assert.equal(sim.respawns,0);
  }finally{sim.dispose();}
});

test('Daytona banking supports the RB19 at speed',async()=>{
  const track=structuredClone(TRACKS.find(track=>track.id==='daytona')!);
  const forward={x:.05,y:0,z:-.99875};
  track.spawn={...track.start,position:{x:811,y:1.04,z:-450},forward,rotation:orientation(forward)};
  await initPhysics(track);const sim=new Simulation(track,'red-bull-rb19');
  try{
    assert.equal([0,1,2,3].filter(i=>sim.vehicle.wheelIsInContact(i)).length,4,'banked spawn has four tyres on the road');
    sim.car.setLinvel({x:4.5,y:0,z:-89.9},true);
    let supported=0;
    for(let i=0;i<30;i++){
      sim.step(Input.Throttle);
      if([0,1,2,3].filter(index=>sim.vehicle.wheelIsInContact(index)).length>=3)supported++;
    }
    assert.ok(supported>=27,`banked tyres on the road for ${supported}/30 high-speed ticks`);
    assert.equal(sim.respawns,0);
  }finally{sim.dispose();}
});

test('Camry and RB19 cross Daytona bank transition without chassis snags',async()=>{
  const track=structuredClone(TRACKS.find(track=>track.id==='daytona')!);
  const forward={x:.05,y:0,z:-.99875};
  track.spawn={...track.start,position:{x:810.5,y:.75,z:-450},forward,rotation:orientation(forward)};
  await initPhysics(track);
  for(const carId of ['nascar-camry','red-bull-rb19'] as const){
    const sim=new Simulation(track,carId);
    try{
      sim.steeringStrength=1.5;
      sim.car.setLinvel({x:4,y:0,z:carId==='red-bull-rb19'?-90:-80},true);
      let stalls=0,maxAngular=0;
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
          if(remaining<=available){target={x:line.start.x+dx*(t+remaining/length),y:line.start.y,z:line.start.z+dz*(t+remaining/length)};break;}
          remaining-=available;
        }
        const yaw=Math.atan2(2*(q.w*q.y+q.x*q.z),1-2*(q.y*q.y+q.x*q.x));
        let error=Math.atan2(target.x-p.x,target.z-p.z)-yaw;
        while(error>Math.PI)error-=2*Math.PI;
        while(error< -Math.PI)error+=2*Math.PI;
        sim.step(Input.Throttle|(error>.012?Input.Left:error<-.012?Input.Right:0));
        const after=sim.car.translation(),motion=Math.hypot(after.x-p.x,after.z-p.z),angular=sim.car.angvel();
        if(sim.speed>30&&motion<sim.speed/120)stalls++;
        maxAngular=Math.max(maxAngular,Math.hypot(angular.x,angular.y,angular.z));
      }
      assert.ok(stalls<3,`${carId}: ${stalls} high-speed chassis snags`);
      assert.ok(maxAngular<5,`${carId}: angular spike ${maxAngular.toFixed(1)} rad/s`);
      assert.equal(sim.respawns,0,`${carId}: must not fall through Daytona`);
    }finally{sim.dispose();}
  }
});

test('a custom pre-route grid has four-wheel support and can launch',async()=>{
  const source=TRACKS[0],track=structuredClone(source);
  track.spawn={...track.start,position:{x:-17.043,y:-.2,z:191.201},forward:{x:.10023,y:0,z:-.99496},rotation:{x:0,y:.99874,z:0,w:.05018}};
  await initPhysics(track);const sim=new Simulation(track);
  try{
    assert.equal([0,1,2,3].filter(i=>sim.vehicle.wheelIsInContact(i)).length,4);
    for(let frame=0;frame<180;frame++)sim.step(Input.Throttle);
    assert.ok(sim.speed*track.metersPerUnit*2.23694>20);
  }finally{sim.dispose();}
});

test('throttle without steering holds a straight heading on the Bugatti grid',async()=>{
  const track=structuredClone(TRACKS[0]);
  track.spawn={...track.start,position:{x:-17.043,y:-.2,z:191.201},forward:{x:.10023,y:0,z:-.99496},rotation:{x:0,y:.99874,z:0,w:.05018}};
  await initPhysics(track);const sim=new Simulation(track);
  try{
    const start={...sim.car.translation()},right=rotate(sim.car.rotation(),{x:1,y:0,z:0});
    for(let frame=0;frame<390;frame++)sim.step(Input.Throttle);
    const end=sim.car.translation(),lateral=(end.x-start.x)*right.x+(end.y-start.y)*right.y+(end.z-start.z)*right.z;
    assert.equal(sim.steering,0);assert.ok(Math.abs(lateral)<.08,`W-only lateral drift was ${lateral.toFixed(3)} m`);
  }finally{sim.dispose();}
});

test('high-speed steering taps ramp gradually and do not snap on direction reversal', async () => {
  const track=TRACKS[0];await initPhysics(track);
  const sim=new Simulation(track);
  try {
    const forward=rotate(sim.car.rotation(),{x:0,y:0,z:1}), speed=60/track.metersPerUnit;
    sim.car.setLinvel({x:forward.x*speed,y:0,z:forward.z*speed},true);
    sim.step(Input.Left);
    assert.ok(sim.steering>0&&sim.steering<.004);
    for(let i=0;i<5;i++)sim.step(Input.Left);
    const before=sim.steering;
    sim.step(Input.Right);
    assert.ok(sim.steering>0,'a single opposite key tap must not instantly reverse lock');
    assert.ok(before-sim.steering<.006);
    assert.ok(Math.abs(sim.steering)<.035);
  } finally {sim.dispose();}
});

test('steering lock transitions smoothly from maneuvering to racing speed',()=>{
  const angle=.35, low=steeringLock(angle,5).lock, medium=steeringLock(angle,28).lock, high=steeringLock(angle,55).lock;
  assert.ok(low>.19&&low<.21);assert.ok(medium<low&&high<medium);
  assert.ok(55*55*Math.tan(high)/2.7<=14.01,'high-speed lock must respect the available cornering acceleration');
  let previous=low;for(let speed=5.1;speed<=55;speed+=.1){const current=steeringLock(angle,speed).lock;assert.ok(current<=previous);assert.ok(previous-current<.003,'lock must change continuously as speed rises');previous=current;}
});

test('high-speed stability assist damps unwanted lateral chatter without engaging a drift', async () => {
  const track=TRACKS[0];await initPhysics(track);
  const sim=new Simulation(track);
  try {
    const forward=rotate(sim.car.rotation(),{x:0,y:0,z:1}), right=rotate(sim.car.rotation(),{x:1,y:0,z:0});
    const speed=58/track.metersPerUnit;
    sim.car.setLinvel({x:forward.x*speed+right.x*4,y:0,z:forward.z*speed+right.z*4},true);
    const lateral=()=>{const v=sim.car.linvel(),r=rotate(sim.car.rotation(),{x:1,y:0,z:0});return v.x*r.x+v.y*r.y+v.z*r.z;};
    const before=Math.abs(lateral()); for(let i=0;i<30;i++)sim.step(0);
    assert.ok(Math.abs(lateral())<before*.7);assert.equal(sim.drifting,false);
  } finally {sim.dispose();}
});

test('ground contact damps chassis pitch and roll while retaining steering yaw',async()=>{
  const track=TRACKS[0];await initPhysics(track);const sim=new Simulation(track);
  try{
    sim.car.setAngvel({x:2,y:1,z:2},true);sim.step(0);
    const angular=sim.car.angvel(),up=rotate(sim.car.rotation(),{x:0,y:1,z:0}),yaw=angular.x*up.x+angular.y*up.y+angular.z*up.z;
    const tilt=Math.hypot(angular.x-up.x*yaw,angular.y-up.y*yaw,angular.z-up.z*yaw);
    assert.ok(tilt<.3);assert.ok(Math.abs(yaw)<1,'uncommanded yaw should also settle');
  }finally{sim.dispose();}
});

test('imported-mesh simulation is deterministic under identical steering and pedal inputs', async () => {
  const track=TRACKS[0];await initPhysics(track);
  const a=new Simulation(track),b=new Simulation(track);
  try {
    for(let i=0;i<300;i++) {
      const input=i<180?Input.Throttle:i<230?Input.Brake|Input.Left:Input.Throttle|Input.Right;
      a.step(input);b.step(input);
      assert.deepEqual(a.frame(),b.frame());
    }
    assert.deepEqual(a.world.takeSnapshot(),b.world.takeSnapshot());
  } finally {a.dispose();b.dispose();}
});

test('natural rear slip builds gently during a fast corner and releases on a straight',async t=>{
  await initPhysics();
  const gate={position:{x:0,y:0,z:0},forward:{x:0,y:0,z:1},rotation:{x:0,y:0,z:0,w:1},width:1000,segment:0};
  const track={...TRACKS[0],id:'rear-slip-test',collision:undefined,spawn:undefined,metersPerUnit:1,start:gate,checkpoints:[],finish:{...gate,position:{x:0,y:0,z:900}},
    segments:[{id:'flat',next:null,start:{x:0,y:0,z:-100},end:{x:0,y:0,z:1000},width:1000,surface:'road' as const,rails:false}]};
  const sim=new Simulation(track);
  try{
    for(let i=0;i<120;i++)sim.step(Input.Throttle);
    assert.equal(sim.autoDrift,0,'no spontaneous slip on throttle alone');
    sim.car.setLinvel({x:0,y:0,z:42},true);
    let maxSlip=0,previous=0;
    for(let i=0;i<240;i++){
      sim.step(Input.Throttle|Input.Left);
      assert.ok(Math.abs(sim.autoDrift-previous)<.025,'rear grip must change gradually');previous=sim.autoDrift;
      const right=rotate(sim.car.rotation(),{x:1,y:0,z:0}),v=sim.car.linvel();
      maxSlip=Math.max(maxSlip,Math.abs(Math.atan2(v.x*right.x+v.y*right.y+v.z*right.z,sim.forwardSpeed)));
    }
    assert.ok(sim.autoDrift>.1&&sim.autoDrift<=.156);
    {const v=sim.car.linvel(),r=rotate(sim.car.rotation(),{x:1,y:0,z:0});t.diagnostic(`maximum corner slip ${(maxSlip*180/Math.PI).toFixed(2)} degrees; auto ${sim.autoDrift.toFixed(3)}; lateral ${(v.x*r.x+v.y*r.y+v.z*r.z).toFixed(2)} m/s; forward ${sim.forwardSpeed.toFixed(2)} m/s`);}
    {const v=sim.car.linvel(),r=rotate(sim.car.rotation(),{x:1,y:0,z:0});assert.ok(v.x*r.x+v.y*r.y+v.z*r.z<0,'momentum must fall outside the positive-steering corner, toward local -X');}
    assert.ok(maxSlip>.017,'high-speed cornering should retain a little natural outward slip');
    assert.ok(maxSlip<.105,'large slides should require Left Shift');
    assert.ok((sim.vehicle.wheelSideFrictionStiffness(2)??0)<(sim.vehicle.wheelSideFrictionStiffness(0)??0));
    for(let i=0;i<90;i++)sim.step(Input.Throttle);
    assert.ok(sim.autoDrift<.003,'straight-line grip must recover');
  }finally{sim.dispose();}
});

test('turning the Porsche 963 wheel while stopped does not move the car',async()=>{
  await initPhysics();
  const gate={position:{x:0,y:0,z:0},forward:{x:0,y:0,z:1},rotation:{x:0,y:0,z:0,w:1},width:1000,segment:0};
  const track={...TRACKS[0],id:'stationary-steer-test',collision:undefined,spawn:undefined,metersPerUnit:1,start:gate,checkpoints:[],finish:{...gate,position:{x:0,y:0,z:900}},
    segments:[{id:'flat',next:null,start:{x:0,y:0,z:-100},end:{x:0,y:0,z:1000},width:1000,surface:'road' as const,rails:false}]};
  const sim=new Simulation(track,'porsche-963');
  try{
    const start={...sim.car.translation()};for(let i=0;i<180;i++)sim.step(Input.Left);
    const end=sim.car.translation();
    assert.ok(sim.steering>.01,'the steering input still turns the front wheels');
    assert.ok(Math.hypot(end.x-start.x,end.z-start.z)<.01,'steering alone must not roll the chassis');
    assert.ok(Math.hypot(sim.car.linvel().x,sim.car.linvel().z)<.005);
    assert.ok(Math.hypot(sim.car.angvel().x,sim.car.angvel().y,sim.car.angvel().z)<.005);
  }finally{sim.dispose();}
});
