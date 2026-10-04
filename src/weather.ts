import * as THREE from 'three';
import type { WeatherPreset } from './settings';

export const WEATHER={
  clear:{color:0xc4e1eb,near:800,far:2600,sun:2.8,ambient:1.15},
  rain:{color:0x84939e,near:80,far:750,sun:.55,ambient:1.15},
  snow:{color:0xd2dce0,near:80,far:650,sun:.9,ambient:1.4},
  fog:{color:0xc6d0d2,near:25,far:240,sun:.4,ambient:1.35},
} as const;

/** One bounded draw call; no extra lights, render targets or per-frame allocations. */
export class Weather {
  readonly group=new THREE.Group();
  preset:WeatherPreset='clear';
  private positions=new Float32Array(900*6);
  private seeds=new Float32Array(900*3);
  private geometry=new THREE.BufferGeometry();
  private rain:THREE.LineSegments;
  private snow:THREE.Points;
  private time=0;
  seek(time:number){this.time=Math.max(0,time);}
  constructor(){
    let seed=47;
    for(let i=0;i<this.seeds.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;this.seeds[i]=seed/4294967296;}
    this.geometry.setAttribute('position',new THREE.BufferAttribute(this.positions,3).setUsage(THREE.DynamicDrawUsage));
    this.rain=new THREE.LineSegments(this.geometry,new THREE.LineBasicMaterial({color:0xbacdda,transparent:true,opacity:.35,depthWrite:false}));
    const canvas=document.createElement('canvas');canvas.width=canvas.height=32;const c=canvas.getContext('2d')!;
    const gradient=c.createRadialGradient(16,16,2,16,16,15);gradient.addColorStop(0,'white');gradient.addColorStop(1,'rgba(255,255,255,0)');c.fillStyle=gradient;c.fillRect(0,0,32,32);
    this.snow=new THREE.Points(this.geometry,new THREE.PointsMaterial({map:new THREE.CanvasTexture(canvas),size:.18,transparent:true,opacity:.9,depthWrite:false,toneMapped:false}));
    this.rain.frustumCulled=this.snow.frustumCulled=false;
    this.group.add(this.rain,this.snow);this.group.visible=false;
  }
  update(dt:number,camera:THREE.Camera,density:number,reducedMotion:boolean,indoors:boolean){
    const rain=this.preset==='rain',snow=this.preset==='snow';
    this.group.visible=!indoors&&(rain||snow);if(!this.group.visible)return;
    this.rain.visible=rain;this.snow.visible=snow;this.time+=dt;
    const count=Math.round(900*density*(reducedMotion?.5:1));
    // A camera-centered world-space volume prevents rain following camera rotation.
    this.group.position.copy(camera.position);
    const t=this.time,vertices=rain?2:1,span=rain?64:44,height=rain?32:24;
    for(let i=0;i<count;i++){
      const s=i*3,j=i*vertices*3;
      let x=((this.seeds[s]*span+t*(rain?2:.7)-camera.position.x)%span+span)%span-span/2;
      let z=((this.seeds[s+2]*span-camera.position.z)%span+span)%span-span/2;
      if(x*x+z*z<16){x+=x<0?-4:4;z+=z<0?-4:4;}
      const y=((this.seeds[s+1]*height-t*(rain?28:2.8)-camera.position.y)%height+height)%height-(rain?12:6);
      this.positions[j]=x+(snow?Math.sin(t+i)*.3:0);this.positions[j+1]=y;this.positions[j+2]=z;
      if(rain){this.positions[j+3]=x-.055;this.positions[j+4]=y+.85;this.positions[j+5]=z;}
    }
    this.geometry.setDrawRange(0,count*vertices);this.geometry.getAttribute('position').needsUpdate=true;
  }
}
