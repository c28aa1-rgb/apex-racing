import { mkdir, writeFile } from 'node:fs/promises';
import { CARS } from '../shared/cars';
import { initPhysics, PHYSICS_VERSION } from '../shared/physics';
import { MANEUVERS, runManeuver, performanceRun, type Maneuver } from './handling-harness';

await initPhysics();
const results=[],performance=[];
for(const car of CARS){
  for(const manual of process.argv.includes('--with-shift')?[false,true]:[false])
    for(const mph of [0,5,15,30,60,100,150,200])for(const maneuver of Object.keys(MANEUVERS) as Maneuver[])results.push(runManeuver(car.id,mph,maneuver,5,1.1,manual));
  performance.push(performanceRun(car.id));
  console.log(`Tested ${car.shortName}`);
}
const name=process.argv[2]??PHYSICS_VERSION;
if(!/^[\w-]+$/.test(name))throw new Error('Use a simple report name');
await mkdir('work/physics-audit',{recursive:true});
await writeFile(`work/physics-audit/${name}.json`,JSON.stringify({version:PHYSICS_VERSION,cases:results.length,performance,results}));
console.table(performance);
console.table(results.filter(r=>r.carId==='porsche-963'&&[0,30,100,200].includes(r.mph)).map(r=>({mph:r.mph,case:r.maneuver,g:+r.maxG.toFixed(1),slip:+r.maxSlip.toFixed(1),slipStep:+r.maxSlipStep.toFixed(1),yaw:+r.final.yaw.toFixed(1),speed:+(r.final.speed/.44704).toFixed(1),air:r.airTicks})));
console.log(`Saved ${results.length} scenarios to work/physics-audit/${name}.json`);
