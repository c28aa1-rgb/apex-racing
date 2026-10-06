import { useEffect } from 'react';
import { animate, motion, useMotionValue, useTransform } from 'framer-motion';
import type { CarDefinition } from '../shared/cars';
import { CAR_ACCENT } from './progression';

const SPARKS = 14;
const expoOut = [.16, 1, .3, 1] as const;
// Beat timings in seconds: shake resists, the shackle snaps, then the reveal lands.
export const SNAP = .62; const REVEAL = .82;

/** Unlock moment after a car is bought, layered over the garage camera reveal: lock strains, snaps open, livery stripe, name and stats. */
export function CarUnlock({car,price,balance,still,onRace,onClose}:{car:CarDefinition;price:number;balance:number;still:boolean;onRace:()=>void;onClose:()=>void}) {
  const accent=CAR_ACCENT[car.id];
  const rep=useMotionValue(balance+price),repText=useTransform(rep,v=>Math.round(v).toLocaleString());
  useEffect(()=>{const c=animate(rep,balance,{duration:still?0:.9,delay:still?0:REVEAL+.25,ease:expoOut});return()=>c.stop();},[rep,balance,still]);
  useEffect(()=>{const key=(e:KeyboardEvent)=>{if(e.code==='Escape'){e.stopPropagation();onClose();}};addEventListener('keydown',key,true);return()=>removeEventListener('keydown',key,true);},[onClose]);
  const at=(s:number)=>still?0:s;
  return <motion.div className="car-unlock" role="dialog" aria-modal="true" aria-label={`${car.name} unlocked`} style={{['--accent' as string]:accent}}
    initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0,transition:{duration:still?0:.22,ease:[.3,0,1,1]}}} transition={{duration:still?0:.25}}>
    {/* Light flash as the lock breaks */}
    {!still&&<motion.i className="car-unlock-flash" aria-hidden="true" initial={{opacity:0}} animate={{opacity:[0,.55,0]}} transition={{duration:.5,delay:SNAP,times:[0,.08,1],ease:'easeOut'}}/>}
    {/* Racing stripe wipes through at the snap */}
    <motion.i className="car-unlock-stripe" aria-hidden="true" initial={{scaleX:0,originX:0}} animate={{scaleX:[0,1,1],originX:[0,0,1],opacity:[1,1,.35]}} transition={{duration:still?0:1.1,delay:at(SNAP),times:[0,.4,1],ease:expoOut}}/>
    <div className="car-unlock-lock" aria-hidden="true">
      {/* Burst ring and sparks fire as the shackle releases */}
      <motion.i className="car-unlock-ring" initial={{scale:0,opacity:0}} animate={still?{opacity:0}:{scale:[0,3.2],opacity:[.9,0]}} transition={{duration:.7,delay:SNAP,ease:expoOut}}/>
      {!still&&Array.from({length:SPARKS},(_,i)=>{const a=i/SPARKS*Math.PI*2+(i%2)*.18,d=i%2?150:110;return <motion.b key={i} className="car-unlock-spark" style={{rotate:a*180/Math.PI+90}}
        initial={{x:0,y:0,opacity:0,scaleY:.4}} animate={{x:Math.cos(a)*d,y:Math.sin(a)*d,opacity:[0,1,0],scaleY:[.4,1.4,.2]}} transition={{duration:.65,delay:SNAP+.02+(i%3)*.025,ease:expoOut}}/>;})}
      <motion.svg viewBox="0 0 48 56" width="74" height="86" initial={{scale:.5,opacity:0,y:12}}
        animate={still?{opacity:0}:{scale:[.5,1.06,1,1,1.18,0],opacity:[0,1,1,1,1,0],y:[12,0,0,0,-4,-26],rotate:[0,0,-9,9,-6,0]}}
        transition={{duration:REVEAL+.18,times:[0,.2,.4,.55,.75,1],ease:'easeOut'}}>
        <motion.path d="M13 25V16a11 11 0 0 1 22 0v9" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round"
          style={{originX:'86%',originY:'100%'}} initial={{rotate:0,y:0}} animate={still?{}:{y:[0,0,-7],rotate:[0,0,32]}} transition={{duration:SNAP+.12,times:[0,.86,1],ease:'easeOut'}}/>
        <rect x="5" y="24" width="38" height="29" rx="5" fill="currentColor"/>
        <circle cx="24" cy="36" r="4" fill="#132b3b"/><rect x="22.2" y="37" width="3.6" height="9" rx="1.5" fill="#132b3b"/>
      </motion.svg>
    </div>
    <div className="car-unlock-copy">
      <motion.span className="car-unlock-kicker" initial={{opacity:0,letterSpacing:'.8em'}} animate={{opacity:1,letterSpacing:'.32em'}} transition={{duration:still?0:.55,delay:at(REVEAL),ease:expoOut}}>Unlocked · {car.discipline}</motion.span>
      <h2>{car.shortName.split(' ').map((word,i)=><motion.span key={i} initial={{y:still?0:46,opacity:0,filter:still?'none':'blur(10px)'}} animate={{y:0,opacity:1,filter:'blur(0px)'}}
        transition={{duration:still?0:.6,delay:at(REVEAL+.06+i*.07),ease:expoOut}}>{word}</motion.span>)}</h2>
      <div className="car-unlock-stats">{[['Top speed',`${Math.round(car.physics.topSpeedKph*.621371)} mph`],['0–60',`${(car.physics.zeroToHundred*.94).toFixed(1)} s`],['Drive',car.physics.drivetrain]].map(([label,value],i)=>
        <motion.span key={label} initial={{opacity:0,y:still?0:14,scale:still?1:.92}} animate={{opacity:1,y:0,scale:1}} transition={{duration:still?0:.4,delay:at(REVEAL+.22+i*.06),ease:expoOut}}><small>{label}</small>{value}</motion.span>)}</div>
      <motion.p initial={{opacity:0,y:still?0:10}} animate={{opacity:1,y:0}} transition={{duration:still?0:.35,delay:at(REVEAL+.3),ease:expoOut}}>
        <b>−{price.toLocaleString()} REP</b><span><motion.span>{repText}</motion.span> REP left</span>
      </motion.p>
      <motion.div className="car-unlock-actions" initial={{opacity:0,y:still?0:12}} animate={{opacity:1,y:0}} transition={{duration:still?0:.35,delay:at(REVEAL+.45),ease:expoOut}}>
        <motion.button className="car-unlock-race" autoFocus onClick={onRace} whileHover={{x:still?0:3}} whileTap={{scale:still?1:.97}}>Race it</motion.button>
        <button className="car-unlock-close" onClick={onClose}>Keep browsing</button>
      </motion.div>
    </div>
  </motion.div>;
}
