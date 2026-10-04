import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { writeFileSync, mkdirSync } from 'node:fs';
import { TRACKS } from '../shared/tracks';

GlobalFonts.registerFromPath('public/fonts/BigShoulders-Bold.ttf','Shoulders');
GlobalFonts.registerFromPath('public/fonts/InstrumentSans-Regular.ttf','Instrument');
mkdirSync('public/art',{recursive:true});
type P={x:number;y:number;z:number};
// Prefer the lap you drove in /dev (the real circuit shape) over the hand-authored timing route.
// Start the API (npm run dev) first; without it the diagrams fall back to the built-in routes.
let recorded:Record<string,P[]>={};
try{recorded=(await (await fetch('http://127.0.0.1:3001/api/dev-circuit-config',{signal:AbortSignal.timeout(4000)})).json()).maps??{};console.log('Using recorded routes for',Object.keys(recorded).join(', ')||'no circuits');}
catch{console.log('API not running; using built-in routes for every circuit.');}
/** Smoothed, evenly spaced outline of a circuit. */
function outline(track:typeof TRACKS[number]):P[]{
  const raw=recorded[track.id]?.length>20?recorded[track.id]:[track.segments[0].start,...track.segments.map(s=>s.end)];
  const smooth=raw.map((_,i)=>{const a=Math.max(0,i-3),b=Math.min(raw.length-1,i+3);let x=0,y=0,z=0;for(let j=a;j<=b;j++){x+=raw[j].x;y+=raw[j].y;z+=raw[j].z;}const n=b-a+1;return {x:x/n,y:y/n,z:z/n};});
  const bounds=Math.max(...smooth.map(p=>p.x))-Math.min(...smooth.map(p=>p.x)),step=Math.max(bounds,Math.max(...smooth.map(p=>p.z))-Math.min(...smooth.map(p=>p.z)))/110,out=[raw[0]];
  for(const p of smooth){const l=out.at(-1)!;if(Math.hypot(p.x-l.x,p.z-l.z)>=step)out.push(p);}
  out.push(raw.at(-1)!);
  // A lap recorded from the grid to the line stops just short of its start; close it for the diagram.
  const end=out.at(-1)!,gap=Math.hypot(end.x-out[0].x,end.z-out[0].z);
  (out as P[]&{finish?:P}).finish=end;
  if(gap>step&&gap<bounds*.2)out.push({...out[0]});
  return out;
}
for(const track of TRACKS){
  const canvas=createCanvas(720,420),ctx=canvas.getContext('2d');
  ctx.fillStyle='#346879';ctx.fillRect(0,0,720,420);
  // A measured field of lines gives the course the character of a racing diagram.
  ctx.strokeStyle='#6194a0';ctx.globalAlpha=.18;ctx.lineWidth=1;
  for(let x=-400;x<1000;x+=32){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x+380,420);ctx.stroke();}
  for(let y=0;y<500;y+=32){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(720,y-85);ctx.stroke();}ctx.globalAlpha=1;
  const points=outline(track);
  const xs=points.map(p=>p.x),zs=points.map(p=>p.z),minX=Math.min(...xs),maxX=Math.max(...xs),minZ=Math.min(...zs),maxZ=Math.max(...zs);
  const scale=Math.min(390/(maxX-minX||1),285/(maxZ-minZ||1));
  const project=(p:typeof points[number])=>({x:340+(p.x-(minX+maxX)/2)*scale+(p.z-(minZ+maxZ)/2)*scale*.24,y:185-(p.z-(minZ+maxZ)/2)*scale*.78-p.y*.6});
  const path=()=>{ctx.beginPath();points.forEach((p,i)=>{const c=project(p);if(i)ctx.lineTo(c.x,c.y);else ctx.moveTo(c.x,c.y);});};
  ctx.lineJoin='round';ctx.lineCap='butt';ctx.save();ctx.translate(0,10);path();ctx.lineWidth=36;ctx.strokeStyle='#173e50';ctx.stroke();ctx.restore();
  path();ctx.strokeStyle='#e5e8d8';ctx.lineWidth=33;ctx.stroke();path();ctx.strokeStyle='#345769';ctx.lineWidth=23;ctx.stroke();
  ctx.setLineDash([5,7]);path();ctx.strokeStyle='#cfede6';ctx.lineWidth=1.5;ctx.stroke();ctx.setLineDash([]);
  const start=project(points[0]),finish=project((points as P[]&{finish?:P}).finish??points.at(-1)!);
  for(const [point,color] of [[start,'#f1faee'],[finish,track.accent]] as const){ctx.fillStyle=color;ctx.beginPath();ctx.arc(point.x,point.y,6,0,Math.PI*2);ctx.fill();}
  ctx.fillStyle='#a8dadc';ctx.font='14px Instrument';ctx.fillText(`${track.length} m`,615,36);
  writeFileSync(`public/art/${track.id}.png`,canvas.toBuffer('image/png'));
}
// Single-page canvas-design artwork, also used as the visual specification for the in-game track cards.
const poster=createCanvas(1600,1000),ctx=poster.getContext('2d');
ctx.fillStyle='#132b3b';ctx.fillRect(0,0,1600,1000);
ctx.fillStyle='#f1faee';ctx.font='bold 122px Shoulders';ctx.fillText('APEX',78,155);
ctx.fillStyle='#ff784c';ctx.font='bold 122px Shoulders';ctx.fillText('/',286,155);
ctx.fillStyle='#a8dadc';ctx.font='20px Instrument';ctx.fillText('THE COASTAL COLLECTION',80,207);
ctx.textAlign='right';ctx.fillText('PRECISION / TIME / REPETITION',1520,145);ctx.textAlign='left';
for(const [index,track] of TRACKS.entries()){
  const offset=80+index*510;ctx.strokeStyle='#a8dadc40';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(offset,265);ctx.lineTo(offset+440,265);ctx.stroke();
  ctx.fillStyle=track.accent;ctx.font='bold 52px Shoulders';ctx.fillText(String(index+1).padStart(2,'0'),offset,337);
  const pts=outline(track);
  const xs=pts.map(p=>p.x),zs=pts.map(p=>p.z),minX=Math.min(...xs),maxX=Math.max(...xs),minZ=Math.min(...zs),maxZ=Math.max(...zs),scale=330/Math.max(maxX-minX,maxZ-minZ);
  const path=()=>{ctx.beginPath();pts.forEach((p,i)=>{const x=offset+40+(p.x-minX)*scale,y=745-(p.z-minZ)*scale;i?ctx.lineTo(x,y):ctx.moveTo(x,y);});};
  path();ctx.strokeStyle='#a8dadc25';ctx.lineJoin='round';ctx.lineWidth=34;ctx.stroke();path();ctx.lineWidth=4;ctx.strokeStyle=track.accent;ctx.stroke();
  ctx.fillStyle='#f1faee';ctx.font='bold 54px Shoulders';ctx.fillText(track.name,offset,857);
  ctx.fillStyle='#a8dadc';ctx.font='18px Instrument';ctx.fillText(`${track.difficulty}  /  ${track.length} m`,offset,891);
}
writeFileSync('design/coastal-circuit.png',poster.toBuffer('image/png'));
console.log('Rendered three track cards and the Coastal Circuit art sheet.');
