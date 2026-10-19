import * as THREE from 'three';
import type { CarDefinition, CarId } from '../shared/cars';
import type { Simulation } from '../shared/physics';
import { TRANSMISSIONS } from '../shared/transmission';
import { buildFormulaCockpit, type FormulaCockpit } from './formula-cockpit';

type Mount={p:[number,number,number];size:[number,number];tilt:number;yaw?:number;wheel?:boolean};
// Measured against the instrument faces in the normalized, metre-scale GLBs.
const screens:Partial<Record<CarId,Mount>>={
  'ferrari-488-gt3':{p:[.334,-.151,.680],size:[.116,.087],tilt:.157},
  'mclaren-720s-gt3':{p:[.277,-.202,.670],size:[.150,.087],tilt:.007},
  'bugatti-bolide':{p:[.400,-.240,.577],size:[.164,.105],tilt:.067,yaw:-.091},
  'peugeot-9x8':{p:[.1534,-.2827,.5773],size:[.105,.066],tilt:.078,wheel:true},
  'porsche-963':{p:[.1656,-.255,.6409],size:[.106,.066],tilt:.015,wheel:true},
  'mazda-787b':{p:[-.1603,-.3121,.8585],size:[.133,.078],tilt:.222},
};
type Dial={p:[number,number,number];radius:number;tilt:number;kind:'rpm'|'speed'|'throttle'|'brake'|'gear'};
const dials:Partial<Record<CarId,Dial[]>>={
  'porsche-911-gt3':[
    {p:[.335,-.077,.471],radius:.052,tilt:.31,kind:'rpm'},
    {p:[.434,-.101,.478],radius:.045,tilt:.31,kind:'speed'},
    {p:[.236,-.101,.478],radius:.045,tilt:.31,kind:'gear'},
    {p:[.492,-.130,.446],radius:.030,tilt:.27,kind:'throttle'},
    {p:[.181,-.130,.447],radius:.030,tilt:.27,kind:'brake'},
  ],
  'skyline-r34':[
    {p:[-.288,-.058,.545],radius:.056,tilt:.333,kind:'rpm'},
    {p:[-.415,-.058,.545],radius:.056,tilt:.333,kind:'speed'},
  ],
  'celica-gt4':[{p:[.2934,-.0076,.5177],radius:.043,tilt:.357,kind:'rpm'}],
  'nascar-camry':[{p:[.3911,.0721,.3707],radius:.047,tilt:.165,kind:'rpm'}],
};

