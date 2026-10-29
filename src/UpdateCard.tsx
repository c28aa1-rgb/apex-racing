import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion, type Variants } from 'framer-motion';
import { assetUrl } from '../shared/assets';
import { read, write } from './storage';
import type { RevealCue } from './race-audio';

/**
 * What's new, shown once per player: after the loading screen hands over to the menu the first time this update is
 * seen (remembered on this device). The reveal is a desert evening on the highway: a warm horizon line draws across
 * the frame, headlights streak along it both ways with a whoosh each, the sun flares at its middle, and the picture
 * opens out of the horizon like a widescreen film. Amber and dusk light keep washing the card's edges.
 *
 * Bump UPDATE.id for the next update; add ?update to the address to see it again. (Racing City's card, before this
 * one, revealed through a police lightbar; it is in the history.)
 */
const UPDATE = {
  id: 'endless-highway-2026-10',
  date: 'October 2026',
  image: 'art/update-endless-highway.jpg',
  alt: 'A blue Bugatti Bolide heads down a six-lane desert highway at golden hour, traffic and mesas behind it.',
  heading: 'The Endless Highway',
  summary: 'Three lanes each way through the high desert, built as you drive, so the road never ends. Cruise in whatever traffic you like, or see how far you get before you crash.',
  features: [
    { name: 'Cruise', detail: 'Traffic from empty to rush hour, at up to 160 mph. Change it any time with Esc.' },
    { name: 'Survival', detail: 'Distance until a real crash. Traffic builds as you go. Stay above 40 mph, off the shoulder.' },
    { name: 'Any hour', detail: 'Noon, golden hour or night, clear or rain. L for headlights.' },
  ],
};

/** One signature curve for the card: fast out, long settle. */
const SETTLE = [.16, 1, .3, 1] as const;

/**
 * The reveal's timeline, in seconds after the card opens. The horizon draws across, four sets of headlights race
 * along it (each a little sooner than the last), the sun flares, and the picture opens out of the line with a hit.
 */
const LINE_AT = .45;
const PASSES = [1.05, 1.5, 1.86, 2.14].map((at, i) => ({ at, from: i % 2 ? 1 : -1 }));
const FLARE_AT = 2.42, OPEN_AT = FLARE_AT + .2;
const SWEEP = .62;

/** The sounds, on the same clock (src/race-audio.ts, RaceAudio.reveal). */
const CUES: [number, RevealCue, number?][] = [
  [LINE_AT, 'power'],
  ...PASSES.map((pass, i) => [pass.at + SWEEP * .3, 'pass', i] as [number, RevealCue, number]),
  [FLARE_AT - .9, 'riser', .9 + .2],
  [OPEN_AT, 'hit'],
  [OPEN_AT + .55, 'stamp'],
  [OPEN_AT + 1.05, 'shimmer'],
  ...Array.from({ length: 6 }, (_, i) => [OPEN_AT + .75 + i * .1, 'tick', i] as [number, RevealCue, number]),
];

const card: Variants = {
  hidden: { opacity: 0, y: 46, scale: .955, rotateX: 7 },
  shown: { opacity: 1, y: 0, scale: 1, rotateX: 0, transition: { type: 'spring', stiffness: 150, damping: 24, mass: 1 } },
  gone: { opacity: 0, y: 18, scale: .97, transition: { duration: .24, ease: [.4, 0, 1, 1] } },
};
const content: Variants = { hidden: {}, shown: { transition: { delayChildren: OPEN_AT + .75, staggerChildren: .1 } } };
const rise: Variants = {
  hidden: { opacity: 0, y: 18, filter: 'blur(6px)' },
  shown: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { duration: .75, ease: SETTLE } },
};

