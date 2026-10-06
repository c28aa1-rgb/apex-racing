import { motion } from 'framer-motion';

/**
 * Pit board hung from the nickname button after a race: drivers with enough REP but no
 * nickname are asked to set one so their times can go on the leaderboards.
 */
export function NameNudge({rep,still,onChoose,onDismiss}:{rep:number;still:boolean;onChoose:()=>void;onDismiss:()=>void}) {
  // Lowered on its cord, the board swings past centre twice and settles.
  const swing=still?{opacity:1}:{opacity:1,y:0,rotate:[-7,4,-2,.8,0]};
  return <motion.aside className="name-nudge" role="status" aria-label="Set a nickname"
    initial={still?{opacity:0}:{opacity:0,y:-18,rotate:-7}} animate={swing}
    exit={{opacity:0,y:still?0:-10,transition:{duration:still?0:.16,ease:[.3,0,1,1]}}}
    transition={still?{duration:.2}:{delay:.55,opacity:{duration:.2,delay:.55},y:{type:'spring',stiffness:420,damping:22,delay:.55},rotate:{duration:1.2,delay:.55,times:[0,.25,.5,.75,1],ease:'easeInOut'}}}>
    <i className="name-nudge-cord" aria-hidden="true"/>
    <div className="name-nudge-board">
      <button className="name-nudge-close" onClick={onDismiss} aria-label="Dismiss">×</button>
      <span className="name-nudge-rep"><b>{rep.toLocaleString()}</b> REP</span>
      <strong>Put a name<br/>on your times</strong>
      <p>Set a nickname so your laps can go on the leaderboards.</p>
      <button className="name-nudge-cta" onClick={onChoose}>Set nickname</button>
    </div>
  </motion.aside>;
}
