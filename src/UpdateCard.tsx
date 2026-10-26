import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion, type Variants } from 'framer-motion';
import { assetUrl } from '../shared/assets';
import { read, write } from './storage';

/**
 * What's new, shown once per player: after the loading screen hands over to the menu the first time this update is
 * seen (remembered on this device). The reveal borrows the city's police roadblocks: the picture opens out of a thin
 * red-and-blue lightbar, like a widescreen film opening, and the lightbar's colours keep washing the card's edges.
 *
 * Bump UPDATE.id for the next update; add ?update to the address to see it again.
 */
const UPDATE = {
  id: 'racing-city-2026-10',
  date: 'October 2026',
  image: 'art/update-racing-city.jpg',
  heading: 'The city is open',
  summary: 'Drive a whole city at night, with live traffic and working signals. Race two street circuits closed off by police, or bring friends and share the same streets.',
  features: [
    { name: 'Free roam', detail: 'Five districts after dark. L for headlights, M for the map.' },
    { name: 'Street races', detail: 'Grand Loop and Ridge Sprint. Stop in an orange box to start.' },
    { name: 'Party mode', detail: 'Drive or race the city together, in the same traffic.' },
  ],
};

/** One signature curve for the card: fast out, long settle. */
const SETTLE = [.16, 1, .3, 1] as const;
const REVEAL_AT = .95;

const card: Variants = {
  hidden: { opacity: 0, y: 46, scale: .955, rotateX: 7 },
  shown: { opacity: 1, y: 0, scale: 1, rotateX: 0, transition: { type: 'spring', stiffness: 210, damping: 26, mass: .9 } },
  gone: { opacity: 0, y: 18, scale: .97, transition: { duration: .22, ease: [.4, 0, 1, 1] } },
};
const content: Variants = { hidden: {}, shown: { transition: { delayChildren: REVEAL_AT + .35, staggerChildren: .07 } } };
const rise: Variants = {
  hidden: { opacity: 0, y: 18, filter: 'blur(6px)' },
  shown: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { duration: .62, ease: SETTLE } },
};

