import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion, type Variants } from 'framer-motion';
import { assetUrl } from '../shared/assets';
import { read, write } from './storage';
import type { RevealCue } from './race-audio';

/**
 * What's new, shown once per player: after the loading screen hands over to the menu the first time this update is
 * seen (remembered on this device). The reveal borrows the city's police roadblocks: a thin red-and-blue lightbar strobes,
 * the picture opens out of it like a widescreen film, and the lightbar's colours keep washing the card's edges.
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

/**
 * The reveal's timeline, in seconds after the card opens. The lightbar stretches across the frame, strobes like a
 * patrol car's (three red, three blue, twice over), flares, and the picture opens out of it with a hit.
 */
const BAR_AT = .45, STROBE_AT = 1.15, GROUP = .38, FLASH = .1, GROUPS = 4;
const FLARE_AT = STROBE_AT + GROUPS * GROUP, OPEN_AT = FLARE_AT + .14;
const FLASHES = Array.from({ length: GROUPS * 3 }, (_, i) => ({ at: STROBE_AT + Math.floor(i / 3) * GROUP + i % 3 * FLASH, side: Math.floor(i / 3) % 2 }));

/** Opacity keyframes for one lamp (0 red, 1 blue) over the lightbar's life, BAR_AT to OPEN_AT: snapping on and off. */
function lamp(side: number, low: number, high: number) {
  const points: [number, number][] = [[BAR_AT, high], [STROBE_AT - .03, high], [STROBE_AT, low]];
  for (const flash of FLASHES) if (flash.side === side) points.push([flash.at, low], [flash.at + .005, high], [flash.at + .06, high], [flash.at + .065, low]);
  points.push([FLARE_AT, low], [FLARE_AT + .005, high], [OPEN_AT, high]);
  return { opacity: points.map(p => p[1]), times: points.map(p => (p[0] - BAR_AT) / (OPEN_AT - BAR_AT)) };
}
const LAMPS = [lamp(0, .22, 1), lamp(1, .22, 1)];
const WASHES = [lamp(0, 0, .55), lamp(1, 0, .5)];
const strobe = (keys: { times: number[] }) => ({ delay: BAR_AT, duration: OPEN_AT - BAR_AT, times: keys.times, ease: 'linear' as const });

/** The sounds, on the same clock (src/race-audio.ts, RaceAudio.reveal). */
const CUES: [number, RevealCue, number?][] = [
  [BAR_AT, 'power'],
  ...FLASHES.map(flash => [flash.at, 'flash', flash.side] as [number, RevealCue, number]),
  [STROBE_AT, 'chirp'], [STROBE_AT + GROUP, 'chirp'],
  [FLARE_AT - .95, 'riser', .95 + .14],
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
    {/* The lightbar's strobes light the room, then its red and blue keep washing in turn round the card. */}
    {!reduced && <>
      <motion.i className="update-wash is-red" aria-hidden="true" initial={{ opacity: 0 }} animate={{ opacity: [...WASHES[0].opacity, 0] }} transition={{ ...strobe(WASHES[0]), duration: OPEN_AT - BAR_AT + .5, times: [...WASHES[0].times.map(t => t * (OPEN_AT - BAR_AT) / (OPEN_AT - BAR_AT + .5)), 1] }} />
      <motion.i className="update-wash is-blue" aria-hidden="true" initial={{ opacity: 0 }} animate={{ opacity: [...WASHES[1].opacity, 0] }} transition={{ ...strobe(WASHES[1]), duration: OPEN_AT - BAR_AT + .5, times: [...WASHES[1].times.map(t => t * (OPEN_AT - BAR_AT) / (OPEN_AT - BAR_AT + .5)), 1] }} />
      <motion.div aria-hidden="true" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: OPEN_AT + .1, duration: 1 }}>
        <motion.i className="update-wash is-red" animate={{ opacity: [.12, .42, .12, .12, .3, .12] }} transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut', times: [0, .12, .3, .5, .62, 1] }} />
        <motion.i className="update-wash is-blue" animate={{ opacity: [.12, .12, .4, .12, .12, .3] }} transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut', times: [0, .3, .42, .6, .8, .92] }} />
      </motion.div>
    </>}
    <motion.section ref={dialog} tabIndex={-1} className="update-card" role="dialog" aria-modal="true" aria-labelledby="update-heading" onClick={event => event.stopPropagation()}
      variants={reduced ? undefined : card} initial={reduced ? { opacity: 0 } : 'hidden'} animate={reduced ? { opacity: 1 } : 'shown'} exit={reduced ? { opacity: 0 } : 'gone'}>

      <motion.div className="update-frame" initial={false} animate={reduced ? undefined : { y: [0, 0, -4, 3, -1, 0] }} transition={{ delay: OPEN_AT - .02, duration: .45, times: [0, .05, .25, .5, .75, 1], ease: 'easeOut' }}>
        {/* The picture opens out of a thin lightbar, top and bottom edges parting like a widescreen film. */}
        <motion.div className="update-film"
          initial={reduced ? false : { clipPath: 'inset(49.4% 0% 49.4% 0%)' }}
          animate={{ clipPath: 'inset(0% 0% 0% 0%)', transition: { delay: OPEN_AT - .08, duration: 1.25, ease: [.7, 0, .2, 1] } }}>
          <motion.img src={assetUrl(UPDATE.image)} alt="A blue Bugatti Bolide at sunset in Racing City, police cars blocking the street behind it."
            initial={reduced ? false : { scale: 1.16, filter: 'brightness(.55) saturate(.7)' }}
            animate={{ scale: 1, filter: 'brightness(1) saturate(1)', transition: { delay: OPEN_AT - .08, duration: 2.8, ease: SETTLE } }} />
          {/* One pass of light across the picture once it is open. */}
          {!reduced && <motion.i className="update-sweep" aria-hidden="true" initial={{ x: '-130%', opacity: 0 }} animate={{ x: '560%', opacity: [0, 1, 1, 0] }} transition={{ delay: OPEN_AT + 1.05, duration: 1.5, ease: [.45, 0, .2, 1], opacity: { delay: OPEN_AT + 1.05, duration: 1.5, times: [0, .12, .8, 1] } }} />}
        </motion.div>
        {!reduced && <motion.div className="update-lightbar" aria-hidden="true"
          initial={{ scaleX: 0, opacity: 1 }}
          animate={{ scaleX: [0, 1, 1, 1.04], opacity: [1, 1, 1, 0] }}
          transition={{ delay: BAR_AT, duration: OPEN_AT + .3 - BAR_AT, times: [0, .6 / (OPEN_AT + .3 - BAR_AT), (OPEN_AT - BAR_AT) / (OPEN_AT + .3 - BAR_AT), 1], ease: [SETTLE, 'linear', 'easeIn'] }}>
          <motion.i className="is-red" initial={{ opacity: 1 }} animate={{ opacity: LAMPS[0].opacity }} transition={strobe(LAMPS[0])} />
          <motion.i className="is-blue" initial={{ opacity: 1 }} animate={{ opacity: LAMPS[1].opacity }} transition={strobe(LAMPS[1])} />
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
              Take me to free roam
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
