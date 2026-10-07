import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useMotionValue, useReducedMotion } from 'framer-motion';
import { assetUrl } from '../shared/assets';
import { loadSettings } from './settings';
import { read } from './storage';

/** Trailer clips shown while the game boots. Captions name what is on screen. */
const CLIPS = [
  { id: 'mclaren-pit', car: 'McLaren 720S GT3', place: 'Pit lane' },
  { id: 'bugatti-launch', car: 'Bugatti Bolide', place: 'Spa-Francorchamps' },
  { id: 'ferrari-wheel', car: 'Ferrari 488 GT3', place: 'Marina Bay' },
  { id: 'overtake', car: 'Ferrari 488 GT3', place: 'Marina Bay' },
  { id: 'finish', car: 'Bugatti Bolide', place: 'Marina Bay' },
  { id: 'celica-barcelona', car: 'Celica GT-Four', place: 'Barcelona-Catalunya' },
  { id: 'hungaroring', car: 'Porsche 963', place: 'Hungaroring' },
  { id: 'rb19-indy', car: 'Red Bull RB19', place: 'Indianapolis' },
  { id: 'mazda-787b', car: 'Mazda 787B', place: 'Close up' },
  { id: 'night-prototype', car: 'Peugeot 9X8', place: 'Marina Bay at night' },
] as const;
const MIN_MS = 5000;
/** Seconds the bar takes to run from its stall to full. */
const RUSH = .45;

/** Waypoints [seconds, fraction] with small random variation, so no two loads look the same. */
function loadingSteps(): [number, number][] {
  const r = () => Math.random();
  return [[0, 0], [.3 + r() * .2, .12 + r() * .07], [.95 + r() * .3, .22 + r() * .06], [1.35 + r() * .25, .36 + r() * .05],
    [2.05 + r() * .3, .57 + r() * .06], [MIN_MS / 1000 - RUSH, .63 + r() * .04]];
}
/** Position along the waypoints; each step starts fast and settles, like a file finishing. */
function along(steps: [number, number][], t: number) {
  for (let i = 1; i < steps.length; i++) {
    const [t0, v0] = steps[i - 1], [t1, v1] = steps[i];
    if (t <= t1) { const k = (t - t0) / (t1 - t0); return v0 + (v1 - v0) * (1 - Math.pow(1 - k, 3)); }
  }
  return steps[steps.length - 1][1];
}
const ease = [.2, .8, .2, 1] as const;
const src = (id: string, ext: 'mp4' | 'jpg') => assetUrl(`video/loading/${id}.${ext}`);

const MUSIC_EXT = (() => { try { return document.createElement('audio').canPlayType('audio/ogg; codecs="vorbis"') ? 'ogg' : 'm4a'; } catch { return 'ogg'; } })();

/**
 * Menu soundtrack for the boot screen. Browsers only allow sound after a click or key press, so it
 * tries to start straight away and otherwise starts on the first one. Respects the saved music volume
 * and mute. Fades out when `leaving` turns true; the menu's own music fades in as the screen wipes away.
 */
