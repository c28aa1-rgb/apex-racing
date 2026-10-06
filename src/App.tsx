import { MULTIPLAYER_BACKEND } from './multiplayer-config';
import { assetUrl } from '../shared/assets';
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AnimatePresence, motion, MotionConfig, useIsPresent, useReducedMotion, useSpring, useTransform } from 'framer-motion';
import { CONE_TRACK, TRACKS, formatTime, medalFor, trackById, type Track } from '../shared/tracks';
import { CARS, carById, type CarDefinition, type CarId } from '../shared/cars';
import { PHYSICS_VERSION, Simulation } from '../shared/physics';
import { runSchema, type Run } from '../shared/replay';
import { Game, type GameState } from './game';
import { api, read, write, bestRun, type Entry, type Player } from './storage';
import { hasLocalStartPlacement } from './dev-spawns';
import { SettingsPanel } from './SettingsPanel';
import { ACTION_LABELS, type Action } from './controls';
import { CareerPanel, RpmGauge, arcPath, arcPoint } from './RacePanels';
import { NAME_NUDGE_REP, UNLOCK_XP, affordable, lifetimeRep, unlocked } from './progression';
import { NameNudge } from './NameNudge';
import { CarUnlock } from './CarUnlock';
import { PartyPanel } from './PartyPanel';
import { LotMap } from './LotMap';
import { CAMERA_LABELS } from './camera-modes';
import { PRESET_LABELS } from './graphics';

