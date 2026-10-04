import {useEffect,useMemo} from 'react';
import {motion,useSpring,useTransform} from 'framer-motion';
import {CARS} from '../shared/cars';
import type {Game} from './game';
import {unlocked,UNLOCK_XP} from './progression';

// The tachometer shares the speedometer's 246° arc (viewBox 0 0 100 76), mirrored on the left of the screen.
export const ARC={cx:50,cy:38.5,r:43,start:146.9,sweep:246.3};
export const arcPoint=(t:number,r=ARC.r)=>{const a=(ARC.start+ARC.sweep*t)*Math.PI/180;return {x:ARC.cx+r*Math.cos(a),y:ARC.cy+r*Math.sin(a)};};
export const arcPath=(from:number,to:number,r=ARC.r)=>{const a=arcPoint(from,r),b=arcPoint(to,r);return `M${a.x.toFixed(2)} ${a.y.toFixed(2)}A${r} ${r} 0 ${(to-from)*ARC.sweep>180?1:0} 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;};
const SHIFT_LIGHTS=[.8,.85,.9,.94,.97];
const ordinal=(n:number)=>n===1?'1st':n===2?'2nd':n===3?'3rd':`${n}th`;
export function RpmGauge({game}:{game:Game}){
  const sim=game.sim,engine=sim.engine,scale=engine.redline*1.08,manual=sim.manual;
  const load=engine.rpm/engine.redline,reversing=sim.forwardSpeed<-.2;
  const smooth=useSpring(0,{stiffness:260,damping:30});useEffect(()=>smooth.set(Math.min(1,engine.rpm/scale)),[engine.rpm,scale,smooth]);
  // Needle covers only the outer ring so it never crosses the gear number.
  const inner={x:useTransform(smooth,t=>arcPoint(t,24).x),y:useTransform(smooth,t=>arcPoint(t,24).y)};
  const outer={x:useTransform(smooth,t=>arcPoint(t,42).x),y:useTransform(smooth,t=>arcPoint(t,42).y)};
  const fill=useTransform(smooth,t=>`${t*220} 220`);
  // Static dial parts depend only on the car's rev range.
  const dial=useMemo(()=>{const step=scale>11000?2000:1000,ticks=[];for(let rpm=0;rpm<=scale+1;rpm+=1000)ticks.push({rpm,major:rpm%step===0});return {ticks,red:arcPath(engine.redline*.9/scale,1)};},[scale,engine.redline]);
  const blocked=performance.now()-game.shiftBlockedAt<900;
  const hint=!manual?'Auto shifting':blocked?`Too fast for ${ordinal(sim.gear-1)}`:load>.92&&sim.gear<engine.gears?`Shift up · ${game.keyHint('shiftUp')}`:`${game.keyHint('shiftDown')} ↓  ${game.keyHint('shiftUp')} ↑`;
  return <div className={`tachometer ${load>.92?'near-redline':''} ${manual&&load>.98?'at-limiter':''} ${blocked?'shift-blocked':''}`} aria-label={`Engine ${Math.round(engine.rpm)} rpm, gear ${reversing?'reverse':sim.gear}`}>
    <svg viewBox="0 0 100 76" aria-hidden="true">
      <path d={arcPath(0,1)} fill="none" stroke="rgba(255,255,255,.22)" strokeWidth="2"/>
      <path d={dial.red} fill="none" stroke="#ff784c" strokeWidth="2.6" opacity=".85"/>
      <motion.path d={arcPath(0,1)} pathLength="220" fill="none" stroke="currentColor" strokeWidth="4" style={{strokeDasharray:fill}} opacity=".55"/>
      {dial.ticks.map(({rpm,major})=>{const t=rpm/scale,a=arcPoint(t,major?37:39),b=arcPoint(t,42.5),label=arcPoint(t,31);return <g key={rpm}><line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={rpm>=engine.redline*.9?'#ff784c':'#e1f3ef'} strokeWidth={major?1:.5} opacity=".8"/>{major&&<text x={label.x} y={label.y+1.8} textAnchor="middle" fontSize="5" fill="#d6e8e9">{rpm/1000}</text>}</g>;})}
      <motion.line x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y} stroke="#fff" strokeWidth="1.6" strokeLinecap="round"/>
    </svg>
    {manual&&<div className="shift-lights" aria-hidden="true">{SHIFT_LIGHTS.map((at,i)=><i key={at} className={load>=at?`lit light-${i}`:''}/>)}</div>}
    <strong>{reversing?'R':sim.gear}</strong><span>{Math.round(engine.rpm/100)*100} rpm</span>
    <small>{manual?(game.state.mode==='replay'?'Manual replay':'Manual'):'Automatic'}<b>{hint}</b></small>
  </div>;
}
export function CareerPanel({game}:{game:Game}){
  const next=[...CARS].sort((a,b)=>UNLOCK_XP[a.id]-UNLOCK_XP[b.id]).find(c=>!unlocked(game.career,c.id));
  return <><div className="career-overview"><strong>{game.career.xp.toLocaleString()}<small> REP</small></strong><span>{game.career.finishes} races completed<br/>{CARS.filter(c=>unlocked(game.career,c.id)).length} / {CARS.length} cars unlocked</span></div><p>REP means reputation. Hit every checkpoint in order, then cross the finish. REP arrives at the end; driving around alone earns none.</p><dl className="xp-rules"><div><dt>Complete a race</dt><dd>+100 REP</dd></div><div><dt>Finish in advanced driving mode<small>Manual gears for the whole race; enable in Settings.</small></dt><dd>+100 extra</dd></div><div><dt>First finish on each circuit</dt><dd>+100 extra</dd></div><div><dt>Improve a circuit medal<small>+50 per tier: Bronze, Silver, Gold. Awarded once per tier.</small></dt><dd>+50 / tier</dd></div></dl><p className="xp-example">First circuit + Gold + manual gears = <strong>450 REP</strong>. Repeat manual finish = <strong>200 REP</strong>.</p>{next?<div className="next-unlock"><span>Next unlock</span><strong>{next.name}</strong><progress aria-label="Next car unlock" max={UNLOCK_XP[next.id]} value={game.career.xp}/><small>{UNLOCK_XP[next.id]-game.career.xp} REP to go</small></div>:<p>All cars unlocked. Chase your next personal best.</p>}<p className="muted-text">Progress saves in this browser. Normal races on custom layouts earn REP too. Replays and editor drives do not.</p></>;
}
