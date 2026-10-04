import { useEffect, useReducer, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Play, Pause, RotateCcw, StepForward, EyeOff, Maximize, Download, Upload, RefreshCw, Circle, Square, Car, Trash2, ParkingCircle } from 'lucide-react';
import { TRACKS } from '../../shared/tracks';
import { CARS, type CarId } from '../../shared/cars';
import { CAM_KEYS, orbitOf, setOrbit, TrailerDirector, type CamEase, type CamKey, type CamRig } from './director';
import { SHOTS, type ShotId } from './shots';
import './trailer.css';
import type { WeatherPreset } from '../settings';
import type { CarMotion } from './motion';
import { takeSeconds, validPose, validTake } from './driving';
import { applyCheckpoints, applyFinishPlacement, applyRoadWidthOverrides, applySavedFinishPlacements, applySavedRoadWidthOverrides, applySavedStartPlacements, applyStartPlacement, loadCheckpoints, type CheckpointLayouts } from '../dev-spawns';

const THREE_clamp=(n:number,min:number,max:number)=>Math.min(max,Math.max(min,n));
function TrailerApp({director:d}:{director:TrailerDirector}) {
  const [,refresh]=useReducer(n=>n+1,0),[hidden,setHidden]=useState(false);
  const [importError,setImportError]=useState('');
  const hiddenRef=useRef(false);hiddenRef.current=hidden;
  useEffect(()=>{if(!hidden)return;const show=()=>setHidden(false);window.addEventListener('pointerdown',show);return()=>window.removeEventListener('pointerdown',show);},[hidden]);
  useEffect(()=>{
    // Viewport mouse control for the selected keyframe of a custom camera move.
    // The app layer sits above the canvas, so listen on the window and skip the control panels.
    const canvas=window;
    let drag:{x:number;y:number;button:number}|undefined;
    const onView=(e:Event)=>!(e.target as Element).closest?.('.trailer-panel,.trailer-transport,.trailer-header');
    const active=()=>d.camRig.custom&&!d.cockpit&&!d.driving;
    const down=(e:PointerEvent)=>{if(!active()||!onView(e))return;drag={x:e.clientX,y:e.clientY,button:e.button};d.playing=false;d.seek(d.editKey==='from'?0:d.duration);e.preventDefault();};
    const move=(e:PointerEvent)=>{
      if(!drag)return;const k=d.camRig[d.editKey],fine=e.shiftKey?.15:1,dx=(e.clientX-drag.x)*fine,dy=(e.clientY-drag.y)*fine;drag.x=e.clientX;drag.y=e.clientY;
      if(drag.button===2){k.pan=THREE_clamp(k.pan+dx*.15,-90,90);k.tilt=THREE_clamp(k.tilt-dy*.15,-60,60);}
      else{const o=orbitOf(k);let a=o.angle-dx*.4;a=((a+540)%360)-180;setOrbit(k,a,o.distance);k.height=THREE_clamp(Math.round((k.height+dy*.02)*1000)/1000,-.3,40);}
      d.draw();refresh();
    };
    const up=()=>{drag=undefined;};
    const wheel=(e:WheelEvent)=>{if(!active()||!onView(e))return;e.preventDefault();const k=d.camRig[d.editKey],o=orbitOf(k),step=e.shiftKey?1.01:1.08;setOrbit(k,o.angle,THREE_clamp(o.distance*(e.deltaY>0?step:1/step),.3,80));d.seek(d.editKey==='from'?0:d.duration);refresh();};
    const menu=(e:MouseEvent)=>{if(active()&&onView(e))e.preventDefault();};
    canvas.addEventListener('pointerdown',down);canvas.addEventListener('pointermove',move);canvas.addEventListener('pointerup',up);canvas.addEventListener('pointercancel',up);canvas.addEventListener('wheel',wheel,{passive:false});canvas.addEventListener('contextmenu',menu);
    return()=>{canvas.removeEventListener('pointerdown',down);canvas.removeEventListener('pointermove',move);canvas.removeEventListener('pointerup',up);canvas.removeEventListener('pointercancel',up);canvas.removeEventListener('wheel',wheel);canvas.removeEventListener('contextmenu',menu);};
  },[d]);
  useEffect(()=>{d.onChange=refresh;const key=(event:KeyboardEvent)=>{
    if((event.target as HTMLElement).matches?.('input,select,textarea'))return;
    if(event.key==='Enter'&&d.driving){event.preventDefault();if(d.recording)d.finishTake();else d.record();return;}
    if(event.key==='Escape'&&d.driving&&!hiddenRef.current){d.stopDrive();return;}
    if(event.key==='Escape'||event.key.toLowerCase()==='h')setHidden(v=>!v);
    if(event.code==='Space'){event.preventDefault();if(d.canPlay)d.playing=!d.playing;refresh();}
  };window.addEventListener('keydown',key);return()=>{window.removeEventListener('keydown',key);d.onChange=()=>{};};},[d]);
  const update=(fn:()=>void)=>{fn();d.draw();refresh();};
  const slider=(label:string,value:number,min:number,max:number,step:number,change:(n:number)=>void)=>
    <label className="trailer-slider">{label}<output>{Number(value.toFixed(2))}</output><input aria-label={label} type="range" value={value} min={min} max={max} step={step} onChange={e=>update(()=>change(Number(e.target.value)))}/></label>;
  /** Slider plus a typed number box for exact values; arrow keys in the box step by `step`. */
  const fine=(label:string,value:number,min:number,max:number,step:number,change:(n:number)=>void)=>
    <div className="trailer-fine"><span>{label}</span>
      <input aria-label={label} type="range" value={value} min={min} max={max} step={step} onChange={e=>update(()=>change(Number(e.target.value)))}/>
      <input aria-label={`${label} value`} type="number" value={Number(value.toFixed(3))} min={min} max={max} step={step} onChange={e=>{const n=Number(e.target.value);if(e.target.value!==''&&Number.isFinite(n))update(()=>change(THREE_clamp(n,min,max)));}}/>
    </div>;
  const keyControls=(which:'from'|'to')=>{const k=d.camRig[which],o=orbitOf(k);return <div className="trailer-key">
    {fine('Orbit angle (° 0 front, 180 back)',o.angle,-180,180,.1,n=>setOrbit(k,n,o.distance))}
    {fine('Distance (m)',o.distance,.3,80,.01,n=>setOrbit(k,o.angle,n))}
    {fine('Forward (m)',k.forward,-60,60,.01,n=>k.forward=n)}
    {fine('Right (m)',k.side,-30,30,.01,n=>k.side=n)}
    {fine('Height (m)',k.height,-.3,40,.01,n=>k.height=n)}
    {fine('Lens FOV (°)',k.fov,8,120,.1,n=>k.fov=n)}
    {fine('Pan (°)',k.pan,-90,90,.1,n=>k.pan=n)}
    {fine('Tilt (°)',k.tilt,-60,60,.1,n=>k.tilt=n)}
    {fine('Roll (°)',k.roll,-45,45,.1,n=>k.roll=n)}
  </div>;};
  const save=()=>{
    const {shot,trackId,carId,count,hour,cycle,cycleSeconds,exposure,headlights,fov,cameraHeight,cameraSide,routeOffset,speed,bloom,fogFar,weather,motion,shotDuration,focusCar,framePack,takes,starts,cockpit,camRig}=d;
    const url=URL.createObjectURL(new Blob([JSON.stringify({version:5,shot,trackId,carId,count,hour,cycle,cycleSeconds,exposure,headlights,fov,cameraHeight,cameraSide,routeOffset,speed,bloom,fogFar,weather,motion,shotDuration,focusCar,framePack,takes,starts,cockpit,camRig},null,2)],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download=`apex-${shot}-take.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  const restore=async(file?:File)=>{
    if(!file)return;
    try{
      const take=JSON.parse(await file.text());
      if(![1,2,3,4,5].includes(take.version)||!SHOTS.some(s=>s.id===take.shot)||!TRACKS.some(t=>t.id===take.trackId)||!CARS.some(c=>c.id===take.carId))throw new Error('Invalid take settings.');
      const ranges:Record<string,[number,number]>={count:[1,4],hour:[0,24],cycleSeconds:[10,240],exposure:[.4,2],fov:[25,85],cameraHeight:[-.5,12],cameraSide:[-8,8],routeOffset:[0,20000],speed:[.25,1]};
      for(const [key,[min,max]] of Object.entries(ranges))if(!Number.isFinite(take[key])||take[key]<min||take[key]>max)throw new Error(`Invalid ${key}.`);
      if(!Number.isInteger(take.count)||typeof take.cycle!=='boolean'||typeof take.headlights!=='boolean')throw new Error('Invalid take settings.');
      if(!Number.isFinite(take.bloom)||take.bloom<0||take.bloom>1||!Number.isFinite(take.fogFar)||take.fogFar<150||take.fogFar>6500||!['clear','rain','snow','fog'].includes(take.weather))throw new Error('Invalid atmosphere settings.');
      if(take.version>=2){
        const bounds:Record<string,[number,number]>={speed:[0,180],endSpeed:[0,180],offset:[-200,200],lane:[-4,4],endLane:[-4,4],delay:[0,10]};
        if(!Array.isArray(take.motion)||take.motion.length!==4||take.motion.some((m:CarMotion)=>!m||![1,-1].includes(m.direction)||Object.entries(bounds).some(([key,[min,max]])=>!Number.isFinite(m[key as keyof CarMotion])||m[key as keyof CarMotion]<min||m[key as keyof CarMotion]>max)))throw new Error('Invalid car motion.');
        if(!Number.isFinite(take.shotDuration)||take.shotDuration<2||take.shotDuration>60||!Number.isInteger(take.focusCar)||take.focusCar<0||take.focusCar>=take.count)throw new Error('Invalid motion setup.');
      }
      if(take.version>=4&&(!Array.isArray(take.takes)||take.takes.length!==4||take.takes.some((t:unknown)=>t!==null&&!validTake(t))||!Array.isArray(take.starts)||take.starts.length!==4||take.starts.some((p:unknown)=>p!==null&&!validPose(p))))throw new Error('Invalid driven takes.');
      const rig=take.camRig as CamRig,okKey=(k:CamKey)=>!!k&&CAM_KEYS.every(n=>Number.isFinite(k[n]));
      if(take.version>=5&&(!rig||typeof rig.custom!=='boolean'||!okKey(rig.from)||!okKey(rig.to)||!['linear','in','out','inout'].includes(rig.ease)||!['follow','fixed'].includes(rig.anchor)||![rig.aimForward,rig.aimSide,rig.aimHeight].every(Number.isFinite)))throw new Error('Invalid camera move.');
      // Loading with the take's cars keeps each driven take on the model it was driven with.
      await d.loadRecipe({...take,takes:take.version>=4?take.takes:undefined,starts:take.version>=4?take.starts:undefined,camRig:take.version>=5?{...rig,avoidWalls:rig.avoidWalls===true,path:rig.path==='arc'?'arc':'line'}:undefined});
      if(take.version>=2){d.motion=take.motion;d.shotDuration=take.shotDuration;d.focusCar=take.focusCar;d.framePack=take.framePack===true;}
      if(take.version>=4)d.cockpit=take.cockpit===true;
      d.playing=false;
      d.bloom=take.bloom;d.fogFar=take.fogFar;d.weather=take.weather;d.world.setWeather(d.weather);
      update(()=>{d.hour=take.hour;d.cycle=take.cycle;d.cycleSeconds=take.cycleSeconds;d.exposure=take.exposure;d.headlights=take.headlights;d.fov=take.fov;d.cameraHeight=take.cameraHeight;d.cameraSide=take.cameraSide;d.routeOffset=Math.min(take.routeOffset,d.routeLength-1);d.speed=take.speed;});
      setImportError('');
    }catch(error){setImportError(error instanceof Error?error.message:'Could not load take.');}
  };
  return <main className={`trailer-ui ${hidden?'trailer-hidden':''}`}>
    <header className="trailer-header"><strong>APEX <span>Shot Director</span></strong><a href="/">Exit</a></header>
    <aside className="trailer-panel">
      <label>Shot<select aria-label="Shot" value={d.shot} disabled={!d.ready&&!d.error} onChange={e=>void d.selectShot(e.target.value as ShotId)}>{SHOTS.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <fieldset disabled={!d.ready&&!d.error}><legend>Staging</legend>
        <label>Circuit<select aria-label="Circuit" value={d.trackId} onChange={e=>{d.trackId=e.target.value;void d.load();}}>{TRACKS.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        <label>Lead car<select aria-label="Lead car" value={d.carId} onChange={e=>{d.carId=e.target.value as CarId;void d.load();}}>{CARS.map(c=><option key={c.id} value={c.id}>{c.shortName}</option>)}</select></label>
        <label>Cars<select aria-label="Cars" value={d.count} onChange={e=>{d.count=Number(e.target.value);void d.load();}}>{[1,2,3,4].map(n=><option key={n}>{n}</option>)}</select></label>
        <div className="trailer-route-status"><span>{d.routeAvailable?`Recorded route / ${d.routes[d.trackId]?.length} points`:'No recorded route for this circuit'}</span><button title="Reload recorded routes" aria-label="Reload recorded routes" onClick={()=>void d.reloadRoutes()}><RefreshCw size={16}/></button></div>
        {!d.routeAvailable&&<a className="trailer-route-link" href="/dev">Open route recorder</a>}
        <fieldset disabled={!d.routeAvailable}>{slider('Route position (m)',d.routeOffset,0,Math.max(1,d.routeLength-1),1,n=>{d.routeOffset=n;d.time=0;})}</fieldset>
      </fieldset>
      <fieldset disabled={!d.ready}><legend>Drive &amp; record</legend>
        <p className="trailer-hint">Pick a car and drive it with your game keys. Press Enter (or Record) to save a take; the other cars replay their takes while you drive. Use Park here to leave a car where you drove it.</p>
        {Array.from({length:d.count},(_,i)=>{const take=d.takes[i],active=d.driveSlot===i;return <div className="trailer-driver" key={i}>
          <div className="trailer-driver-head"><strong>Car {i+1}</strong><span>{d.actors[i]?CARS.find(c=>c.id===d.actors[i].id)?.shortName:''}</span>
            <span className="trailer-take">{active&&d.recording?`REC ${d.recordedSeconds.toFixed(1)}s`:take?(take.frames.length<=10?'Parked':`Take ${takeSeconds(take).toFixed(1)}s`):'Route ghost'}</span></div>
          <div className="trailer-driver-actions">
            {active?<button onClick={()=>d.stopDrive()}><Square size={14}/> Stop driving</button>:<button disabled={d.driveLoading>=0} onClick={()=>void d.startDrive(i)}><Car size={14}/> {d.driveLoading===i?'Loading…':'Drive'}</button>}
            {take&&!active&&<button title="Remove this car's take and parked position" onClick={()=>d.clearTake(i)}><Trash2 size={14}/> Clear</button>}
          </div>
          {active&&<div className="trailer-driver-actions">
            {d.recording?<button aria-pressed="true" onClick={()=>d.finishTake()}><Square size={14}/> Stop &amp; keep</button>:<button onClick={()=>d.record()}><Circle size={14}/> Record</button>}
            <button onClick={()=>d.parkHere()}><ParkingCircle size={14}/> Park here</button>
            <button onClick={()=>d.resetDriven()}><RotateCcw size={14}/> Reset</button>
            <output>{d.speedKmh} km/h</output>
          </div>}
        </div>;})}
      </fieldset>
      <fieldset disabled={!d.canPlay}><legend>Ghost drivers</legend>
        {slider('Shot duration (s)',d.duration,2,60,.5,n=>{d.shotDuration=n;d.time=Math.min(d.time,n);})}
        {d.motion.slice(0,d.count).map((m,i)=><details className="trailer-actor" key={i}><summary>Car {i+1} / {d.actors[i]?CARS.find(c=>c.id===d.actors[i].id)?.shortName:''}</summary>
          <label>Direction<select aria-label={`Car ${i+1} direction`} value={m.direction} onChange={e=>update(()=>{m.direction=Number(e.target.value) as 1|-1;})}><option value="1">Along route</option><option value="-1">Against route</option></select></label>
          {slider(`Car ${i+1} start speed (km/h)`,m.speed,0,180,1,n=>m.speed=n)}
          {slider(`Car ${i+1} end speed (km/h)`,m.endSpeed,0,180,1,n=>m.endSpeed=n)}
          {slider(`Car ${i+1} spacing (m)`,m.offset,-200,200,1,n=>m.offset=n)}
          {slider(`Car ${i+1} start lane (m)`,m.lane,-4,4,.1,n=>m.lane=n)}
          {slider(`Car ${i+1} end lane (m)`,m.endLane,-4,4,.1,n=>m.endLane=n)}
          {slider(`Car ${i+1} delay (s)`,m.delay,0,10,.1,n=>m.delay=n)}
        </details>)}
      </fieldset>
      <fieldset disabled={!d.ready}><legend>Light</legend>
        <div className="trailer-presets">{[['Day',13],['Sunset',18],['Night',22],['Moon',0]].map(([name,hour])=><button key={name} aria-pressed={d.hour===hour} onClick={()=>update(()=>{d.hour=Number(hour);})}>{name}</button>)}</div>
        {slider('Hour',d.hour,0,23.99,.05,n=>d.hour=n)}
        {slider('Exposure',d.exposure,.4,2,.05,n=>d.exposure=n)}
        {slider('Bloom',d.bloom,0,1,.02,n=>d.bloom=n)}
        {slider('Fog distance',d.fogFar,150,6500,50,n=>d.fogFar=n)}
        <label>Weather<select aria-label="Weather" value={d.weather} onChange={e=>update(()=>{d.weather=e.target.value as WeatherPreset;d.world.setWeather(d.weather);})}>{['clear','rain','snow','fog'].map(w=><option key={w}>{w}</option>)}</select></label>
        <label className="trailer-check"><input type="checkbox" checked={d.headlights} onChange={e=>update(()=>{d.headlights=e.target.checked;})}/>Headlights</label>
        <label className="trailer-check"><input type="checkbox" checked={d.cycle} onChange={e=>update(()=>{d.cycle=e.target.checked;})}/>Sun / moon cycle</label>
        {d.cycle&&slider('Cycle duration (s)',d.cycleSeconds,10,240,1,n=>d.cycleSeconds=n)}
      </fieldset>
      <fieldset disabled={!d.ready}><legend>Camera</legend>
        <label className="trailer-check"><input type="checkbox" checked={d.cockpit} onChange={e=>update(()=>{d.cockpit=e.target.checked;if(e.target.checked)d.fov=Math.max(d.fov,70);})}/>Cockpit view (followed car)</label>
        <label className="trailer-check"><input type="checkbox" checked={d.framePack} onChange={e=>update(()=>{d.framePack=e.target.checked;})}/>Frame whole pack</label>
        <label>Follow<select aria-label="Camera subject" value={d.focusCar} onChange={e=>update(()=>{d.focusCar=Number(e.target.value);})}>{d.actors.map((a,i)=><option key={i} value={i}>Car {i+1} / {CARS.find(c=>c.id===a.id)?.shortName}</option>)}</select></label>
        <label>Camera move<select aria-label="Camera move" value={d.camRig.custom?'custom':'preset'} onChange={e=>{if(e.target.value==='custom')d.customFromPreset();else update(()=>{d.camRig.custom=false;});}}><option value="preset">Shot preset</option><option value="custom">Custom move</option></select></label>
        {!d.camRig.custom&&<>
          {fine('Field of view (°)',d.fov,8,120,.1,n=>d.fov=n)}
          {fine('Height offset (m)',d.cameraHeight,-.5,12,.01,n=>d.cameraHeight=n)}
          {fine('Side offset (m)',d.cameraSide,-8,8,.01,n=>d.cameraSide=n)}
          <button className="trailer-wide" onClick={()=>d.customFromPreset()}>Edit as custom move</button>
        </>}
        {d.camRig.custom&&<>
          <label>Anchor<select aria-label="Camera anchor" value={d.camRig.anchor} onChange={e=>update(()=>{d.camRig.anchor=e.target.value as CamRig['anchor'];})}><option value="follow">Travel with car</option><option value="fixed">Tripod (stays at shot start)</option></select></label>
          <label>Easing<select aria-label="Camera easing" value={d.camRig.ease} onChange={e=>update(()=>{d.camRig.ease=e.target.value as CamEase;})}><option value="linear">Linear</option><option value="inout">Ease in &amp; out</option><option value="in">Ease in</option><option value="out">Ease out</option></select></label>
          <label className="trailer-check"><input type="checkbox" checked={d.camRig.avoidWalls} onChange={e=>update(()=>{d.camRig.avoidWalls=e.target.checked;})}/>Pull in front of walls</label>
          <label>Path<select aria-label="Camera path" value={d.camRig.path??'line'} onChange={e=>update(()=>{d.camRig.path=e.target.value as 'line'|'arc';})}><option value="arc">Orbit around car</option><option value="line">Straight line</option></select></label>
          <div className="trailer-edit-key">Mouse edits
            {(['from','to'] as const).map(w=><button key={w} aria-pressed={d.editKey===w} onClick={()=>{d.editKey=w;d.playing=false;d.seek(w==='from'?0:d.duration);refresh();}}>{w==='from'?'Start':'End'}</button>)}
          </div>
          <p className="trailer-hint">Drag the view to orbit, wheel to move closer or farther, right-drag to pan and tilt. Hold Shift for fine moves.</p>
          <div className="trailer-driver-actions">
            <button onClick={()=>update(()=>{d.camRig.to={...d.camRig.from};})}>End = start</button>
            <button onClick={()=>update(()=>{d.camRig.from={...d.camRig.to};})}>Start = end</button>
            <button onClick={()=>update(()=>{const f=d.camRig.from;d.camRig.from=d.camRig.to;d.camRig.to=f;})}>Swap</button>
          </div>
          <details open><summary>Start (0 s)</summary>{keyControls('from')}</details>
          <details open><summary>End ({d.duration.toFixed(1)} s)</summary>{keyControls('to')}</details>
          <details><summary>Aim point on car</summary>
            {fine('Aim forward (m)',d.camRig.aimForward,-6,6,.01,n=>d.camRig.aimForward=n)}
            {fine('Aim right (m)',d.camRig.aimSide,-4,4,.01,n=>d.camRig.aimSide=n)}
            {fine('Aim height (m)',d.camRig.aimHeight,-1,4,.01,n=>d.camRig.aimHeight=n)}
          </details>
        </>}
      </fieldset>
      {d.error&&<p role="alert">{d.error}<button onClick={()=>void d.load()}>Retry</button></p>}
      {importError&&<p role="alert">{importError}</p>}
    </aside>
    <footer className="trailer-transport">
      <button title="Reset shot" aria-label="Reset shot" disabled={!d.ready} onClick={()=>{d.playing=false;d.seek(0);}}><RotateCcw size={18}/></button>
      <button title={d.playing?'Pause':'Play'} aria-label={d.playing?'Pause':'Play'} disabled={!d.canPlay} onClick={()=>update(()=>{if(d.time===d.duration)d.time=0;d.playing=!d.playing;})}>{d.playing?<Pause size={18}/>:<Play size={18}/>}</button>
      <button title="Step one frame" aria-label="Step one frame" disabled={!d.ready} onClick={()=>{d.playing=false;d.seek(d.time+1/60);}}><StepForward size={18}/></button>
      <input aria-label="Shot timeline" type="range" min="0" max={d.duration} step={1/60} value={d.time} disabled={!d.ready} onChange={e=>{d.playing=false;d.seek(Number(e.target.value));}}/>
      <output>{d.ready?`${d.time.toFixed(2)} / ${d.duration.toFixed(2)}`:'Loading...'}</output>
      <select aria-label="Playback speed" value={d.speed} onChange={e=>update(()=>{d.speed=Number(e.target.value);})}>{[.25,.5,1].map(n=><option key={n} value={n}>{n}x</option>)}</select>
      <label className="trailer-check"><input type="checkbox" checked={d.loop} onChange={e=>update(()=>{d.loop=e.target.checked;})}/>Loop</label>
      <button title="Save take settings" aria-label="Save take settings" onClick={save}><Download size={18}/></button>
      <label className="trailer-import" title="Load take settings"><Upload size={18}/><input aria-label="Load take settings" type="file" accept=".json,application/json" disabled={!d.ready} onChange={e=>{void restore(e.target.files?.[0]);e.target.value='';}}/></label>
      <button title="Fullscreen" aria-label="Fullscreen" onClick={()=>void document.documentElement.requestFullscreen().catch(()=>{})}><Maximize size={18}/></button>
      <button title="Hide controls (H / Esc to restore)" aria-label="Hide controls" onClick={()=>setHidden(true)}><EyeOff size={18}/></button>
    </footer>
  </main>;
}

/** Apply the same saved circuit layout the game uses, so a driven car spawns and handles identically. */
async function applyDevConfig() {
  applySavedStartPlacements(TRACKS);applySavedFinishPlacements(TRACKS);applySavedRoadWidthOverrides(TRACKS);
  const local=loadCheckpoints();TRACKS.forEach(t=>applyCheckpoints(t,local[t.id]));
  try{
    const response=await fetch('/api/dev-circuit-config',{signal:AbortSignal.timeout(5000)});
    if(!response.ok)return;
    const config=await response.json() as {starts?:Record<string,never>;finishes?:Record<string,never>;roads?:Record<string,Record<number,number>>;maps?:Record<string,import('../../shared/tracks').Vec3[]>;checkpoints?:CheckpointLayouts};
    TRACKS.forEach(track=>{applyStartPlacement(track,config.starts?.[track.id]);applyFinishPlacement(track,config.finishes?.[track.id]);applyRoadWidthOverrides(track,config.roads?.[track.id]);track.mapPath=config.maps?.[track.id];});
    if(config.checkpoints)TRACKS.forEach(t=>applyCheckpoints(t,config.checkpoints![t.id]));
  }catch{/* Browser drafts remain available while the local server is offline. */}
}
export async function bootTrailer() {
  await Promise.all([document.fonts.ready,applyDevConfig()]);
  const director=new TrailerDirector(document.querySelector<HTMLCanvasElement>('#world')!);
  (window as unknown as {__trailer:TrailerDirector}).__trailer=director;
  createRoot(document.getElementById('app')!).render(<TrailerApp director={director}/>);
  await director.reloadRoutes();
  // ?take=/path/to/take.json loads a saved take; &play=1 starts it, &clean=1 hides the controls.
  const query=new URLSearchParams(location.search),takeUrl=query.get('take');
  if(takeUrl){
    try{
      await director.loadRecipe(await (await fetch(takeUrl)).json());
      if(query.get('play')==='1'){director.time=0;director.playing=true;}
      if(query.get('clean')==='1')document.querySelector('.trailer-ui')?.classList.add('trailer-hidden');
    }catch(error){director.error=error instanceof Error?error.message:'Could not load take.';director.onChange();}
  }
}