function useLoadingMusic(leaving: boolean) {
  const audio = useRef<HTMLAudioElement | undefined>(undefined);
  useEffect(() => {
    const settings = loadSettings(), level = settings.volume * settings.musicVolume * .6;
    if (read('muted', false) || level <= 0) return;
    const el = audio.current = new Audio(); if (import.meta.env.DEV) (window as unknown as { __loadingAudio?: HTMLAudioElement }).__loadingAudio = el; el.volume = Math.min(1, level * 1.6); let live = true, tracks: string[] = [];
    const next = () => { if (tracks.length) el.src = assetUrl(`audio/music/${tracks[Math.floor(Math.random() * tracks.length)]}.${MUSIC_EXT}`); };
    const play = () => { void el.play().then(() => { for (const e of ['pointerdown', 'keydown'] as const) removeEventListener(e, play, true); }).catch(() => {}); };
    el.addEventListener('ended', () => { next(); play(); });
    el.addEventListener('error', () => { if (live) { next(); play(); } });
    fetch(assetUrl('audio/music/playlist.json')).then(r => r.ok ? r.json() : []).then((list: { file?: string }[]) => {
      if (!live) return; tracks = list.map(t => t.file).filter((f): f is string => typeof f === 'string'); next(); play();
    }).catch(() => {});
    for (const e of ['pointerdown', 'keydown'] as const) addEventListener(e, play, true);
    return () => { live = false; for (const e of ['pointerdown', 'keydown'] as const) removeEventListener(e, play, true); el.pause(); el.removeAttribute('src'); };
  }, []);
  useEffect(() => {
    const el = audio.current; if (!leaving || !el) return;
    const from = el.volume, start = performance.now(); let frame = 0;
    const fade = () => { const k = Math.min(1, (performance.now() - start) / 700); el.volume = from * (1 - k); if (k < 1) frame = requestAnimationFrame(fade); };
    frame = requestAnimationFrame(fade); return () => cancelAnimationFrame(frame);
  }, [leaving]);
}

/** Random order every visit, never opening on the clip that opened the previous visit. */
function shuffled() {
  const order = CLIPS.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  try {
    const last = localStorage.getItem('apex:reel-start');
    if (order.length > 1 && CLIPS[order[0]].id === last) order.push(order.shift()!);
    localStorage.setItem('apex:reel-start', CLIPS[order[0]].id);
  } catch { /* Storage can be unavailable; the shuffle alone still varies the opening clip. */ }
  return order;
}

/**
 * Boot screen: trailer clips cycle behind the APEX Racing title while the engine starts.
 * The bar fills over at least five seconds, then becomes the Continue button.
 */
