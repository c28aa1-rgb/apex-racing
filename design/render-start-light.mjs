import {chromium} from '@playwright/test';
import {createCanvas,GlobalFonts,loadImage} from '@napi-rs/canvas';
import {writeFile} from 'node:fs/promises';
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
  const page=await browser.newPage({viewport:{width:1600,height:900}});
  await page.goto('http://127.0.0.1:5173/');
  await page.waitForFunction(()=>window.__apex?.state.modelReady);
  await page.evaluate(async()=>{
    const THREE=await import('/node_modules/.vite/deps/three.js'),{StartLight}=await import('/src/race-effects.ts');
    const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true,alpha:true});renderer.setSize(1600,900);renderer.setPixelRatio(1);renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.6;
    const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(37,1600/900,.1,100);camera.position.set(3.4,3,10);camera.lookAt(0,0,0);
    const drone=new StartLight();drone.update(camera,1,0,0,true);drone.position.set(0,0,0);drone.quaternion.identity();scene.add(drone);
    scene.add(new THREE.HemisphereLight(0xd8f4ff,0x265466,3));const key=new THREE.DirectionalLight(0xffe5c6,6);key.position.set(-5,8,6);scene.add(key);const rim=new THREE.DirectionalLight(0xa8dadc,7);rim.position.set(6,3,-5);scene.add(rim);
    renderer.render(scene,camera);renderer.domElement.id='drone-art';renderer.domElement.style.cssText='position:fixed;inset:0;z-index:999;background:transparent';document.body.append(renderer.domElement);document.querySelector('#app').style.display='none';document.querySelector('#world').style.display='none';document.body.style.background='transparent';
  });
  const png=await page.locator('#drone-art').screenshot({omitBackground:true});
  const fonts='/Users/c28aa1/.codex/skills/canvas-design/canvas-fonts';GlobalFonts.registerFromPath(`${fonts}/BigShoulders-Bold.ttf`,'Shoulders');GlobalFonts.registerFromPath(`${fonts}/InstrumentSans-Regular.ttf`,'Instrument');
  const canvas=createCanvas(1800,1300),c=canvas.getContext('2d');c.fillStyle='#132b3b';c.fillRect(0,0,1800,1300);
  c.strokeStyle='#315362';c.lineWidth=1;c.beginPath();c.moveTo(100,230);c.lineTo(1700,230);c.moveTo(100,1110);c.lineTo(1700,1110);c.stroke();
  c.fillStyle='#f1faee';c.font='bold 100px Shoulders';c.fillText('Held energy.',100,175);c.fillStyle='#a8dadc';c.font='22px Instrument';c.textAlign='right';c.fillText('APEX / Marshal drone',1700,153);c.textAlign='left';
  c.drawImage(await loadImage(png),50,260,1700,956);
  for(let i=0;i<5;i++){const x=1270+i*95;c.beginPath();c.arc(x,1180,17,0,Math.PI*2);c.fillStyle=i===4?'#f1faee':'#ff784c';c.fill();}
  c.fillStyle='#a8dadc';c.font='23px Instrument';c.fillText('Five beats. One green light.',100,1185);c.font='16px Instrument';c.fillStyle='#83a4b1';c.fillText('Recessed optics / ducted rotors / machined shell',100,1225);
  await writeFile('design/start-light.png',canvas.toBuffer('image/png'));
}finally{await browser.close();}