export function UpdateCard({ onExplore }: { onExplore: () => void }) {
  const reduced = !!useReducedMotion();
  const forced = typeof location !== 'undefined' && new URLSearchParams(location.search).has('update');
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLElement>(null);

  // Shown once the loading screen has been passed, if this player has not seen this update yet.
  useEffect(() => {
    const show = () => { if (forced || read('updateSeen', '') !== UPDATE.id) { write('updateSeen', UPDATE.id); setOpen(true); } };
    if ((window as unknown as { __apexContinued?: boolean }).__apexContinued) { show(); return; }
    window.addEventListener('apex:continued', show, { once: true });
    return () => window.removeEventListener('apex:continued', show);
  }, [forced]);
  useEffect(() => {
    if (!open) return;
    // Keys belong to the card while it is open (Enter must not start a race behind it); Esc closes it. Focused buttons
    // still answer Enter and Space: stopping the event here does not cancel their default action.
    const key = (event: KeyboardEvent) => { event.stopPropagation(); if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', key, true);
    // Focus moves into the card (not onto a button, so no focus ring shows until someone uses the keyboard).
    dialog.current?.focus({ preventScroll: true });
    return () => window.removeEventListener('keydown', key, true);
  }, [open, reduced]);

  const close = () => setOpen(false);
  const explore = () => { setOpen(false); onExplore(); };

  return <AnimatePresence>{open && <motion.div key="update" className="update-scrim" role="presentation" onClick={close}
    initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { duration: .35 } }} exit={{ opacity: 0, transition: { duration: .28, delay: .05 } }}>
    {/* Ambient: the lightbar's red and blue, washing in turn round the card. */}
    {!reduced && <>
      <motion.i className="update-wash is-red" aria-hidden="true" animate={{ opacity: [.12, .42, .12, .12, .3, .12] }} transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut', times: [0, .12, .3, .5, .62, 1] }} />
      <motion.i className="update-wash is-blue" aria-hidden="true" animate={{ opacity: [.12, .12, .4, .12, .12, .3] }} transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut', times: [0, .3, .42, .6, .8, .92] }} />
    </>}
    <motion.section ref={dialog} tabIndex={-1} className="update-card" role="dialog" aria-modal="true" aria-labelledby="update-heading" onClick={event => event.stopPropagation()}
      variants={reduced ? undefined : card} initial={reduced ? { opacity: 0 } : 'hidden'} animate={reduced ? { opacity: 1 } : 'shown'} exit={reduced ? { opacity: 0 } : 'gone'}>

      <div className="update-frame">
        {/* The picture opens out of a thin lightbar, top and bottom edges parting like a widescreen film. */}
        <motion.div className="update-film"
          initial={reduced ? false : { clipPath: 'inset(49.4% 0% 49.4% 0%)' }}
          animate={{ clipPath: 'inset(0% 0% 0% 0%)', transition: { delay: REVEAL_AT - .2, duration: .95, ease: [.7, 0, .2, 1] } }}>
          <motion.img src={assetUrl(UPDATE.image)} alt="A blue Bugatti Bolide at sunset in Racing City, police cars blocking the street behind it."
            initial={reduced ? false : { scale: 1.16, filter: 'brightness(.55) saturate(.7)' }}
            animate={{ scale: 1, filter: 'brightness(1) saturate(1)', transition: { delay: REVEAL_AT - .2, duration: 2.1, ease: SETTLE } }} />
          {/* One pass of light across the picture once it is open. */}
          {!reduced && <motion.i className="update-sweep" aria-hidden="true" initial={{ x: '-130%', opacity: 0 }} animate={{ x: '560%', opacity: [0, 1, 1, 0] }} transition={{ delay: REVEAL_AT + .55, duration: 1.3, ease: [.45, 0, .2, 1], opacity: { delay: REVEAL_AT + .55, duration: 1.3, times: [0, .12, .8, 1] } }} />}
        </motion.div>
        {!reduced && <motion.div className="update-lightbar" aria-hidden="true"
          initial={{ scaleX: 0, opacity: 1 }}
          animate={{ scaleX: [0, 1, 1, 1, 1, 1.02], opacity: [1, 1, .35, 1, .35, 0] }}
          transition={{ delay: .22, duration: REVEAL_AT + .1, times: [0, .32, .5, .66, .82, 1], ease: 'easeOut' }}>
          <i className="is-red" /><i className="is-blue" />
        </motion.div>}
        <motion.span className="update-stamp" initial={reduced ? false : { opacity: 0, x: 14 }} animate={{ opacity: 1, x: 0, transition: { delay: REVEAL_AT + .5, duration: .5, ease: SETTLE } }}>
          New update<b>{UPDATE.date}</b>
        </motion.span>
      </div>

      <motion.div className="update-body" variants={reduced ? undefined : content} initial={reduced ? false : 'hidden'} animate="shown">
        <div className="update-lead">
          <motion.h2 id="update-heading" variants={rise}>{UPDATE.heading}</motion.h2>
          <motion.p variants={rise}>{UPDATE.summary}</motion.p>
          <motion.div className="update-actions" variants={rise}>
            <motion.button className="update-go" onClick={explore} whileHover={reduced ? undefined : { y: -2 }} whileTap={{ scale: .97 }}>
              Take me to free roam
              <motion.svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" animate={reduced ? undefined : { x: [0, 4, 0] }} transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut', delay: REVEAL_AT + 1.4 }}>
                <path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              </motion.svg>
            </motion.button>
            <motion.button className="update-close" onClick={close} whileTap={{ scale: .97 }}>Close<kbd>Esc</kbd></motion.button>
          </motion.div>
        </div>
        <ul className="update-features">
          {UPDATE.features.map(feature => <motion.li key={feature.name} variants={rise}>
            <strong>{feature.name}</strong><span>{feature.detail}</span>
          </motion.li>)}
        </ul>
      </motion.div>
    </motion.section>
  </motion.div>}</AnimatePresence>;
}