export function UpdateCard({ onExplore, sound }: { onExplore: () => void; sound?: (cue: RevealCue, index?: number) => void }) {
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
    const key = (event: KeyboardEvent) => { event.stopPropagation(); if (event.key === 'Escape') { sound?.('close'); setOpen(false); } };
    // The reveal's sounds, cancelled if the card is closed part way through.
    const timers = reduced ? [] : CUES.map(([at, cue, index]) => window.setTimeout(() => sound?.(cue, index), at * 1000));
    window.addEventListener('keydown', key, true);
    // Focus moves into the card (not onto a button, so no focus ring shows until someone uses the keyboard).
    dialog.current?.focus({ preventScroll: true });
    return () => { window.removeEventListener('keydown', key, true); timers.forEach(clearTimeout); };
  }, [open, reduced]);

  const close = () => { sound?.('close'); setOpen(false); };
  const explore = () => { sound?.('go'); setOpen(false); onExplore(); };

  return <AnimatePresence>{open && <motion.div key="update" className="update-scrim" role="presentation" onClick={close}
    initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { duration: .45 } }} exit={{ opacity: 0, transition: { duration: .28, delay: .05 } }}>
    {/* Headlights and the setting sun light the room, then amber and dusk keep washing in turn round the card. */}
    {!reduced && <>
      <motion.i className="update-wash is-amber" aria-hidden="true" initial={{ opacity: 0 }} animate={{ opacity: [0, .25, .12, .3, .15, .7, .2] }} transition={{ delay: LINE_AT, duration: OPEN_AT - LINE_AT + .6, times: [0, .25, .4, .55, .7, .86, 1], ease: 'easeOut' }} />
      <motion.i className="update-wash is-dusk" aria-hidden="true" initial={{ opacity: 0 }} animate={{ opacity: [0, .12, .3, .14, .32, .45, .18] }} transition={{ delay: LINE_AT, duration: OPEN_AT - LINE_AT + .6, times: [0, .25, .4, .55, .7, .86, 1], ease: 'easeOut' }} />
      <motion.div aria-hidden="true" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: OPEN_AT + .1, duration: 1 }}>
        <motion.i className="update-wash is-amber" animate={{ opacity: [.14, .4, .14] }} transition={{ duration: 4.2, repeat: Infinity, ease: 'easeInOut' }} />
        <motion.i className="update-wash is-dusk" animate={{ opacity: [.3, .12, .3] }} transition={{ duration: 4.2, repeat: Infinity, ease: 'easeInOut' }} />
      </motion.div>
    </>}
    <motion.section ref={dialog} tabIndex={-1} className="update-card" role="dialog" aria-modal="true" aria-labelledby="update-heading" onClick={event => event.stopPropagation()}
      variants={reduced ? undefined : card} initial={reduced ? { opacity: 0 } : 'hidden'} animate={reduced ? { opacity: 1 } : 'shown'} exit={reduced ? { opacity: 0 } : 'gone'}>

      <motion.div className="update-frame" initial={false} animate={reduced ? undefined : { y: [0, 0, -4, 3, -1, 0] }} transition={{ delay: OPEN_AT - .02, duration: .45, times: [0, .05, .25, .5, .75, 1], ease: 'easeOut' }}>
        {/* The picture opens out of the horizon line, top and bottom edges parting like a widescreen film. */}
        <motion.div className="update-film"
          initial={reduced ? false : { clipPath: 'inset(49.4% 0% 49.4% 0%)' }}
          animate={{ clipPath: 'inset(0% 0% 0% 0%)', transition: { delay: OPEN_AT - .08, duration: 1.25, ease: [.7, 0, .2, 1] } }}>
          <motion.img src={assetUrl(UPDATE.image)} alt={UPDATE.alt}
            initial={reduced ? false : { scale: 1.16, filter: 'brightness(.55) saturate(.7)' }}
            animate={{ scale: 1, filter: 'brightness(1) saturate(1)', transition: { delay: OPEN_AT - .08, duration: 2.8, ease: SETTLE } }} />
          {/* One pass of light across the picture once it is open. */}
          {!reduced && <motion.i className="update-sweep" aria-hidden="true" initial={{ x: '-130%', opacity: 0 }} animate={{ x: '560%', opacity: [0, 1, 1, 0] }} transition={{ delay: OPEN_AT + 1.05, duration: 1.5, ease: [.45, 0, .2, 1], opacity: { delay: OPEN_AT + 1.05, duration: 1.5, times: [0, .12, .8, 1] } }} />}
        </motion.div>
        {!reduced && <motion.div className="update-horizon" aria-hidden="true"
          initial={{ scaleX: 0, opacity: 1 }}
          animate={{ scaleX: [0, 1, 1, 1.04], opacity: [1, 1, 1, 0] }}
          transition={{ delay: LINE_AT, duration: OPEN_AT + .3 - LINE_AT, times: [0, .6 / (OPEN_AT + .3 - LINE_AT), (OPEN_AT - LINE_AT) / (OPEN_AT + .3 - LINE_AT), 1], ease: [SETTLE, 'linear', 'easeIn'] }}>
          {/* Headlights racing along the horizon, alternately from each side. */}
          {PASSES.map((pass, i) => <motion.i key={i} className="update-streak" initial={{ x: `${pass.from * 70}vw`, opacity: 0 }}
            animate={{ x: `${-pass.from * 70}vw`, opacity: [0, 1, 1, 0] }} transition={{ delay: pass.at, duration: SWEEP, ease: [.5, 0, .5, 1], opacity: { delay: pass.at, duration: SWEEP, times: [0, .2, .8, 1] } }} />)}
          {/* The sun on the horizon, flaring just before the picture opens. */}
          <motion.i className="update-sun" initial={{ scale: 0, opacity: 0 }} animate={{ scale: [0, .5, 1.6], opacity: [0, .9, 1] }} transition={{ delay: FLARE_AT - .5, duration: .7, times: [0, .6, 1], ease: 'easeIn' }} />
        </motion.div>}
        <motion.span className="update-stamp" initial={reduced ? false : { opacity: 0, x: 14 }} animate={{ opacity: 1, x: 0, transition: { delay: OPEN_AT + .55, duration: .6, ease: SETTLE } }}>
          New update<b>{UPDATE.date}</b>
        </motion.span>
      </motion.div>

      <motion.div className="update-body" variants={reduced ? undefined : content} initial={reduced ? false : 'hidden'} animate="shown">
        <div className="update-lead">
          <motion.h2 id="update-heading" variants={rise}>{UPDATE.heading}</motion.h2>
          <motion.p variants={rise}>{UPDATE.summary}</motion.p>
          <motion.div className="update-actions" variants={rise}>
            <motion.button className="update-go" onClick={explore} whileHover={reduced ? undefined : { y: -2 }} whileTap={{ scale: .97 }}>
              Take me to the highway
              <motion.svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" animate={reduced ? undefined : { x: [0, 4, 0] }} transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut', delay: OPEN_AT + 2 }}>
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
