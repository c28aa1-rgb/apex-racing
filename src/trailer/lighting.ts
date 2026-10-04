import * as THREE from 'three';
import type { Sky } from 'three/addons/objects/Sky.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import type { RaceWorld } from '../world';
import type { CarDefinition } from '../../shared/cars';

/** Poly Haven "Modern Buildings Night" (CC0), kept out of public/ so the game build stays small. */
const NIGHT_HDRI='/work/trailer-assets/hdri/modern_buildings_night_2k.hdr';
/** Floodlight grid: spacing, rows/columns around the subject, mast height. */
const FLOOD_STEP=26,FLOOD_GRID=5,FLOOD_HEIGHT=15;

export function addHeadlights(root:THREE.Group,car:CarDefinition) {
  const group=new THREE.Group();group.name='trailer-headlights';
  const {bodyWidthM,lengthM,wheelRadiusM}=car.dimensions;
  for(const side of [-1,1]) {
    // Soft, wide beams: on a floodlit circuit the headlight pool is a faint
    // wash in front of the car, not a hard disc further down the road.
    const lamp=new THREE.SpotLight(0xeaf4ff,22,40,.55,1,2);
    lamp.position.set(side*bodyWidthM*.35,-.58-wheelRadiusM+.65,lengthM*.46);
    lamp.target.position.set(side*bodyWidthM*.35,-1.2,22);
    group.add(lamp,lamp.target);
  }
  root.add(group);return group;
}

