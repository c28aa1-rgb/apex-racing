// Real-driving frame profile in a visible Chrome window: `node tests/drive-profile-browser.mjs [track] [car] [chase|cockpit] [weather] [quality]`
// (needs `npm run dev`). Holds throttle with real physics, sound, skid marks and HUD, and weaves left/right.
import { chromium } from '@playwright/test';
const [track = 'spa', car = 'ferrari-488-gt3', view = 'chase', weather = 'clear', quality = 'balanced', seconds = '30'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: !!process.env.HEADLESS, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage({ viewport: { width: 1470, height: 920 }, deviceScaleFactor: 2 });
  page.on('pageerror', e => console.log('pageerror', e.message));
  await page.goto('http://127.0.0.1:5173/');
  await page.waitForFunction(() => window.__apex?.state.trackReady, null, { timeout: 90000 });
  await page.evaluate(async ({ track, car, weather, quality }) => {
    const g = window.__apex;
    // Import the exact module instance Vite served the app, so track objects match.
    const urls = performance.getEntriesByType('resource').map(e => e.name).filter(u => u.includes('/shared/tracks.ts')).sort((a, b) => b.length - a.length);
    const u = new URL(urls[0]); const { TRACKS } = await import(u.pathname + u.search);
    if (!TRACKS.find(t => t.id === track)) throw new Error('unknown track ' + track + ': ' + TRACKS.map(t => t.id).join(','));
    g.career.xp = 1e7; g.setSettings({ weather, graphicsQuality: quality, pointerLock: false });
    await g.selectCar(car); await g.select(TRACKS.find(t => t.id === track)); await g.world.venueReady;
    await new Promise(r => { const t = setInterval(() => { if (g.state.modelReady && g.state.trackReady) { clearInterval(t); r(); } }, 100); });
  }, { track, car, weather, quality });
  await page.evaluate(view => { const g = window.__apex; g.start(false); if (view === 'cockpit' && !g.world.firstPerson) g.toggleCamera(); }, view);
  // Drive through the game's own key set; window focus is not guaranteed in automation.
  await page.evaluate(() => { const g = window.__apex, keys = g.keys; keys.add('KeyW'); window.__weave = setInterval(() => { const k = Math.random() < .5 ? 'KeyA' : 'KeyD'; keys.add(k); setTimeout(() => keys.delete(k), 350); }, 1200); setInterval(() => { if (g.state.speed < 5 && g.state.mode === 'racing') g.recover(); }, 4000); });
  const steer = 0;
  const result = await page.evaluate(async seconds => {
    const g = window.__apex, w = g.world, prof = {};
    const wrap = (obj, name, label) => { const f = obj[name].bind(obj); obj[name] = function (...a) { const s = performance.now(); try { return f(...a); } finally { const d = performance.now() - s; const p = prof[label] ??= { n: 0, t: 0, max: 0 }; p.n++; p.t += d; p.max = Math.max(p.max, d); } }; };
    wrap(w, 'render', 'render'); wrap(w, 'chase', 'chase'); wrap(g.sim, 'step', 'sim'); wrap(w.skidMarks, 'update', 'skid');
    const long = []; new PerformanceObserver(l => l.getEntries().forEach(e => long.push(Math.round(e.duration)))).observe({ type: 'longtask' });
    const deltas = []; let last = performance.now(); const end = last + seconds * 1000;
    await new Promise(r => { window.__maxSpeed = 0; const tick = now => { window.__maxSpeed = Math.max(window.__maxSpeed, g.state.speed); deltas.push(now - last); last = now; if (now < end) requestAnimationFrame(tick); else r(); }; requestAnimationFrame(tick); });
    const sorted = [...deltas].sort((a, b) => a - b), q = p => sorted[Math.floor(sorted.length * p)].toFixed(1);
    const info = w.renderer.info.render;
    return { fps: (deltas.length / seconds).toFixed(1), p50: q(.5), p95: q(.95), p99: q(.99), max: sorted.at(-1).toFixed(0), over33: deltas.filter(d => d > 34).length, over50: deltas.filter(d => d > 50).length, longTasks: long.length, longMax: Math.max(0, ...long), mode: g.state.mode, speed: g.state.speed, maxSpeed: window.__maxSpeed, ratio: w.renderer.getPixelRatio(), calls: info.calls, tris: info.triangles, prof: Object.fromEntries(Object.entries(prof).map(([k, v]) => [k, { avg: +(v.t / v.n).toFixed(2), max: +v.max.toFixed(1) }])) };
  }, +seconds);
  clearInterval(steer);
  console.log(JSON.stringify({ track, car, view, weather, quality, ...result }));
} finally { await browser.close(); }
