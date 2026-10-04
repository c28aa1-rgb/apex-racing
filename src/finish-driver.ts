import { rotate, type Simulation } from '../shared/physics';
import { buildRoadMesh } from '../shared/road';
import type { Track, Vec3 } from '../shared/tracks';

/** Pure pursuit drives the same rigid body; never teleports or disables collisions. */
export class FinishDriver {
  readonly route:Vec3[];
  speed=0;
  private segment=-1;
  private roadTarget?:Vec3;
  private heading=0;
  constructor(private track:Track){
    const points=track.mapPath?.length?track.mapPath:buildRoadMesh(track).points.map(p=>p.center);
    const end=points.at(-1)!;
    let join=0,best=Infinity;
    // Timing routes overlap the opening straight. Skip that duplicate run-up,
    // otherwise wrapping the route asks the driver to make a U-turn at the flag.
    for(let i=0;i<Math.floor(points.length*.25);i++){
      const p=points[i],distance=Math.hypot(end.x-p.x,end.z-p.z);
      if(distance<best){best=distance;join=i;}
    }
    this.route=points.slice(join);
  }
  begin(sim:Simulation){this.speed=Math.max(0,sim.forwardSpeed);this.segment=-1;this.heading=Math.atan2(this.track.finish.forward.x,this.track.finish.forward.z);this.roadTarget=undefined;}
  step(sim:Simulation){
    const p=sim.car.translation(),q=sim.car.rotation(),forward=rotate(q,{x:0,y:0,z:1}),right=rotate(q,{x:1,y:0,z:0});
    if(!this.track.mapPath&&this.track.localFinish){
      // Custom finish placements can be far from the original timing route.
      // Read the visible asphalt edges instead of steering toward obsolete points.
      if(!this.roadTarget||sim.finishTicks%6===0){
        const look=Math.max(12,sim.speed*.8),fx=Math.sin(this.heading),fz=Math.cos(this.heading);
        const center={x:p.x+fx*look,y:p.y,z:p.z+fz*look};
        const floor=sim.roadHeightAt(center)??p.y-.75;
        const probe={...center,y:floor+.6};
        const left=sim.roadEdgeDistance(probe,{x:-fz,y:0,z:fx}),right=sim.roadEdgeDistance(probe,{x:fz,y:0,z:-fx});
        let best=Infinity,offset=0,start:number|undefined;
        for(let x=-40;x<=42;x+=2){
          const height=x<=40?sim.roadHeightAt({x:center.x+fz*x,y:center.y,z:center.z-fx*x}):undefined;
          const road=x>-left+.5&&x<right-.5&&height!==undefined&&Math.abs(height-floor)<.65;
          if(road&&start===undefined)start=x;
          if(!road&&start!==undefined){const end=x-2,middle=(start+end)/2,width=end-start;
            if(width>=4&&Math.abs(middle)<best){best=Math.abs(middle);offset=middle;}
            start=undefined;
          }
        }
        offset=Math.max(-look*.45,Math.min(look*.45,offset));
        this.roadTarget={x:center.x+fz*offset,y:center.y,z:center.z-fx*offset};
        const next=Math.atan2(this.roadTarget.x-p.x,this.roadTarget.z-p.z),delta=Math.atan2(Math.sin(next-this.heading),Math.cos(next-this.heading));
        this.heading+=delta*.25;
      }
      const dx=this.roadTarget.x-p.x,dz=this.roadTarget.z-p.z,curvature=2*(dx*right.x+dz*right.z)/Math.max(1,dx*dx+dz*dz);
      sim.stepFinish(Math.atan(sim.carSpec.dimensions.wheelbaseM*curvature),Math.min(this.speed,Math.sqrt(9/(Math.abs(curvature)+.00001))));return;
    }
    let best=Infinity,index=0,fraction=0;
    const n=this.route.length;
    // Local search prevents choosing a nearby pit lane or the opposite side of a hairpin.
    for(let k=0;k<(this.segment<0?n:28);k++){
      const i=this.segment<0?k:(this.segment-3+k+n)%n,a=this.route[i],b=this.route[(i+1)%n];
      const dx=b.x-a.x,dz=b.z-a.z,length2=dx*dx+dz*dz;if(length2<.01)continue;
      const t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.z-a.z)*dz)/length2));
      const distance=(p.x-a.x-dx*t)**2+(p.z-a.z-dz*t)**2+(p.y-a.y-(b.y-a.y)*t)**2;
      const wrongWay=this.segment<0&&dx*forward.x+dz*forward.z<0?10000:0;
      if(distance+wrongWay<best){best=distance+wrongWay;index=i;fraction=t;}
    }
    this.segment=index;
    let remaining=Math.max(9,sim.speed*.7),target=this.route[index];
    for(let k=0;k<n;k++){
      const a=this.route[(index+k)%n],b=this.route[(index+k+1)%n],start=k?0:fraction;
      const length=Math.hypot(b.x-a.x,b.z-a.z),available=length*(1-start);
      if(remaining<=available){const t=start+remaining/length;target={x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t};break;}
      remaining-=available;
    }
    const dx=target.x-p.x,dz=target.z-p.z,curvature=2*(dx*right.x+dz*right.z)/Math.max(1,dx*dx+dz*dz);
    // Hold crossing speed on straights; brake only when the actual bend needs it.
    const cornerSpeed=Math.sqrt(9/(Math.abs(curvature)+.00001));
    sim.stepFinish(Math.atan(sim.carSpec.dimensions.wheelbaseM*curvature),Math.min(this.speed,cornerSpeed));
  }
}