const ease=[.2,.8,.2,1] as const;
const KM_TO_MI=.621371;
const KG_TO_LB=2.20462;
const M_TO_FT=3.28084;
const circuitMiles=(meters:number)=>`${(meters/1609.344).toFixed(2)} mi`;
function Icon({name,size=20}:{name:string;size?:number}) {
  const paths:Record<string,ReactNode>={
    settings:<><circle cx="12" cy="12" r="3"/><path d="m10 2-1 3-3 1-3-1-2 4 2 2v3l-2 2 2 4 3-1 3 1 1 3h4l1-3 3-1 3 1 2-4-2-2v-3l2-2-2-4-3 1-3-1-1-3Z"/></>,
    play:<path d="m8 5 11 7-11 7Z"/>,close:<path d="m6 6 12 12M18 6 6 18"/>,pause:<path d="M8 5v14M16 5v14"/>,
    restart:<><path d="M3 10a9 9 0 1 1 1 8M3 4v6h6"/></>,sound:<><path d="m11 4-5 4H2v8h4l5 4ZM15 8c3 2 3 6 0 8M18 4c6 4 6 12 0 16"/></>,
    soundLow:<path d="m11 4-5 4H2v8h4l5 4ZM15 8c3 2 3 6 0 8"/>,
    mute:<><path d="m11 4-5 4H2v8h4l5 4ZM16 9l6 6m0-6-6 6"/></>,fullscreen:<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>,
    trophy:<><path d="M7 3h10v7a5 5 0 0 1-10 0ZM7 5H3v3a4 4 0 0 0 4 4m10-7h4v3a4 4 0 0 1-4 4M12 15v6m-4 0h8"/></>,
    user:<><circle cx="12" cy="8" r="4"/><path d="M4 22v-3a8 8 0 0 1 16 0v3"/></>,
    ghost:<><path d="M5 20V9a7 7 0 0 1 14 0v11l-3-2-4 2-4-2ZM9 8v3m6-3v3"/></>,
    arrow:<path d="M4 12h16m-6-6 6 6-6 6"/>,check:<path d="m5 12 4 4L20 5"/>
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]??paths.arrow}</svg>;
}
/** Keep the last decoded photograph visible while the next circuit image loads. */
function TrackPreview({track,reduced}:{track:Track;reduced:boolean}) {
  const [shown,setShown]=useState<Track|null>(null);
  useEffect(()=>{
    let current=true;
    const image=new Image();image.src=assetUrl(`art/tracks/${track.id}.jpg`);
    image.decode().then(()=>{if(current)setShown(track);}).catch(()=>{});
    return()=>{current=false;};
  },[track]);
  return <div className="track-preview-stage" aria-hidden="true"><AnimatePresence initial={false}>
    {shown&&<motion.img key={shown.id} className="track-preview" src={assetUrl(`art/tracks/${shown.id}.jpg`)} alt={`${shown.name} — Sketchfab preview`}
      initial={{opacity:0,scale:reduced?1:1.035}} animate={{opacity:1,scale:1}} exit={{opacity:0}}
      transition={{duration:reduced?0:.55,ease,scale:{duration:reduced?0:.8,ease}}}/>}
  </AnimatePresence></div>;
}
function Modal({title,children,onClose,reduced}:{title:string;children:ReactNode;onClose:()=>void;reduced:boolean}) {
  const ref=useRef<HTMLDialogElement>(null);
  const present=useIsPresent();
  useEffect(()=>{const dialog=ref.current!;dialog.showModal();dialog.querySelector<HTMLInputElement>('input')?.focus();return()=>{if(dialog.open)dialog.close();};},[]);
  return <motion.dialog ref={ref} data-leaving={present?'false':'true'} initial={{opacity:0,y:reduced?0:18,scale:reduced?1:.985}} animate={{opacity:1,y:0,scale:1}} exit={{opacity:0,y:reduced?0:8,scale:reduced?1:.99}} transition={reduced?{duration:0}:present?{type:'spring',stiffness:460,damping:38,mass:.9,opacity:{duration:.2}}:{duration:.16,ease:[.4,0,1,1]}} onCancel={e=>{e.preventDefault();onClose();}} onClick={e=>{if(e.target===ref.current)onClose();}} aria-label={title}>
    <div className="dialog-content">
      <header><h2>{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={onClose}><Icon name="close"/></button></header>{children}
    </div>
  </motion.dialog>;
}
/** Subscribes to one live readout; re-renders only when the selected primitive changes. */
function useLive<T extends string|number|boolean>(game:Game,select:(state:GameState)=>T):T {
  return useSyncExternalStore(game.subscribe,()=>select(game.snapshot()));
}
function Minimap({track,car}:{track:Track;car?:{x:number;z:number}}) {
  const map=useMemo(()=>{
    const points=track.mapPath?.length ? track.mapPath : [track.segments[0].start,...track.segments.map(s=>s.end)];
    const xs=points.map(p=>p.x),zs=points.map(p=>p.z),minX=Math.min(...xs),maxX=Math.max(...xs),minZ=Math.min(...zs),maxZ=Math.max(...zs);
    const scale=130/Math.max(maxX-minX,maxZ-minZ);
    // Top-down view of the right-handed scene: x runs right and z runs DOWN the screen, so left and right turns match the road.
    const coords=(p:{x:number;z:number})=>({x:18+(p.x-minX)*scale,y:150-(maxZ-p.z)*scale});
    return {points,line:points.map(p=>{const c=coords(p);return `${c.x},${c.y}`;}).join(' '),coords};
  },[track]);
  const c=car?map.coords(car):undefined,start=map.coords(map.points[0]),finish=map.coords(map.points.at(-1)!);
  return <svg className="minimap" viewBox="0 0 170 170" role="img" aria-label={`${track.name} track map`}>
    <MapBase line={map.line} start={start} finish={finish}/>
    {c&&<circle cx={c.x} cy={c.y} r="5" fill="#ff784c" stroke="#fff" strokeWidth="2"/>}
  </svg>;
}
const MapBase=memo(function MapBase({line,start,finish}:{line:string;start:{x:number;y:number};finish:{x:number;y:number}}) {
  return <>
    <polyline points={line} fill="none" stroke="rgba(255,255,255,.16)" strokeWidth="10" strokeLinejoin="round"/>
    <polyline points={line} fill="none" stroke="#a8dadc" strokeWidth="3" strokeLinejoin="round"/>
    <circle cx={start.x} cy={start.y} r="5" fill="#f1faee"/>
    <circle cx={finish.x} cy={finish.y} r="5" fill="#ff784c"/>
  </>;
});
/** Speedometer drawn on the same dial as the tachometer (RacePanels), scaled to the car's top speed. */
function Speed({speed,boost,drifting,car}:{speed:number;boost:boolean;drifting:boolean;car:CarDefinition}) {
  const max=Math.ceil(car.physics.topSpeedKph*KM_TO_MI*1.08/20)*20;
  const smooth=useSpring(0,{stiffness:200,damping:30});useEffect(()=>smooth.set(Math.min(speed/max,1)),[speed,max,smooth]);
  const fill=useTransform(smooth,t=>`${t*220} 220`);
  const inner={x:useTransform(smooth,t=>arcPoint(t,24).x),y:useTransform(smooth,t=>arcPoint(t,24).y)};
  const outer={x:useTransform(smooth,t=>arcPoint(t,42).x),y:useTransform(smooth,t=>arcPoint(t,42).y)};
  const ticks=useMemo(()=>{const label=max>200?40:20,minor=label/2,out=[];for(let v=0;v<=max;v+=minor)out.push({v,major:v%label===0});return out;},[max]);
  return <div className={`speedometer ${boost?'boosting':''}`}>
    <svg viewBox="0 0 100 76" aria-hidden="true">
      <path d={arcPath(0,1)} fill="none" stroke="rgba(255,255,255,.22)" strokeWidth="2"/>
      <motion.path d={arcPath(0,1)} pathLength="220" fill="none" stroke="currentColor" strokeWidth="4" style={{strokeDasharray:fill}} opacity=".55"/>
      {ticks.map(({v,major})=>{const t=v/max,a=arcPoint(t,major?37:39),b=arcPoint(t,42.5),l=arcPoint(t,31);return <g key={v}><line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#e1f3ef" strokeWidth={major?1:.5} opacity=".8"/>{major&&<text x={l.x} y={l.y+1.8} textAnchor="middle" fontSize={max>200?4.2:5} fill="#d6e8e9">{v}</text>}</g>;})}
      <motion.line x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y} stroke="#fff" strokeWidth="1.6" strokeLinecap="round"/>
    </svg>
    <strong>{speed.toString().padStart(3,'0')}</strong><span>mph</span><small>{car.shortName}<b>{drifting?'Drift active':boost?'Boost active':'\u00a0'}</b></small>
  </div>;
}
function Garage({game,car,modelReady,onRace,onTraining,reduced}:{game:Game;car:CarDefinition;modelReady:boolean;onRace:()=>void;onTraining:()=>void;reduced:boolean}) {
  const details=[
    ['Acceleration',car.stats.acceleration,`≈ ${(car.physics.zeroToHundred*.94).toFixed(1)} s · 0–60 mph`],
    ['Top speed',car.stats.topSpeed,`${Math.round(car.physics.topSpeedKph*KM_TO_MI)} mph`],
    ['Turning',car.stats.turning,`${car.stats.turning} / 100`],
    ['Braking',car.stats.braking,`${Math.round(car.physics.brakeDistance*.932*M_TO_FT)} ft · 60–0 mph`]
  ] as const;
  const [celebrating,setCelebrating]=useState<CarId>();
  const owned=unlocked(game.career,car.id),price=UNLOCK_XP[car.id],canBuy=affordable(game.career,car.id);
  const buy=()=>{if(game.buyCar(car.id))setCelebrating(car.id);};
  return <motion.main key="garage" className="garage" initial={{opacity:0,x:reduced?0:24}} animate={{opacity:1,x:0}} exit={{opacity:0,x:reduced?0:16,transition:{duration:reduced?0:.18,ease:[.4,0,1,1]}}} transition={{duration:reduced?0:.38,ease}}>
    {/* Readability shade behind the roster and spec panels; it fades with them during a car unlock. */}
    <div className="garage-shade" aria-hidden="true"/>
    <motion.aside className="garage-roster" aria-label="Choose a car" initial={{opacity:0,x:reduced?0:-14}} animate={{opacity:1,x:0}} transition={{duration:reduced?0:.34,delay:reduced?0:.06,ease}}>
      <p>{CARS.filter(c=>unlocked(game.career,c.id)).length} / {CARS.length} unlocked · {game.career.xp.toLocaleString()} REP</p><h1>Choose your<br/>next drive.</h1>
      <div>{[...CARS].sort((a,b)=>UNLOCK_XP[a.id]-UNLOCK_XP[b.id]).map((item,index)=><button key={item.id} className={`${item.id===car.id?'active':''} ${affordable(game.career,item.id)?'can-buy':''}`} onClick={()=>game.selectCar(item.id)} aria-pressed={item.id===car.id}>
        <span>{String(index+1).padStart(2,'0')}</span><strong>{item.shortName}</strong>{unlocked(game.career,item.id)?item.id===car.id&&<Icon name="check" size={16}/>:<small className="unlock-cost">{UNLOCK_XP[item.id]} REP</small>}</button>)}</div>
    </motion.aside>
    <div className="garage-orbit" aria-label="Drag to orbit around the car" onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { if(event.currentTarget.hasPointerCapture(event.pointerId)) game.world.rotateGarage(event.movementX); }} onPointerUp={event => { event.currentTarget.releasePointerCapture(event.pointerId); }} />
    <section className="garage-stage" aria-live="polite"><span className={modelReady?'ready':''}>{modelReady?'Model ready':'Loading detailed model…'}</span><small>Drag to move along the camera rail</small><button aria-label="Orbit car left" onClick={()=>game.world.rotateGarage(-35)}>↶</button><button aria-label="Orbit car right" onClick={()=>game.world.rotateGarage(35)}>↷</button><button onClick={()=>game.world.resetGarageView()}>Reset view</button></section>
    <AnimatePresence mode="wait" initial={false}><motion.aside className="garage-spec" key={car.id} exit={{opacity:0,x:reduced?0:-10,pointerEvents:"none",transition:{duration:reduced?0:.12}}} initial={{opacity:0,x:reduced?0:18}} animate={{opacity:1,x:0}} transition={{duration:reduced?0:.3,ease}}>
      <span className="garage-discipline">{car.discipline}</span><h2>{car.name}</h2><p>{car.description}</p>
      <dl className="car-facts"><div><dt>Drive</dt><dd>{car.physics.drivetrain}</dd></div><div><dt>Weight</dt><dd>{Math.round(car.physics.massKg*KG_TO_LB).toLocaleString()} lb</dd></div></dl>
      <div className="car-stats">{details.map(([label,value,detail])=><div key={label}><span>{label}<strong>{detail}</strong></span><i><motion.b style={{width:`${value}%`,transformOrigin:"left"}} initial={{scaleX:reduced?1:0}} animate={{scaleX:1}} transition={{duration:reduced?0:.4,delay:reduced?0:.08,ease}}/></i></div>)}</div>
      <div className="unlock-progress"><span>{owned?'Ready to race':canBuy?`Price ${price.toLocaleString()} REP · you have ${game.career.xp.toLocaleString()}`:`${(price-game.career.xp).toLocaleString()} more REP to buy`}</span><progress aria-label="REP saved toward this car" max={price||1} value={owned?price||1:Math.min(price,game.career.xp)}/><small>Finish +100 REP · manual finish +100 extra<br/>First circuit +100 · medal improvements +50 each</small></div>
      <details className="garage-rep-guide"><summary>How reputation works</summary><CareerPanel game={game}/></details>
      {owned||!canBuy?<button className="start-button" disabled={!owned||!modelReady} onClick={onRace}><Icon name="arrow"/><span>{owned?`Race with ${car.shortName}`:`Locked · ${price.toLocaleString()} REP`}</span></button>
        :<motion.button className="start-button buy-button" onClick={buy} whileHover={{x:reduced?0:3}} whileTap={{scale:reduced?1:.97}}><Icon name="check"/><span>Buy for {price.toLocaleString()} REP</span></motion.button>}
      <button className="training-entry" disabled={!modelReady} onClick={onTraining}><span className="training-icon" aria-hidden="true"><svg viewBox="0 0 48 48" width="40" height="40">
        <ellipse cx="24" cy="43" rx="17" ry="3" fill="#0006"/>
        <path d="M21.2 5.5h5.6L36 37H12Z" fill="#ff6a1a"/><path d="M24 5.5h2.8L36 37h-6.5Z" fill="#d94a0c"/>
        <path d="M18.3 15.5h11.4l1.9 6.5H16.4ZM14.7 27.5h18.6l1.8 6H12.9Z" fill="#f4f1ea"/>
        <rect x="7" y="36" width="34" height="5" rx="1.5" fill="#22262a"/><rect x="7" y="36" width="34" height="1.6" rx=".8" fill="#3a4046"/>
      </svg></span><span><strong>Training Grounds</strong><small>Free roam with {car.shortName}{unlocked(game.career,car.id)?'':' · works while locked'} · no clock</small></span><Icon name="arrow" size={18}/></button>
      <small className="garage-note">Vehicle ratings alter engine force, mass, aero, grip, steering and braking in the simulation.</small>
    </motion.aside></AnimatePresence>
    <AnimatePresence>{celebrating&&<CarUnlock key={celebrating} car={carById(celebrating)} price={UNLOCK_XP[celebrating]} balance={game.career.xp} still={reduced}
      onClose={()=>{game.world.endUnveil();setCelebrating(undefined);}} onRace={()=>{game.world.endUnveil();setCelebrating(undefined);onRace();}}/>}</AnimatePresence>
    <footer className="garage-footer"><span>Rear grip breaks progressively under fast, loaded steering.</span><a href={assetUrl('models/garage/CREDITS.txt')} target="_blank" rel="noreferrer">Garage credit</a><a href={assetUrl('models/cars/CREDITS.txt')} target="_blank" rel="noreferrer">Vehicle credits</a></footer>
  </motion.main>;
}
function LiveTime({game}:{game:Game}) { return <strong>{formatTime(useLive(game,s=>s.time))}</strong>; }
function LiveMinimap({game,track}:{game:Game;track:Track}) { useLive(game,s=>s.speed);const car=game.sim.car.translation();return track.lot?<LotMap track={track} car={car}/>:<Minimap track={track} car={car}/>; }
function LiveSpeed({game,car}:{game:Game;car:CarDefinition}) {
  return <Speed speed={useLive(game,s=>s.speed)} boost={useLive(game,s=>s.boost)} drifting={useLive(game,s=>s.drifting)} car={car}/>;
}
function LiveRpm({game}:{game:Game}) { useLive(game,s=>s.time);return <RpmGauge game={game}/>; }
/** Optional readout: rendered frames last second, slowest frame, and current render resolution. */
function FpsMeter({game}:{game:Game}) {
  const fps=useLive(game,s=>s.fps),worst=useLive(game,s=>s.worstFrame);
  return <div className={`fps-meter ${fps<30?'is-slow':fps<50?'is-warn':''}`} aria-label="Frame rate">{fps} fps<small>worst {worst} ms · {Math.round(game.world.renderer.getPixelRatio()*100)}% res</small></div>;
}
function FlipButton({game,racing}:{game:Game;racing:boolean}) {
  const slow=useLive(game,s=>s.speed<=15);
  return <button onClick={()=>game.flip()} disabled={!racing||!slow} title={slow?'Flip the car upright':'Slow below 15 mph to flip the car'}><kbd>{game.keyHint('flip')}</kbd> Flip car</button>;
}
/** Small banner from the right edge when the frame rate stays low: switch to a lighter preset, or not now. */
function PerfTip({game,tip,reduced}:{game:Game;tip:NonNullable<GameState['perfTip']>;reduced:boolean}) {
  const label=(id:string)=>PRESET_LABELS[id as keyof typeof PRESET_LABELS]??id;
  return <motion.aside className="perf-tip" role="status" aria-live="polite"
    initial={{x:reduced?0:'calc(100% + 24px)',opacity:reduced?0:1}} animate={{x:0,opacity:1}} exit={{x:reduced?0:'calc(100% + 24px)',opacity:reduced?0:1,transition:{duration:.2,ease:[.4,0,1,1]}}}
    transition={{type:'spring',stiffness:380,damping:34}}>
    <span className="perf-tip-meter" aria-hidden="true"><b style={{height:`${Math.max(12,Math.min(100,tip.fps/60*100))}%`}}/></span>
    <div><strong>Low frame rate · {tip.fps} fps</strong><small>Try {label(tip.to)} instead of {label(tip.from)} graphics.</small>
      <span className="perf-tip-actions"><button onClick={()=>game.acceptPerfTip()}><kbd>Y</kbd> Switch to {label(tip.to)}</button><button className="perf-tip-dismiss" onClick={()=>game.declinePerfTip()}><kbd>N</kbd> Not now</button></span></div>
  </motion.aside>;
}
const ordinal=(n:number)=>`${n}${['th','st','nd','rd'][n%100>10&&n%100<14?0:n%10]??'th'}`;
/** Party race: the moment you cross the line. Same callout as time trials, with your place once the server confirms it; fades after a few seconds while the car rolls on. */
function PartyFinishCallout({time,place,still}:{time:number;place?:number;still:boolean}) {
  const [shown,setShown]=useState(true);
  useEffect(()=>{const timer=setTimeout(()=>setShown(false),4500);return()=>clearTimeout(timer);},[]);
  return <AnimatePresence>{shown&&<motion.div className="finish-callout party-finish-callout" role="status"
    initial={{opacity:0,x:'-50%',y:still?0:-28,scale:still?1:.88}} animate={{opacity:1,x:'-50%',y:still?0:[-28,8,0],scale:still?1:[.88,1.06,1]}} exit={{opacity:0,x:'-50%',y:still?0:-10,transition:{duration:.2}}}
    transition={still?{duration:.18}:{duration:.68,ease:[.05,.7,.1,1],times:[0,.62,1]}}>
    <span>{place?`Finished ${ordinal(place)}`:'Finished'}</span><strong>{formatTime(time)}</strong>
  </motion.div>}</AnimatePresence>;
}
/** Cone Attack result, shown while free roam carries on, then gone after five seconds. */
function ConeResultCard({result,status,reduced}:{result:NonNullable<GameState['coneResult']>;status:string;reduced:boolean}) {
  const [shown,setShown]=useState(true);
  useEffect(()=>{const timer=setTimeout(()=>setShown(false),5000);return()=>clearTimeout(timer);},[]);
  const medal=result.medal==='Finished'?'':result.medal.toLowerCase();
  return <AnimatePresence>{shown&&<motion.aside className={`cone-result ${medal?`is-${medal}`:''}`} role="status"
    initial={{opacity:0,y:reduced?0:-20,scale:reduced?1:.94}} animate={{opacity:1,y:0,scale:1}} exit={{opacity:0,y:reduced?0:-12,transition:{duration:.2,ease:[.4,0,1,1]}}}
    transition={{type:'spring',stiffness:420,damping:32,mass:.8}}>
    <span className="cone-result-eyebrow">{result.newBest?'New personal best':'Cone Attack'}</span>
    <strong>{formatTime(result.timeMs)}</strong>
    <div className="cone-result-detail">
      <span className="cone-result-medal">{medal?`${result.medal} medal`:'Finished'}</span>
      <small>{result.penalties?`${result.penalties} s in penalties${result.offCourse?` · left the course ${result.offCourse}×`:''}`:'Clean run · no penalties'}</small>
      {status&&<small className="cone-result-status">{status}</small>}
      <small className="cone-result-hint">Drive into the orange box to go again</small>
      {!reduced&&<motion.i className="cone-result-timer" initial={{scaleX:1}} animate={{scaleX:0}} transition={{duration:5,ease:'linear'}}/>}
    </div>
  </motion.aside>}</AnimatePresence>;
}
/** Free-roam readout: the live drift combo, banked when the slide ends. */
function DriftPanel({game,best}:{game:Game;best:number}) {
  const combo=Math.round(useLive(game,s=>s.driftCombo));
  return <div className={`drift-panel ${combo>0?'is-live':''}`}><span>Training Grounds</span>
    <strong>{combo>0?combo.toLocaleString():'Drift'}</strong>
    <small>{combo>0?'Hold the slide':best>0?`Best combo ${Math.round(best).toLocaleString()}`:'Slide to build a combo'}</small></div>;
}
/** Race HUD. Only the Live* parts follow per-tick readouts; the rest re-renders with the coarse state. */
function RaceHud({game,state}:{game:Game;state:GameState}) {
  const track=state.track,free=track.kind==='lot';
  return <>{game.settings.showFps&&<FpsMeter game={game}/>}
          {free?<DriftPanel game={game} best={state.driftBest}/>:<div className={`timer-panel ${track.kind==='cones'?'is-cones':''}`}><span>{game.partyRace?'Party race':state.mode==='replay'?'Replay':track.kind==='cones'?'Cone Attack':'Time trial'}</span><LiveTime game={game}/><div>{track.checkpoints.map((_,i)=><i key={i} className={i<state.checkpoint?'passed':''}/>)}<small>{state.checkpoint} / {track.checkpoints.length}</small></div>
            <AnimatePresence>{state.penalties>0&&<motion.b key={state.penalties} className="cone-penalty" initial={{scale:.4,opacity:0,y:-6}} animate={{scale:1,opacity:1,y:0}} exit={{opacity:0}} transition={{type:'spring',stiffness:520,damping:18}}>+{state.penalties} s<small>{state.penalties===1?'1 cone':`${state.penalties} cones`}</small></motion.b>}</AnimatePresence></div>}
          <div className="race-left"><div className="map-panel"><LiveMinimap game={game} track={track}/></div>{!game.partyRace&&!free&&<p><Icon name="ghost" size={15}/>{game.ghostRun&&state.ghost?formatTime(game.ghostRun.timeMs):'No ghost this run'}</p>}{free&&<p className="lot-hint">Any car · no clock</p>}</div>
          <LiveSpeed game={game} car={state.car}/><LiveRpm game={game}/>
          <button className="camera-toggle" onClick={()=>game.toggleCamera()} title="Cycle camera views"><kbd>{game.keyHint('camera')}</kbd> Camera · {CAMERA_LABELS[game.world.cameraMode]}</button>
          <span className="mouse-look-hint">{game.settings.pointerLock?'Mouse to look':'Drag to look'} · wheel zooms · hold {game.keyHint('lookBack')} to look behind</span>
          <div className="race-shortcuts">{!game.partyRace&&<button onClick={()=>game.restart()}><kbd>{game.keyHint('restart')}</kbd> {free?'Reset car':'Restart'}</button>}{!free&&<button onClick={()=>game.recover()} disabled={state.mode!=='racing'}><kbd>{game.keyHint('recover')}</kbd> Checkpoint</button>}<FlipButton game={game} racing={state.mode==='racing'}/>{!game.partyRace&&<button onClick={()=>game.pause()}><kbd>Esc</kbd> Pause</button>}</div>
          <AnimatePresence>{free&&state.atStart&&state.mode==='racing'&&<motion.button key="cone-prompt" className="cone-prompt" onClick={()=>game.requestConeRun()} initial={{opacity:0,y:18,scale:.96}} animate={{opacity:1,y:0,scale:1}} exit={{opacity:0,y:10}} transition={{type:'spring',stiffness:420,damping:30}}><span className="cone-prompt-key"><kbd>Enter</kbd></span><span><strong>Start Cone Attack</strong><small>Stop in the box · every cone you touch costs 1 s</small></span></motion.button>}</AnimatePresence>
          <AnimatePresence>{state.notice&&state.mode==='racing'&&<motion.div key={state.notice} className="race-notice" role="status" initial={{opacity:0,y:-12,scale:.95}} animate={{opacity:1,y:0,scale:1}} exit={{opacity:0,y:-8}}>{state.notice}</motion.div>}</AnimatePresence>
        </>;
}
export function App({game}:{game:Game}) {
  const state=useSyncExternalStore(game.subscribe,game.coarseSnapshot),track=state.track;
  const reduced=useReducedMotion();
  const still=Boolean(reduced||game.settings.reducedMotion);
  const [view,setView]=useState<'tracks'|'garage'|'party'>('tracks');
  const [transitioning,setTransitioning]=useState(false);
  const [dialog,setDialog]=useState<'help'|'profile'|'leaderboard'|'settings'|null>(null);
  const [player,setPlayer]=useState<Player|null>(()=>read('player',null));
  const [nickname,setNickname]=useState(player?.nickname??'Driver');
  const [entries,setEntries]=useState<Entry[]>([]),[boardStatus,setBoardStatus]=useState('Loading leaderboard…');
  const [message,setMessage]=useState(''),[busy,setBusy]=useState(false),[submission,setSubmission]=useState('');
  const [boardTrack,setBoardTrack]=useState(track.id);
  const boardTracks=read('conesFound',false)?[...TRACKS,CONE_TRACK]:TRACKS;
  const activeTrack=boardTracks.find(t=>t.id===boardTrack)??TRACKS[0];
  const boardRequest=useRef(0);
  const refresh=async(id=boardTrack)=>{const token=++boardRequest.current;setEntries([]);setBoardStatus('Loading leaderboard…');try{const result=await api<{entries:Entry[]}>(`/leaderboards/${id}`);if(token!==boardRequest.current)return;setEntries(result.entries);setBoardStatus(result.entries.length?'':'No times yet. Set the first one.');}catch{if(token!==boardRequest.current)return;setEntries([]);setBoardStatus('Leaderboard offline. You can still race and save your best locally.');}};
  useEffect(()=>{if(dialog==='leaderboard')void refresh();},[dialog,boardTrack]);
  useEffect(()=>{setSubmission('');},[state.run]);
  // Cone Attack results arrive while the car keeps rolling: personal bests post themselves when a nickname is set.
  const [coneStatus,setConeStatus]=useState('');
  useEffect(()=>{
    const result=state.coneResult;if(!result)return;
    if(!result.newBest){setConeStatus(result.previousBest?`Your best stays ${formatTime(result.previousBest)}`:'');return;}
    if(!player){setConeStatus('Set a nickname in the menu to post your times');return;}
    let live=true;setConeStatus('Posting your time…');
    api<{improved:boolean;verified?:boolean}>('/runs',result.run).then(response=>{if(live)setConeStatus(response.improved?(response.verified===false?'Posted · unverified time':'Posted to the leaderboard'):(response.verified===false?'Unverified · your posted best is faster':'Verified · your posted best is faster'));})
      .catch(error=>{if(live)setConeStatus(error instanceof Error?error.message:'Leaderboard offline · best saved on this device');});
    return()=>{live=false;};
  },[state.coneResult?.at]);
  const open=(value:typeof dialog)=>{if(state.mode!=='menu'&&state.mode!=='finished')game.pause();setMessage('');setDialog(value);};
  const savePlayer=async()=>{
    setBusy(true);setMessage('');try{
      let next:Player;
      if(player){try{const result=await api<{id:string;nickname:string}>('/players/me',{nickname},'PUT');next={...player,...result};}catch(error){if(error instanceof Error&&error.message.includes('expired'))next=await api<Player>('/players',{nickname});else throw error;}}
      else next=await api<Player>('/players',{nickname});
      write('player',next);setPlayer(next);setNickname(next.nickname);setDialog(null);
    }catch(error){setMessage(error instanceof Error?error.message:'Could not save nickname.');}finally{setBusy(false);}
  };
  const submit=async()=>{
    if(!state.run)return;
    if(hasLocalStartPlacement(state.track)){setSubmission('This is a custom practice layout. Restore project defaults in /dev before submitting online.');return;}
    if(!player){open('profile');setMessage('Choose a nickname, then submit your run.');return;}
    setBusy(true);setSubmission('Checking your run…');
    try{const result=await api<{improved:boolean;entries:Entry[];verified?:boolean}>('/runs',state.run);setSubmission(result.verified===false?(result.improved?'Posted. Your unverified best is on the leaderboard.':'Your previous unverified best is faster.'):(result.improved?'Verified. Your best is on the leaderboard.':'Verified. Your previous best is faster.'));setEntries(result.entries);}
    catch(error){setSubmission(error instanceof Error?error.message:'Could not submit. Your best is saved locally.');}finally{setBusy(false);}
  };
  const raceGhost=async(entry:Entry)=>{
    setBusy(true);setMessage('Loading ghost…');try{
      const run=runSchema.parse(await api<Run>(`/replays/${entry.id}`));
      if(run.physicsVersion!==PHYSICS_VERSION||run.trackVersion!==activeTrack.version)throw new Error('This ghost is from an older track.');
      if(hasLocalStartPlacement(activeTrack))throw new Error('Restore the project layout in /dev before racing an official ghost.');
      await game.select(activeTrack,true);game.start();if(!['racing','countdown'].includes(game.state.mode))throw new Error(game.state.notice);game.ghostSim?.dispose();
      game.ghostSim=new Simulation(activeTrack,run.carId,run.origin);game.ghostRun=run;void game.world.setGhostCar(run.carId);game.emit({ghost:true});setDialog(null);
    }catch(error){setMessage(error instanceof Error?error.message:'Ghost unavailable.');}finally{setBusy(false);}
  };
  const menu=state.mode==='menu';
  // After a race, a driver with enough REP but no nickname gets a pit board under the nickname button.
  const [nudge,setNudge]=useState(false);const lastMode=useRef(state.mode);
  useEffect(()=>{const from=lastMode.current;lastMode.current=state.mode;
    if(state.mode==='menu'&&from!=='menu'&&from!=='replay'&&!player&&lifetimeRep(game.career)>=NAME_NUDGE_REP)setNudge(true);},[state.mode,player,game]);
  useEffect(()=>{if(player)setNudge(false);},[player]);
  // The paddock mounts only once the curtain covers the old page (its own 3D stage replaces the world view),
  // and leaves first when you switch away, so the two never pop over each other.
  const [partyShown,setPartyShown]=useState(false);
  useEffect(()=>{game.onLeaveTraining=()=>{setPartyShown(false);setView('garage');};return()=>{game.onLeaveTraining=undefined;};},[game]);
  const changeView=(next:'tracks'|'garage'|'party')=>{if(view===next)return;if(view==='party')setPartyShown(false);setTransitioning(true);setView(next);};
  const showTracks=()=>changeView('tracks');
  const showGarage=()=>changeView('garage');
  return <MotionConfig reducedMotion={game.settings.reducedMotion?"always":"user"} transition={{duration:still?0:.26,ease}}>
    <div className={`interface ${still?'reduce-motion':''} ${menu?'is-menu':'is-racing'} ${state.mode==='celebrating'?'is-celebrating':''} ${menu&&view==='garage'?'is-garage':''} ${menu&&view==='party'?'is-party':''}`}>
      <header className="topbar">
        <button className="brand" disabled={!!game.partyRace} onClick={()=>{game.menu();showTracks();}} aria-label="APEX track selection">APEX<span> / </span></button>
        {menu?<nav aria-label="Main navigation">
          <button className={view==='tracks'&&dialog!=='leaderboard'?'nav-active':''} onClick={showTracks}>Time trials{view==='tracks'&&dialog!=='leaderboard'&&<motion.span className="nav-line" layoutId="primary-nav-line" transition={{duration:still?0:.26,ease}}/>}</button>
          <button className={view==='garage'&&dialog!=='leaderboard'?'nav-active':''} onClick={showGarage}>Garage{view==='garage'&&dialog!=='leaderboard'&&<motion.span className="nav-line" layoutId="primary-nav-line" transition={{duration:still?0:.26,ease}}/>}</button>
          <button className={view==='party'&&dialog!=='leaderboard'?'nav-active':''} onClick={()=>changeView('party')}>Party{view==='party'&&dialog!=='leaderboard'&&<motion.span className="nav-line" layoutId="primary-nav-line" transition={{duration:still?0:.26,ease}}/>}</button>
          <button className={dialog==='leaderboard'?'nav-active':''} onClick={()=>{setBoardTrack(trackById(track.id)?.kind==='lot'?TRACKS[0].id:track.id);open('leaderboard');}}>Leaderboards{dialog==='leaderboard'&&<motion.span className="nav-line" layoutId="primary-nav-line" transition={{duration:still?0:.26,ease}}/>}</button>
        </nav>:<span className="current-track">{track.lot?'TG':String(TRACKS.findIndex(t=>t.id===track.id)+1).padStart(2,'0')} <span>/</span> {track.name} <small>{state.car.shortName}</small></span>}
        <div className="top-actions">{menu&&<button className="career-chip" title="Reputation and car unlocks" onClick={showGarage}>{game.career.xp.toLocaleString()} REP</button>}{menu&&<span className="profile-anchor"><button className={`profile-button ${nudge&&view==='tracks'&&!dialog?'is-nudged':''}`} onClick={()=>{setNudge(false);open('profile');}}><Icon name="user" size={16}/><span>{player?.nickname??'Set nickname'}</span></button>
          <AnimatePresence>{nudge&&view==='tracks'&&!dialog&&<NameNudge key="name-nudge" rep={lifetimeRep(game.career)} still={still} onDismiss={()=>setNudge(false)} onChoose={()=>{setNudge(false);open('profile');}}/>}</AnimatePresence></span>}
          <div className="volume-control">
            <button className="icon-button" aria-label={state.muted?'Enable sound':'Mute sound'} aria-pressed={state.muted} title={`Sound (${game.keyHint('mute')})`} onClick={()=>game.toggleMute()}><Icon name={state.muted||game.settings.volume===0?'mute':game.settings.volume<=.5?'soundLow':'sound'}/></button>
            <div className="volume-popover">
              <input type="range" aria-label="Master volume" aria-valuetext={`${Math.round(game.settings.volume*100)} percent`} min="0" max="1" step=".01" value={game.settings.volume} onChange={e=>game.setSettings({volume:+e.target.value})}/>
            </div>
          </div>
          <button className="icon-button" aria-label="Toggle fullscreen" onClick={()=>{if(document.fullscreenElement)void document.exitFullscreen();else void document.documentElement.requestFullscreen().catch(()=>{});}}><Icon name="fullscreen"/></button>
          {!menu&&!game.partyRace&&state.mode!=='celebrating'&&<button className="icon-button" aria-label="Pause race" onClick={()=>game.pause()}><Icon name="pause"/></button>}
          <button className="icon-button" aria-label="Settings" title="Settings & controls" onClick={()=>open('settings')}><Icon name="settings"/></button>
        </div>
      </header>
      <motion.div className="view-curtain" aria-hidden="true" initial={false} animate={{opacity:transitioning?1:0}} transition={{duration:still?0:transitioning?.18:.32,ease:transitioning?[.4,0,1,1]:ease}}/>
      <AnimatePresence>{menu&&view==='tracks'&&<motion.div key="track-backdrop" initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} transition={{duration:still?0:.32}}><TrackPreview track={track} reduced={still}/></motion.div>}</AnimatePresence>
      <AnimatePresence mode="wait" onExitComplete={()=>{if(transitioning){game.setGarage(view==='garage');setPartyShown(view==='party');setTransitioning(false);}}}>
        {menu&&view==='party'?<motion.div key="party-view" exit={{opacity:0,transition:{duration:still?0:.2}}}/>:menu&&view==='garage'?<Garage game={game} car={state.car} modelReady={state.modelReady} onRace={showTracks} onTraining={()=>{game.partyView=false;game.setGarage(false);void game.enterTraining();}} reduced={still}/>:menu?<motion.main key="menu" className="menu" initial={{opacity:0,x:still?0:-24}} animate={{opacity:1,x:0}} exit={{opacity:0,x:still?0:-16,transition:{duration:still?0:.18,ease:[.4,0,1,1]}}} transition={{duration:still?0:.38,ease}}>
          <div className="world-label"><span className="live-mark"/>Circuit preview<span className="world-label-rule"/> {circuitMiles(track.length)}</div>
          <AnimatePresence mode="wait" initial={false}><motion.section className="track-info" key={track.id} initial={{opacity:0,x:still?0:16}} animate={{opacity:1,x:0}} exit={{opacity:0,x:still?0:-10,pointerEvents:"none",transition:{duration:still?0:.12,ease:[.4,0,1,1]}}} transition={{duration:still?0:.28,ease}}>
            <div className="track-kicker"><span className="course-number">{String(TRACKS.indexOf(track)+1).padStart(2,'0')}</span><span className="difficulty">{track.difficulty}</span></div>
            <p className="track-subtitle">{track.subtitle}</p>
            <h1>{track.name}</h1><p className="description">{track.description}</p>
            <div className="medals" aria-label="Medal target times">{track.medals.map((ms,i)=><div key={i}><span className={`medal medal-${i}`}><Icon name="trophy" size={17}/></span><span>{['Gold','Silver','Bronze'][i]}<strong>{formatTime(ms).slice(0,-1)}</strong></span></div>)}</div>
            <div className="personal-best"><span>{hasLocalStartPlacement(track)?'Personal best · custom layout':'Personal best'}</span><strong>{state.personalBest?formatTime(state.personalBest):'Set your first time'}</strong></div>
            <motion.button className="start-button" disabled={state.trackLoading||!state.modelReady||!unlocked(game.career,state.car.id)} whileHover={{x:still?0:3}} whileTap={{scale:still?1:.98}} onClick={()=>game.start()}><Icon name="play" size={23}/><span>{!unlocked(game.career,state.car.id)?'Choose an unlocked car':!state.modelReady?'Loading car…':state.trackLoading?'Preparing circuit…':'Race this track'}</span><kbd>Enter</kbd></motion.button>
            {state.notice&&<p className="form-message" role="status">{state.notice}</p>}
            <button className={`ghost-toggle ${state.ghost?'selected':''}`} onClick={()=>game.toggleGhost()} aria-pressed={state.ghost}><Icon name="ghost" size={17}/><span>Personal best ghost</span><span className="switch"><i/></span></button>
          </motion.section></AnimatePresence>
          <div className="preview-caption"><span>Pure speed.<br/>One more try.</span></div>
          <motion.section className="track-picker" aria-label="Choose a track" initial={{opacity:0,y:still?0:12}} animate={{opacity:1,y:0}} transition={{duration:still?0:.34,delay:still?0:.08,ease}}><div className="picker-label"><span>Real-world circuit collection</span><span>{TRACKS.length} tracks</span></div>
            <div className="track-cards">{TRACKS.map((t,i)=><motion.button key={t.id} whileHover={{y:still?0:-4}} whileTap={{scale:still?1:.98}} transition={{type:"spring",stiffness:450,damping:32}} className={`track-card ${t.id===track.id?'active':''}`} onClick={()=>game.select(t)} aria-pressed={t.id===track.id}>
              <img src={assetUrl(`art/${t.id}.png`)} alt=""/><span className="card-number">{String(i+1).padStart(2,'0')}</span><span className="card-copy"><strong>{t.name}</strong><small>{t.difficulty} <span> / </span> {circuitMiles(t.length)}</small></span>{t.id===track.id&&<motion.span className="track-selection" layoutId="track-selection" transition={{duration:still?0:.3,ease}}/>}<AnimatePresence>{t.id===track.id&&<motion.span className="selected-check" initial={{opacity:0,scale:still?1:.7}} animate={{opacity:1,scale:1}} exit={{opacity:0,scale:still?1:.7}}><Icon name="check" size={15}/></motion.span>}</AnimatePresence>
            </motion.button>)}</div>
          </motion.section>
          <footer className="menu-footer"><span><kbd>{['throttle','left','brake','right'].map(a=>game.keyHint(a as Action).split(' / ')[0]).join(' ')}</kbd> Drive <i/> <kbd>{game.keyHint('recover')}</kbd> Checkpoint <i/> <kbd>{game.keyHint('camera')}</kbd> Camera</span><button onClick={()=>open('help')}>All controls <Icon name="arrow" size={15}/></button><small><a href={assetUrl('art/tracks/CREDITS.txt')} target="_blank" rel="noreferrer">Circuit model credits</a> · {state.car.shortName}</small></footer>
        </motion.main>:<motion.div key="hud" className="hud" initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}}>
          <RaceHud game={game} state={state}/>
          <AnimatePresence>{state.perfTip&&<PerfTip key="perf" game={game} tip={state.perfTip} reduced={still}/>}</AnimatePresence>
          <AnimatePresence>{state.coneResult&&track.kind==='lot'&&<ConeResultCard key={state.coneResult.at} result={state.coneResult} status={coneStatus} reduced={still}/>}</AnimatePresence>
        </motion.div>}
      </AnimatePresence>
      <AnimatePresence>
        {state.mode==='countdown'&&<motion.div className="countdown" key="countdown" initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0,scale:1.1}}><span>{track.kind==='cones'?(state.countdown===6?'Cone Attack':'Watch the lights'):state.countdown===6?'Settle on the grid':'Watch the lights'}</span><small>{track.kind==='cones'?'Every cone you touch costs a second':`Hold ${game.keyHint('throttle')} · launch on green`}</small></motion.div>}
        {state.mode==='party-finished'&&game.partyFinishedAt>0&&<PartyFinishCallout key={game.partyFinishedAt} time={state.time} place={game.partyPlace} still={still}/>}
        {state.mode==='celebrating'&&<motion.div className="finish-callout" key="finish-callout" role="status" initial={{opacity:0,x:'-50%',y:still?0:-28,scale:still?1:.88}} animate={{opacity:1,x:'-50%',y:still?0:[-28,8,0],scale:still?1:[.88,1.06,1]}} exit={{opacity:0,x:'-50%',y:still?0:-10,scale:still?1:.97}} transition={still?{duration:.18}:{duration:.68,ease:[.05,.7,.1,1],times:[0,.62,1]}}><span>Finish</span><strong>{formatTime(state.time)}</strong></motion.div>}
        {state.mode==='paused'&&<motion.div className="overlay" key="pause" initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}}><motion.section className="result-card" initial={{y:still?0:18,scale:still?1:.97}} animate={{y:0,scale:1}} exit={{y:still?0:8,scale:still?1:.99}} transition={{duration:still?0:.3,ease}}><p className="result-eyebrow">{track.kind==='lot'?'Training Grounds':track.kind==='cones'?'Cone Attack':'Take a breath'}</p><h2>Paused</h2>{state.notice&&<p>{state.notice}</p>}<button className="start-button" onClick={()=>game.resume()}><Icon name="play"/>{track.kind==='lot'?'Keep driving':'Resume race'}<kbd>Esc</kbd></button><button className="secondary-button" onClick={()=>game.restart()}><Icon name="restart"/>{track.kind==='lot'?'Reset car':'Restart run'}</button>{track.kind==='cones'&&<button className="secondary-button" onClick={()=>void game.enterTraining()}>Back to free roam</button>}<button className="secondary-button" onClick={()=>open('settings')}>Settings & controls</button><button className="text-button" onClick={()=>game.menu()}>{track.lot?'Leave the Training Grounds':'Back to tracks'}</button></motion.section></motion.div>}
        {state.mode==='finished'&&<motion.div className="overlay finish-results" key="finish" initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}}><motion.section className="result-card" initial={{y:still?0:20,scale:still?1:.97}} animate={{y:0,scale:1}}>
          <span className="finish-medal"><Icon name="trophy" size={36}/></span><p className="result-eyebrow">{state.newBest?'New personal best':`${track.name} complete`}</p><h2>{medalFor(track,state.time)}{medalFor(track,state.time)!=='Finished'?' medal':''}</h2><strong className="finish-time">{formatTime(state.time)}</strong>
          {game.reward&&<div className="career-reward"><strong>+{game.reward.earned} REP</strong><span>{game.career.xp.toLocaleString()} total · {game.career.finishes} finishes</span>{game.reward.newCars.map(id=><p key={id}>Unlocked: {carById(id).name}</p>)}<details className="xp-breakdown"><summary>REP breakdown</summary>{Object.entries(game.reward.breakdown).filter(([,value])=>value>0).map(([key,value])=><div key={key}><span>{{finish:'Race completed',firstCircuit:'First circuit finish',medal:'Medal improvement',manual:'Manual driving bonus'}[key]}</span><b>+{value}</b></div>)}</details></div>}<p className="finish-detail">{track.kind==='cones'?(state.penalties?`${state.penalties} ${state.penalties===1?'cone':'cones'} · +${state.penalties} s included`:'Clean run · no cones touched'):game.sim.respawns?`${game.sim.respawns} checkpoint recoveries`:'Clean run'}<span> / </span>{state.checkpoint} {track.kind==='cones'?'gates':'checkpoints'}</p>
          <div className="result-actions"><button className="start-button" onClick={()=>game.restart()}><Icon name="restart"/>Race again<kbd>{game.keyHint('restart')}</kbd></button>{!hasLocalStartPlacement(track)&&<button className="secondary-button" onClick={submit} disabled={busy}><Icon name="trophy"/>{busy?'Verifying…':'Submit to leaderboard'}</button>}<button className="secondary-button" onClick={()=>state.run&&game.watch(state.run)}><Icon name="play"/>Watch replay</button></div>
          {submission&&<p className="form-message" role="status">{submission}</p>}{state.notice&&<p className="form-message">{state.notice}</p>}{track.kind==='cones'&&<button className="secondary-button" onClick={()=>void game.enterTraining()}>Back to free roam</button>}<button className="text-button" onClick={()=>game.menu()}>{track.lot?'Leave the Training Grounds':'Back to tracks'}</button>
        </motion.section></motion.div>}
      </AnimatePresence>
      <AnimatePresence>{state.mode==='menu'&&state.trackLoading&&!state.track.lot&&<motion.div key="track-loading" initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} transition={{duration:still?0:.25}} className="track-loading" role="status" aria-live="polite"><div className="loading-wheel"><i/><i/><i/></div><strong>Time Trial</strong><span>{state.track.name}</span><small>Loading the circuit, physics and your ghost…</small></motion.div>}</AnimatePresence>
      <AnimatePresence>{menu&&view==='garage'&&!state.modelReady&&<motion.div initial={{opacity:0,y:still?0:10}} animate={{opacity:1,y:0}} exit={{opacity:0,y:still?0:-6}} className={`car-loading ${game.modelError?'load-error':''}`} role="status" aria-live="polite">{!game.modelError&&<div className="loading-wheel"><i/><i/><i/></div>}<strong>{game.modelError?'Car unavailable':`Preparing ${state.car.shortName}`}</strong><span>{game.modelError||'Loading geometry, paint and wheel rig…'}</span>{game.modelError&&<button onClick={()=>void game.selectCar(state.car.id)}>Retry car load</button>}</motion.div>}</AnimatePresence>
      <PartyPanel game={game} active={menu&&view==='party'&&partyShown} player={player} onPlayer={next=>{setPlayer(next);setNickname(next.nickname);}} reduced={still}/>
      <AnimatePresence mode="wait">
      {dialog==='settings'&&<Modal key="settings" title="Race setup" reduced={still} onClose={()=>setDialog(null)}><SettingsPanel game={game}/></Modal>}
      {dialog==='help'&&<Modal key="help" title="Find your line" reduced={still} onClose={()=>setDialog(null)}><p>Hit every checkpoint in order, then cross the invisible finish line. Chase medals, race your best ghost, and put your time on the board.</p><div className="controls-list">{(Object.keys(ACTION_LABELS) as Action[]).map(action=><div key={action}><kbd>{game.keyHint(action)}</kbd><span>{ACTION_LABELS[action]}</span></div>)}</div><p className="muted-text">At speed, sustained steering lets the tail swing outward. Hold your drift key for a deeper slide: faster, harder turns create more drift. Release the drift key, lift off, brake or countersteer to regain grip. The drift key has no effect while parked or driving straight.</p></Modal>}
      {dialog==='profile'&&<Modal key="profile" title="Your driver name" reduced={still} onClose={()=>setDialog(null)}><p>No account needed. Your driver identity stays in this browser.</p><form onSubmit={e=>{e.preventDefault();void savePlayer();}}><label htmlFor="nickname">Nickname</label><input id="nickname" autoFocus value={nickname} onChange={e=>setNickname(e.target.value)} minLength={2} maxLength={18} required autoComplete="nickname"/><p className="muted-text">2–18 letters, numbers, spaces, underscores or hyphens.</p>{message&&<p className="form-message" role="status">{message}</p>}<button className="start-button" type="submit" disabled={busy}>{busy?'Saving…':'Save nickname'}<Icon name="check"/></button></form></Modal>}
      {dialog==='leaderboard'&&<Modal key="leaderboard" title="Leaderboards" reduced={still} onClose={()=>setDialog(null)}><div className="board-selector"><label htmlFor="board-circuit">Circuit</label><select id="board-circuit" value={boardTrack} onChange={e=>{setBoardTrack(e.target.value);setMessage('');}}>{boardTracks.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select><button className="text-button" onClick={()=>void refresh()}>Refresh</button></div><div className="board-summary"><strong>{entries.length?formatTime(entries[0].timeMs):'—'}</strong><span>{entries.length?`${entries[0].nickname} · fastest ${MULTIPLAYER_BACKEND==='cloudflare'?'unverified':'verified'} lap`:'The starting grid is open'}</span></div><p className="board-intro">Top 50 · best time per driver, all cars · {MULTIPLAYER_BACKEND==='cloudflare'?'casual times · unverified':'replay-verified'}</p>{MULTIPLAYER_BACKEND==='cloudflare'&&<p className="board-intro">Times are recorded by drivers. Saved ghosts are available, but server physics verification is not enabled.</p>}
        {boardStatus&&<div className="board-empty" role="status"><Icon name="trophy" size={32}/><p>{boardStatus}</p><button className="text-button" onClick={()=>void refresh()}>Refresh leaderboard</button></div>}
        {entries.length>0&&<div className="table-scroll"><table><thead><tr><th>Rank</th><th>Driver</th><th>Lap / gap</th><th>Ghost</th></tr></thead><tbody>{entries.map(entry=><tr key={entry.id} className={entry.playerId===player?.id?'is-you':''}><td>{String(entry.rank).padStart(2,'0')}</td><td>{entry.nickname}{entry.playerId===player?.id&&<small> you</small>}<small className="entry-car">{carById(entry.carId).shortName} · {entry.manual?'Manual':'Auto'}</small></td><td className="lap-time">{formatTime(entry.timeMs)}<small>{entry.rank===1?'Leader':`+${((entry.timeMs-entries[0].timeMs)/1000).toFixed(3)}`}</small></td><td><button className="icon-button" aria-label={`Race ${entry.nickname}'s ghost`} disabled={busy} onClick={()=>void raceGhost(entry)}><Icon name="ghost" size={18}/></button></td></tr>)}</tbody></table></div>}
        {message&&<p className="form-message" role="status">{message}</p>}<button className="secondary-button" disabled={busy||!unlocked(game.career,state.car.id)} onClick={async()=>{setBusy(true);setView('tracks');game.partyView=false;game.setGarage(false);if(activeTrack.lot)await game.enterTraining();else{await game.select(activeTrack,true);game.start();}setBusy(false);setDialog(null);}}>{activeTrack.lot?'Go to the Training Grounds':`Race ${activeTrack.name}`}<Icon name="play"/></button>
      </Modal>}
      </AnimatePresence>
    </div>
  </MotionConfig>;
}