export class TrailerLighting {
  direction=new THREE.Vector3();
  /** Night tuning, exposed so takes and the stills tool can adjust it. */
  night={flood:260,env:.08,ambient:.05,road:1,roadEnv:0,tone:.55};
  private moon=new THREE.Mesh(new THREE.SphereGeometry(14,24,16),new THREE.MeshBasicMaterial({color:0xdce8f2,fog:false}));
  private moonLight=new THREE.DirectionalLight(0xb2caff,.5);
  private sun:THREE.DirectionalLight;
  private ambient:THREE.HemisphereLight;
  private dayEnv:THREE.Texture|null;
  private nightEnv?:THREE.Texture;
  private loading?:Promise<void>;
  private floods:THREE.SpotLight[]=[];
  private glossy=new Map<THREE.MeshStandardMaterial,{rough:number;env:number;color:THREE.Color}>();
  constructor(private world:RaceWorld) {
    this.sun=world.scene.children.find(o=>o instanceof THREE.DirectionalLight) as THREE.DirectionalLight;
    this.ambient=world.scene.children.find(o=>o instanceof THREE.HemisphereLight) as THREE.HemisphereLight;
    this.dayEnv=world.scene.environment;
    this.moonLight.castShadow=true;
    Object.assign(this.moonLight.shadow.camera,{left:-14,right:14,top:14,bottom:-14,near:1,far:80});
    this.moonLight.shadow.mapSize.set(1024,1024);this.moonLight.shadow.normalBias=.025;
    world.scene.add(this.moon,this.moonLight,this.moonLight.target);
    for(let i=0;i<FLOOD_GRID*FLOOD_GRID;i++){
      // Metal-halide white, wide cones with soft edges, like circuit light masts.
      const lamp=new THREE.SpotLight(0xfff3e2,0,FLOOD_HEIGHT*3.2,1.05,.85,2);
      lamp.visible=false;world.scene.add(lamp,lamp.target);this.floods.push(lamp);
    }
    this.ready();
  }
  /** Resolves when the night environment map is loaded (renders wait for it). */
  ready(){
    this.loading??=new HDRLoader().loadAsync(NIGHT_HDRI).then(texture=>{
      const pmrem=new THREE.PMREMGenerator(this.world.renderer);
      this.nightEnv=pmrem.fromEquirectangular(texture).texture;pmrem.dispose();texture.dispose();
    }).catch(error=>console.error('[still] night HDRI failed',error));
    return this.loading;
  }
  /** The venue materials under the cars (the road), retuned for night shots. */
  glossRoad(materials:Iterable<THREE.Material>){
    for(const m of materials)if(m instanceof THREE.MeshStandardMaterial&&!this.glossy.has(m))this.glossy.set(m,{rough:m.roughness,env:m.envMapIntensity,color:m.color.clone()});
  }
  get roadTuned(){return this.glossy.size>0;}
  update(hour:number,exposure:number,center?:THREE.Vector3) {
    const angle=(hour-6)/24*Math.PI*2;
    const altitude=Math.sin(angle),day=THREE.MathUtils.smoothstep(altitude,-.12,.25),night=1-day;
    this.direction.set(Math.cos(angle),altitude,.3).normalize();
    const sky=this.world.scene.getObjectByName('apex-sky') as Sky;
    sky.visible=altitude>-.08;
    sky.material.uniforms.sunPosition.value.copy(this.direction);
    sky.material.uniforms.turbidity.value=5;
    const sunset=1-THREE.MathUtils.smoothstep(Math.abs(altitude),0,.5);
    this.sun.color.set(0xfff2dc).lerp(new THREE.Color(0xff9760),sunset);
    this.sun.intensity=day*(1.2+Math.max(0,altitude)*1.6);
    this.ambient.color.set(0x8fa3c8).lerp(new THREE.Color(0xe3efff),day);
    this.ambient.groundColor.set(0x1a1712).lerp(new THREE.Color(0x62665b),day);
    this.ambient.intensity=THREE.MathUtils.lerp(this.night.ambient,1.15,day);
    const color=new THREE.Color(0x070b14).lerp(new THREE.Color(0xc4e1eb),day);
    (this.world.scene.background as THREE.Color).copy(color);
    (this.world.scene.fog as THREE.Fog).color.copy(color);
    const nightEnv=night>.5&&this.nightEnv;
    this.world.scene.environment=nightEnv?this.nightEnv!:this.dayEnv;
    this.world.scene.environmentIntensity=nightEnv?this.night.env:.14+day*.31;
    // Dark, matte asphalt under the lamps: no mirror streaks or highlight blobs on the road.
    for(const [m,o] of this.glossy){
      m.roughness=nightEnv?this.night.road:o.rough;
      m.envMapIntensity=nightEnv?this.night.roadEnv:o.env;
      m.color.copy(o.color).multiplyScalar(nightEnv?this.night.tone:1);
    }
    this.world.renderer.toneMappingExposure=exposure;
    this.moon.position.copy(this.world.camera.position).addScaledVector(this.direction,-2200);
    this.moon.visible=altitude<.08;
    this.moonLight.position.copy(this.world.car.position).addScaledVector(this.direction,-35);
    this.moonLight.target.position.copy(this.world.car.position);
    this.moonLight.intensity=(1-day)*.2;
    this.placeFloods(center??this.world.car.position,night);
    return day;
  }
  /**
   * Floodlight masts on a world-fixed grid around the subject. Lamps fade by
   * distance, so the grid can follow the cars without any light popping.
   */
  private placeFloods(center:THREE.Vector3,night:number){
    const on=night>.3,half=(FLOOD_GRID-1)/2,reach=FLOOD_STEP*(half+.5);
    const cx=Math.round(center.x/FLOOD_STEP),cz=Math.round(center.z/FLOOD_STEP);
    this.floods.forEach((lamp,i)=>{
      const gx=cx+(i%FLOOD_GRID)-half,gz=cz+Math.floor(i/FLOOD_GRID)-half;
      // Stagger alternate rows so pools do not line up into a checkerboard.
      const x=(gx+(gz&1?.5:0))*FLOOD_STEP,z=gz*FLOOD_STEP;
      const d=Math.hypot(x-center.x,z-center.z),fade=1-THREE.MathUtils.smoothstep(d,reach*.55,reach);
      // Light count stays fixed while on, so faded lamps never force a shader rebuild.
      lamp.visible=on;
      lamp.intensity=this.night.flood*night*fade;
      lamp.position.set(x,center.y+FLOOD_HEIGHT,z);
      lamp.target.position.set(x,center.y,z);lamp.target.updateMatrixWorld();
    });
  }
}
