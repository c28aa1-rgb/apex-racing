import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { CarDefinition, CarId } from '../shared/cars';
import type { Simulation } from '../shared/physics';
import { TRANSMISSIONS } from '../shared/transmission';

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
      this.buildFormulaWheel(wheel);
      this.mount(wheel,{p:[0,.022,-.027],size:[.110,.069],tilt:0},false);
      wheel.scale.set(.90,.86,1);
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
      for(let i=0;i<15;i++){c.fillStyle=i/15<fraction?(i<8?'#58ee9c':i<12?'#f9ce4b':'#fd5364'):'#203039';c.fillRect(12+i*33,12,26,17);}
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
  private buildFormulaWheel(wheel:THREE.Object3D){
    wheel.clear();wheel.userData.steeringRatio=4;
    const hard:THREE.BufferGeometry[]=[],rubber:THREE.BufferGeometry[]=[];
    const add=(geometry:THREE.BufferGeometry,color:number,x=0,y=0,z=0,list=hard)=>{
      geometry.translate(x,y,z);const count=geometry.getAttribute('position').count,colors=new Float32Array(count*3),c=new THREE.Color(color);
      for(let i=0;i<count;i++)c.toArray(colors,i*3);geometry.setAttribute('color',new THREE.BufferAttribute(colors,3));list.push(geometry);
    };
    const outline=new THREE.Shape();outline.moveTo(-.060,.063);outline.lineTo(.060,.063);outline.lineTo(.070,.046);outline.lineTo(.112,.050);outline.quadraticCurveTo(.126,.039,.112,.017);outline.lineTo(.090,-.006);outline.lineTo(.079,-.057);outline.quadraticCurveTo(.074,-.068,.055,-.068);outline.lineTo(-.055,-.068);outline.quadraticCurveTo(-.074,-.068,-.079,-.057);outline.lineTo(-.090,-.006);outline.lineTo(-.112,.017);outline.quadraticCurveTo(-.126,.039,-.112,.050);outline.lineTo(-.070,.046);outline.closePath();
    const plate=new THREE.ExtrudeGeometry(outline,{depth:.014,bevelEnabled:true,bevelThickness:.002,bevelSize:.002,bevelSegments:2,steps:1,curveSegments:8});plate.translate(0,0,-.018);
    const weave=document.createElement('canvas');weave.width=weave.height=64;const wc=weave.getContext('2d')!;
    for(let y=0;y<64;y+=8)for(let x=0;x<64;x+=8){wc.fillStyle=(x+y)%16?'#202326':'#171a1c';wc.fillRect(x,y,8,8);wc.fillStyle='#292c2e';wc.fillRect(x,y,(x+y)%16?2:7,(x+y)%16?7:2);}
    const weaveTexture=new THREE.CanvasTexture(weave);weaveTexture.colorSpace=THREE.SRGBColorSpace;weaveTexture.wrapS=weaveTexture.wrapT=THREE.RepeatWrapping;weaveTexture.repeat.set(70,70);weaveTexture.anisotropy=4;
    const plateMaterial=new THREE.MeshPhysicalMaterial({map:weaveTexture,roughness:.38,metalness:.02,clearcoat:.32,clearcoatRoughness:.28});
    const plateMesh=new THREE.Mesh(plate,plateMaterial);plateMesh.name='apex-formula-carbon';wheel.add(plateMesh);
    this.ownedGeometries.push(plate);this.ownedMaterials.push(plateMaterial);this.ownedTextures.push(weaveTexture);
    for(const side of [-1,1]){
      const curve=new THREE.CatmullRomCurve3([new THREE.Vector3(side*.109,.048,-.005),new THREE.Vector3(side*.139,.040,-.014),new THREE.Vector3(side*.143,.005,-.024),new THREE.Vector3(side*.132,-.044,-.019),new THREE.Vector3(side*.080,-.052,-.003)]);
      const grip=new THREE.TubeGeometry(curve,36,.014,12,false);grip.scale(1,1,1.25);add(grip,0x121517,0,0,0,rubber);
      const thumb=new THREE.SphereGeometry(1,12,8);thumb.scale(.014,.021,.010);add(thumb,0x121517,side*.121,.017,-.032,rubber);
      const paddle=new THREE.BoxGeometry(.025,.066,.003);paddle.rotateZ(side*-.16);add(paddle,0x24292c,side*.119,-.003,.025);
      add(new THREE.BoxGeometry(.024,.014,.003),0x262b2e,side*.093,-.057,.032);
      for(let i=0;i<3;i++){
        const collar=new THREE.CylinderGeometry(.0075,.008,.003,16);collar.rotateX(Math.PI/2);add(collar,0x656b6d,side*(.098-i*.012),.036-i*.028,-.023);
        const button=new THREE.CylinderGeometry(.005,.0055,.004,16);button.rotateX(Math.PI/2);
        add(button,[0xb82036,0x246f9c,0xba9a30][i],side*(.098-i*.012),.036-i*.028,-.026);
      }
      const ring=new THREE.CylinderGeometry(.011,.011,.003,24);ring.rotateX(Math.PI/2);add(ring,side<0?0x305789:0x947e2f,side*.041,-.045,-.023);
      const dial=new THREE.CylinderGeometry(.008,.009,.007,12);dial.rotateX(Math.PI/2);add(dial,0x171b1d,side*.041,-.045,-.028);
      add(new THREE.BoxGeometry(.002,.008,.001),0xdcded9,side*.041,-.042,-.032);
      for(const y of [-.058,.041]){const screw=new THREE.CylinderGeometry(.0018,.0018,.001,8);screw.rotateX(Math.PI/2);add(screw,0x737c81,side*.066,y,-.022);}
    }
    const centerDial=new THREE.CylinderGeometry(.012,.013,.008,16);centerDial.rotateX(Math.PI/2);add(centerDial,0x1d2226,0,-.036,-.026);
    add(new THREE.BoxGeometry(.002,.008,.001),0xd7d9d2,0,-.032,-.031);
    const grain=document.createElement('canvas');grain.width=grain.height=64;const gc=grain.getContext('2d')!,pixels=gc.createImageData(64,64);let seed=119;
    for(let i=0;i<pixels.data.length;i+=4){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const value=110+(seed>>>27);pixels.data.set([value,value,value,255],i);}gc.putImageData(pixels,0,0);
    const gripTexture=new THREE.CanvasTexture(grain);gripTexture.wrapS=gripTexture.wrapT=THREE.RepeatWrapping;gripTexture.repeat.set(8,2);this.ownedTextures.push(gripTexture);
    for(const [parts,roughness] of [[hard,.36],[rubber,.78]] as const){
      const sources=parts.map(g=>{const next=g.index?g.toNonIndexed():g;if(parts===hard)next.deleteAttribute('uv');return next;}),geometry=mergeGeometries(sources);
      if(geometry){const material=new THREE.MeshStandardMaterial({vertexColors:true,roughness,metalness:parts===hard?.08:0,...(parts===rubber?{bumpMap:gripTexture,bumpScale:.00035}:{})});const mesh=new THREE.Mesh(geometry,material);mesh.name='apex-formula-wheel';wheel.add(mesh);this.ownedGeometries.push(geometry);this.ownedMaterials.push(material);}
      new Set([...parts,...sources]).forEach(g=>g.dispose());
    }
    const labels=document.createElement('canvas');labels.width=1024;labels.height=512;const c=labels.getContext('2d')!;
    c.fillStyle='#b9c6c8';c.textAlign='center';c.font='bold 19px sans-serif';
    for(const [text,x,y] of [['N',68,80],['RADIO',130,191],['PIT',185,295],['DRS',956,80],['DIFF',894,191],['MARK',839,295],['ENTRY',316,476],['MULTI',708,476],['STRAT',512,438]] as const)c.fillText(text,x,y);
    const texture=new THREE.CanvasTexture(labels);texture.colorSpace=THREE.SRGBColorSpace;
    const material=new THREE.MeshBasicMaterial({map:texture,transparent:true,depthWrite:false,toneMapped:false});
    const geometry=new THREE.PlaneGeometry(.215,.135),mesh=new THREE.Mesh(geometry,material);mesh.rotation.y=Math.PI;mesh.position.z=-.024;wheel.add(mesh);
    this.ownedTextures.push(texture);this.ownedMaterials.push(material);this.ownedGeometries.push(geometry);
  }
  dispose(){this.ownedGeometries.forEach(g=>g.dispose());this.ownedMaterials.forEach(m=>m.dispose());this.ownedTextures.forEach(t=>t.dispose());}
}
