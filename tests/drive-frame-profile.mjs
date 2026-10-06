// Frame time while really driving a lap (game loop, effects, sound, real car), split by speed:
//   node tests/drive-frame-profile.mjs [trackId] [carId] [seconds]
// Starts a private Vite (no watcher). Uses installed Chrome with the GPU.
import { chromium } from '@playwright/test';
const [trackId = 'daytona', carId = 'red-bull-rb19', seconds = '50'] = process.argv.slice(2);
const { createServer } = await import('vite');
const vite = await createServer({ logLevel: 'warn', cacheDir: 'node_modules/.vite-smooth-visual-audit', server: { host: '127.0.0.1', port: 5199, strictPort: false, watch: null, hmr: false } });
await vite.listen(); const base = vite.resolvedUrls.local[0];
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1470, height: 920 }, deviceScaleFactor: 2 });
page.on('pageerror', e => console.log('pageerror', e.message));
await page.goto(base);
await page.waitForFunction(() => window.__apex?.state.modelReady, null, { timeout: 180000 });
const result = await page.evaluate(async ({ trackId, carId, seconds }) => {
  const g = window.__apex, w = g.world;
  const { TRACKS } = await import('/shared/tracks.ts'), R = await import('/tests/smooth-route.ts');
  const track = TRACKS.find(t => t.id === trackId);
  await g.selectCar(carId); await g.select(track, true); await w.venueReady;
  g.pause = () => {}; g.start(false);
  const route = R.buildRoute(track), driver = new R.RouteDriver(route, R.speedProfile(route, carId)); driver.start(g.sim);
  g.input = () => driver.input(g.sim); g.awaitingPedal = false; g.keys.add('KeyW');
  const prof = {}, wrap = (obj, name, label) => { const f = obj[name].bind(obj); obj[name] = (...a) => { const s = performance.now(); try { return f(...a); } finally { (prof[label] ??= []).push(performance.now() - s); } }; };
  wrap(w, 'render', 'render'); wrap(w, 'chase', 'chase'); wrap(g.sim, 'step', 'sim'); wrap(w.skidMarks, 'update', 'skid');
  await new Promise(r => setTimeout(r, 2000));
  const bands = {}; let last = performance.now(), run = true;
  const loop = n => { const mph = g.sim.speed * track.metersPerUnit * 2.237, b = Math.min(5, Math.floor(mph / 40)) * 40; (bands[b] ??= []).push(n - last); last = n; if (run) requestAnimationFrame(loop); };
  for (const k of Object.keys(prof)) prof[k] = [];
  requestAnimationFrame(loop);
  await new Promise(r => setTimeout(r, seconds * 1000)); run = false;
  const stat = l => { const s = [...l].sort((a, b) => a - b); return { n: s.length, avg: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2), p95: +s[Math.floor(s.length * .95)].toFixed(1), max: +s.at(-1).toFixed(1) }; };
  return { bands: Object.fromEntries(Object.entries(bands).map(([k, v]) => [`${k}+ mph`, stat(v)])), parts: Object.fromEntries(Object.entries(prof).filter(([, v]) => v.length).map(([k, v]) => [k, stat(v)])), calls: w.renderer.info.render.calls, tris: w.renderer.info.render.triangles, ratio: w.renderer.getPixelRatio() };
}, { trackId, carId, seconds: +seconds });
console.log(JSON.stringify(result, null, 1));
await browser.close(); await vite.close();
