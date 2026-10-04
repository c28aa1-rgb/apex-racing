import type { CarDefinition, CarId } from './cars';
// One rev/gear specification drives physics, tachometer, replay and engine audio.
export const TRANSMISSIONS:Record<CarId,{idle:number;redline:number;gears:number}>={
  'ferrari-488-gt3':{idle:1100,redline:8000,gears:6},'mclaren-720s-gt3':{idle:1200,redline:8500,gears:6},
  'bugatti-bolide':{idle:900,redline:7000,gears:7},'peugeot-9x8':{idle:1500,redline:8500,gears:7},
  'celica-gt4':{idle:1000,redline:7200,gears:5},'porsche-911-gt3':{idle:950,redline:9000,gears:7},
  'porsche-963':{idle:1400,redline:8000,gears:7},'mazda-787b':{idle:1800,redline:10000,gears:5},
  'skyline-r34':{idle:1000,redline:7800,gears:6},'red-bull-rb19':{idle:3500,redline:12000,gears:8},
  'nascar-camry':{idle:1100,redline:9000,gears:4},
};
export function engineState(car:CarDefinition,speedMps:number,gear:number,throttle=0){
  const spec=TRANSMISSIONS[car.id],top=car.physics.topSpeedKph/3.6*Math.pow(gear/spec.gears,.8),load=Math.max(0,speedMps)/top;
  const rpm=Math.min(spec.redline*1.08,Math.max(spec.idle+throttle*850,spec.idle+(spec.redline-spec.idle)*load));
  return {...spec,rpm,load,top};
}
export function automaticGear(car:CarDefinition,speedMps:number){
  const spec=TRANSMISSIONS[car.id];let gear=1;while(gear<spec.gears&&engineState(car,speedMps,gear).load>.88)gear++;return gear;
}
