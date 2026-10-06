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
  /** Follow the visible asphalt: a custom finish with no route to trust. */
  private readonly followRoad:boolean;
  /** Saved lap to rejoin, while driving the circuit's own loop past a finish the lap does not continue from. */
  private readonly lap?:Vec3[];
  private bridging=false;
  constructor(private track:Track){
    const points=track.mapPath?.length?track.mapPath:buildRoadMesh(track).points.map(p=>p.center);
    const end=points.at(-1)!;
    // A saved lap that starts somewhere else (Daytona: the pit lane) has no road beyond its finish line.
    // Joining its start would cut across the infield, so drive on along the track and rejoin the lap later.
    const lapGap=Math.hypot(end.x-points[0].x,end.z-points[0].z)*track.metersPerUnit;
    if(track.mapPath?.length&&lapGap>25)this.lap=points;
    this.followRoad=!track.mapPath&&!!track.localFinish;

    let join=0,best=Infinity;
    // Timing routes overlap the opening straight. Skip that duplicate run-up,
    // otherwise wrapping the route asks the driver to make a U-turn at the flag.
    for(let i=0;i<Math.floor(points.length*.25);i++){
      const p=points[i],distance=Math.hypot(end.x-p.x,end.z-p.z);
      if(distance<best){best=distance;join=i;}
    }
    this.route=points.slice(join);
  }
  begin(sim:Simulation){this.speed=Math.max(0,sim.forwardSpeed);this.segment=-1;
    // Past a finish the saved lap does not continue from: read the road ahead until the lap is met again.
    this.bridging=!!this.lap;this.heading=Math.atan2(this.track.finish.forward.x,this.track.finish.forward.z);this.roadTarget=undefined;}
  step(sim:Simulation){
    const p=sim.car.translation(),q=sim.car.rotation(),forward=rotate(q,{x:0,y:0,z:1}),right=rotate(q,{x:1,y:0,z:0});
    if(this.bridging&&this.lap&&sim.finishTicks%10===0){
      // Rejoin the saved lap where the car meets it heading the same way (route ahead, not the opening pit run).
      for(let i=Math.floor(this.lap.length*.05);i<Math.floor(this.lap.length*.6);i++){
        const a=this.lap[i],b=this.lap[i+1],dx=b.x-a.x,dz=b.z-a.z,length=Math.hypot(dx,dz)||1;
        if(Math.hypot(p.x-a.x,p.z-a.z)*this.track.metersPerUnit<10&&(dx*forward.x+dz*forward.z)/length>.9){(this.route as Vec3[]).splice(0,this.route.length,...this.lap.slice(i));this.segment=-1;this.bridging=false;break;}
      }
    }
    if(this.followRoad||this.bridging){
      // Custom finish placements can be far from the original timing route.
      // Read the visible asphalt edges instead of steering toward obsolete points.
      if(!this.roadTarget||sim.finishTicks%6===0){
        const look=Math.max(12,sim.speed*.8),fx=Math.sin(this.heading),fz=Math.cos(this.heading);
        const center={x:p.x+fx*look,y:p.y,z:p.z+fz*look};
        // The asphalt band across the road ahead: walk out from the centre while each 2 m step stays on road
        // and climbs no steeper than banking (33 degrees). Walls and grass end it; banking does not.
        const floor=sim.roadHeightAt({...center,y:p.y+3/this.track.metersPerUnit})??sim.roadHeightAt(center);
        let offset=0;
        if(floor!==undefined){
          const reach=[-1,1].map(side=>{let previous=floor,edge=0;
            for(let x=2;x<=40;x+=2){const h=sim.roadHeightAt({x:center.x+fz*x*side,y:previous+3/this.track.metersPerUnit,z:center.z-fx*x*side});if(h===undefined||Math.abs(h-previous)>1.3/this.track.metersPerUnit)break;previous=h;edge=x;}
            return edge;});
          offset=(reach[1]-reach[0])/2;
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