export function LoadingScreen({ ready, onContinue }: { ready: Promise<unknown>; onContinue: () => void }) {
  const reduced = !!useReducedMotion();
  const order = useMemo(shuffled, []);
  const [slot, setSlot] = useState(0);
  const [booted, setBooted] = useState(false);
  const fill = useMotionValue(0);
  const [percent, setPercent] = useState(0);
  const [leaving, setLeaving] = useState(false);
  useLoadingMusic(leaving);
  const clip = CLIPS[order[slot % order.length]], next = CLIPS[order[(slot + 1) % order.length]];
  const done = booted && percent >= 100;

  useEffect(() => { let live = true; ready.then(() => live && setBooted(true), () => live && setBooted(true)); return () => { live = false; }; }, [ready]);
  // The bar moves like real loading: bursts, a stall near 60%, then a fast finish at five seconds.
  // If the engine is still starting, it creeps toward 90% and finishes once it is ready.
  const steps = useMemo(loadingSteps, []), bootedRef = useRef(false);
  bootedRef.current = booted;
  useEffect(() => {
    const start = performance.now(), stall = steps[steps.length - 1]; let frame = 0, rush: { t: number; v: number } | undefined;
    const tick = () => {
      const t = (performance.now() - start) / 1000;
      let value: number;
      if (t < stall[0]) value = along(steps, t);
      else if (!bootedRef.current) value = stall[1] + (.9 - stall[1]) * (1 - Math.exp(-(t - stall[0]) / 8));
      else {
        rush ??= { t: Math.max(t, MIN_MS / 1000 - RUSH), v: fill.get() };
        const k = Math.min(1, Math.max(0, (t - rush.t) / RUSH));
        value = rush.v + (1 - rush.v) * k * k * (3 - 2 * k);
      }
      value = Math.max(fill.get(), value);
      fill.set(value); setPercent(Math.floor(value * 100));
      if (value < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame);
  }, [fill, steps]);
  // Reduced motion: still posters change on a timer instead of playing video.
  useEffect(() => { if (!reduced) return; const id = setInterval(() => setSlot(s => s + 1), 4500); return () => clearInterval(id); }, [reduced]);
  const advance = useCallback(() => setSlot(s => s + 1), []);
  const go = () => { if (!done || leaving) return; setLeaving(true); };
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (done && (e.code === 'Enter' || e.code === 'Space')) { e.preventDefault(); e.stopPropagation(); go(); } };
    addEventListener('keydown', key, true); return () => removeEventListener('keydown', key, true);
  });

  return <AnimatePresence onExitComplete={onContinue}>{!leaving && <motion.section key="loading" className="loading-screen" aria-label="Loading APEX Racing"
    exit={reduced ? { opacity: 0, transition: { duration: .25 } } : { clipPath: 'inset(0 0 100% 0)', transition: { duration: .7, ease: [.7, 0, .2, 1] } }}>
    <div className="loading-reel" aria-hidden="true">
      <AnimatePresence initial={false}>
        <motion.div key={slot} className="loading-clip" initial={{ opacity: 0, scale: reduced ? 1 : 1.06 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
          transition={{ opacity: { duration: .7, ease: 'easeInOut' }, scale: { duration: 5, ease: 'linear' } }}>
          {reduced ? <img src={src(clip.id, 'jpg')} alt="" /> : <Clip id={clip.id} onEnded={advance} />}
        </motion.div>
      </AnimatePresence>
      {/* Warm the next clip so the cut never waits on the network. */}
      {!reduced && <link rel="preload" as="image" href={src(next.id, 'jpg')} />}
      {!reduced && <video key={`next-${next.id}`} className="loading-preload" src={src(next.id, 'mp4')} preload="auto" muted playsInline />}
    </div>
    <header className="loading-title">
      <motion.h1 initial={{ opacity: 0, y: reduced ? 0 : -16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .7, delay: .15, ease }}>
        APEX<span> / </span>Racing
      </motion.h1>
    </header>
    <AnimatePresence mode="wait" initial={false}>
      <motion.p key={slot} className="loading-caption" initial={{ opacity: 0, x: reduced ? 0 : 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: reduced ? 0 : -8 }} transition={{ duration: .35, ease }}>
        <strong>{clip.car}</strong><span>{clip.place}</span>
      </motion.p>
    </AnimatePresence>
    <footer className="loading-footer">
      <AnimatePresence mode="popLayout" initial={false}>
        {done
          ? <motion.button key="continue" layoutId="loading-control" className="loading-continue" onClick={go} autoFocus
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} whileHover={{ scale: reduced ? 1 : 1.02 }} whileTap={{ scale: reduced ? 1 : .98 }}
              transition={{ layout: { duration: reduced ? 0 : .55, ease }, opacity: { duration: .3, delay: reduced ? 0 : .2 } }}>
              <span>Continue to game</span><kbd>Enter</kbd>
            </motion.button>
          : <motion.div key="bar" layoutId="loading-control" className="loading-bar" role="progressbar" aria-label="Loading" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
              transition={{ layout: { duration: reduced ? 0 : .55, ease } }}>
              <motion.i style={{ scaleX: fill }} />
            </motion.div>}
      </AnimatePresence>
      <motion.small className="loading-status" animate={{ opacity: done ? 0 : 1 }}>{booted ? 'Ready' : 'Loading'} · {percent}%</motion.small>
    </footer>
  </motion.section>}</AnimatePresence>;
}

/** One muted clip. Moving on when it ends cycles the reel indefinitely. */
function Clip({ id, onEnded }: { id: string; onEnded: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  // Autoplay can be refused; the poster stays up and a timer keeps the reel moving.
  useEffect(() => { const v = ref.current; if (!v) return; v.play().catch(() => {}); const id = setTimeout(onEnded, 8000); return () => clearTimeout(id); }, [onEnded]);
  return <video ref={ref} src={src(id, 'mp4')} poster={src(id, 'jpg')} muted playsInline autoPlay preload="auto" onEnded={onEnded} />;
}