/** One small texture per cockpit, refreshed at 15 Hz only while visible. */
export class CockpitInstruments {
  private canvas=document.createElement('canvas');
  private context:CanvasRenderingContext2D;
  private texture:THREE.CanvasTexture;
  private material:THREE.MeshBasicMaterial;
  private ownedGeometries:THREE.BufferGeometry[]=[];
  private ownedMaterials:THREE.Material[]=[];
  private ownedTextures:THREE.Texture[]=[];
  private elapsed=1;
  private signature='';
  readonly surfaces:THREE.Mesh[]=[];
  /** RB19 only: the procedural wheel, driver and tub (src/formula-cockpit.ts). */
  private formula?:FormulaCockpit;
  /** Re-aims parts that follow the steering wheel; call every frame after the wheel turns. */
  pose(){this.formula?.pose();}
  constructor(root:THREE.Object3D,private definition:CarDefinition){
    const analog=dials[definition.id];
    this.canvas.width=analog?1024:512;this.canvas.height=analog?512:384;
    this.context=this.canvas.getContext('2d')!;
    this.texture=new THREE.CanvasTexture(this.canvas);this.texture.colorSpace=THREE.SRGBColorSpace;
    this.texture.generateMipmaps=false;this.texture.minFilter=THREE.LinearFilter;
    this.material=new THREE.MeshBasicMaterial({map:this.texture,toneMapped:false});
    this.ownedTextures.push(this.texture);this.ownedMaterials.push(this.material);
    const wheel=root.getObjectByName('apex-steering-wheel');
    if(definition.id==='red-bull-rb19'&&wheel){
      this.formula=buildFormulaCockpit(root,wheel,{geometries:this.ownedGeometries,materials:this.ownedMaterials,textures:this.ownedTextures});
      this.mount(wheel,{p:[0,.043,-.0265],size:[.104,.070],tilt:0},false);
    }else if(analog){
      analog.forEach((dial,i)=>{
        const geometry=new THREE.CircleGeometry(dial.radius,48),uv=geometry.getAttribute('uv');
        for(let j=0;j<uv.count;j++)uv.setXY(j,(i%4+uv.getX(j))/4,1-(Math.floor(i/4)+1-uv.getY(j))/2);
        const mesh=this.addSurface(root,geometry);mesh.position.fromArray(dial.p);mesh.rotation.set(dial.tilt,Math.PI,0);
      });
    }else{
      const screen=screens[definition.id];if(screen)this.mount(screen.wheel&&wheel?wheel:root,screen,!!screen.wheel);
    }
    this.paint(0,TRANSMISSIONS[definition.id].idle,1,0,0,0);
  }
  private addSurface(parent:THREE.Object3D,geometry:THREE.BufferGeometry){
    const mesh=new THREE.Mesh(geometry,this.material);mesh.name='apex-live-instruments';
    this.ownedGeometries.push(geometry);this.surfaces.push(mesh);parent.add(mesh);return mesh;
  }
  private mount(parent:THREE.Object3D,mount:Mount,relative:boolean){
    const mesh=this.addSurface(parent,new THREE.PlaneGeometry(...mount.size));
    mesh.position.fromArray(mount.p);if(relative)mesh.position.sub(parent.position);
    mesh.rotation.set(mount.tilt,Math.PI+(mount.yaw??0),0);
  }
  /** RB19: show the driver's body from the cockpit, and the helmet too from the T-cam behind it. */
  setDriverView(view:'cockpit'|'tcam'|'none'){this.formula?.setDriverVisible(view!=='none',view==='tcam');}
  update(sim:Simulation,dt:number,visible:boolean){
    if(!visible){this.elapsed=1;return;}
    this.elapsed+=dt;if(this.elapsed<1/15)return;this.elapsed=0;
    const speed=Math.round(sim.speed*sim.track.metersPerUnit*2.23694),rpm=Math.round(sim.engine.rpm/50)*50;
    const gear=sim.reverse>.1?-1:sim.gear,throttle=Math.round(sim.throttle*100),brake=Math.round(sim.brake*100),time=Math.floor(sim.timeMs/100);
    const signature=`${speed}:${rpm}:${gear}:${throttle}:${brake}:${time}`;
    if(signature===this.signature)return;this.signature=signature;
    this.paint(speed,rpm,gear,throttle,brake,time/10);
  }
  private paint(speed:number,rpm:number,gear:number,throttle:number,brake:number,time:number){
    const c=this.context,analog=dials[this.definition.id],redline=TRANSMISSIONS[this.definition.id].redline;
    c.fillStyle='#080d10';c.fillRect(0,0,this.canvas.width,this.canvas.height);
    if(analog){
      analog.forEach((dial,i)=>{
        c.save();c.translate(i%4*256,Math.floor(i/4)*256);
        const value=dial.kind==='rpm'?rpm:dial.kind==='speed'?speed:dial.kind==='throttle'?throttle:dial.kind==='brake'?brake:gear;
        const max=dial.kind==='rpm'?Math.ceil(redline/1000)*1000:dial.kind==='speed'?Math.ceil(this.definition.physics.topSpeedKph*.621371/20)*20:100;
        this.paintDial(dial.kind,value,max);c.restore();
      });
    }else{
      const fraction=Math.min(1,rpm/redline);
      if(this.formula)this.formula.paintLeds(fraction);
      else for(let i=0;i<15;i++){c.fillStyle=i/15<fraction?(i<8?'#58ee9c':i<12?'#f9ce4b':'#fd5364'):'#203039';c.fillRect(12+i*33,12,26,17);}
      c.fillStyle='#a6b7c1';c.font='600 17px monospace';c.textAlign='left';c.fillText(this.definition.shortName.toUpperCase(),16,60);
      c.fillStyle='#edf8f4';c.font='bold 152px monospace';c.textAlign='center';c.fillText(gear<0?'R':String(gear),256,213);
      c.font='bold 39px monospace';c.fillText(String(speed).padStart(3,'0'),81,156);c.fillText(String(Math.round(rpm)),425,156);
      c.font='17px monospace';c.fillStyle='#a6b7c1';c.fillText('MPH',81,184);c.fillText('RPM',425,184);
      c.fillStyle='#283b43';c.fillRect(16,236,480,2);c.textAlign='left';c.font='18px monospace';c.fillStyle='#a6b7c1';c.fillText('LAP TIME',18,270);
      c.fillStyle='#63e6c3';c.font='bold 38px monospace';c.fillText(`${Math.floor(time/60)}:${(time%60).toFixed(1).padStart(4,'0')}`,18,312);
      c.font='17px monospace';c.fillStyle='#a6b7c1';c.fillText('THR',270,276);c.fillText('BRK',270,312);
      c.fillStyle='#203039';c.fillRect(314,260,180,18);c.fillRect(314,296,180,18);
      c.fillStyle='#58ee9c';c.fillRect(314,260,1.8*throttle,18);c.fillStyle='#fd5364';c.fillRect(314,296,1.8*brake,18);
      c.fillStyle=fraction>.94?'#fd5364':'#526a77';c.font='bold 18px monospace';c.textAlign='center';c.fillText(fraction>.94?'SHIFT':this.definition.discipline.split(' · ')[0].toUpperCase(),256,361);
    }
    this.texture.needsUpdate=true;
  }
  private paintDial(kind:Dial['kind'],value:number,max:number){
    const c=this.context;
    c.fillStyle='#101619';c.beginPath();c.arc(128,128,126,0,Math.PI*2);c.fill();
    c.strokeStyle='#63717a';c.lineWidth=4;c.stroke();
    c.textAlign='center';c.textBaseline='middle';
    if(kind==='gear'){
      c.fillStyle='#a8b6bd';c.font='19px sans-serif';c.fillText('GEAR',128,58);c.fillStyle='#e9f6ee';c.font='bold 100px monospace';c.fillText(value<0?'R':String(value),128,140);return;
    }
    const ticks=(kind==='rpm'?max/1000:10)*4;
    for(let i=0;i<=ticks;i++){
      const angle=(135+i/ticks*270)*Math.PI/180,major=i%4===0;
      c.strokeStyle=kind==='rpm'&&i/ticks>.8?'#ff5362':'#dce5e7';c.lineWidth=major?3:1.5;
      c.beginPath();c.moveTo(128+Math.cos(angle)*(major?89:99),128+Math.sin(angle)*(major?89:99));c.lineTo(128+Math.cos(angle)*112,128+Math.sin(angle)*112);c.stroke();
      if(major){c.font='bold 17px sans-serif';c.fillStyle=c.strokeStyle;c.fillText(String(Math.round(max*i/ticks/(kind==='rpm'?1000:1))),128+Math.cos(angle)*73,128+Math.sin(angle)*73);}
    }
    c.fillStyle='#aabac2';c.font='15px sans-serif';c.fillText({rpm:'RPM x1000',speed:'MPH',throttle:'THROTTLE %',brake:'BRAKE %'}[kind],128,163);
    c.fillStyle='#e5f4ef';c.font='bold 22px monospace';c.fillText(String(Math.round(value)),128,196);
    const angle=(135+Math.min(1,value/max)*270)*Math.PI/180;
    c.save();c.translate(128,128);c.rotate(angle);c.fillStyle='#ff543e';c.beginPath();c.moveTo(-20,-3);c.lineTo(104,0);c.lineTo(-20,3);c.closePath();c.fill();c.restore();
    c.fillStyle='#76868d';c.beginPath();c.arc(128,128,8,0,Math.PI*2);c.fill();
  }
  dispose(){this.ownedGeometries.forEach(g=>g.dispose());this.ownedMaterials.forEach(m=>m.dispose());this.ownedTextures.forEach(t=>t.dispose());}
}
