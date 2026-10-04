// Frame-time profile of a full lap: run `npm run dev`, then
// `node tests/frame-profile-browser.mjs <trackId> [width] [height]` (CPU=1 adds a CPU profile).
// Uses installed Chrome with the real GPU and flies the race camera around the circuit.
import { chromium } from '@playwright/test';
const [trackId = 'spa', width = '1512', height = '945'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: +width, height: +height }, deviceScaleFactor: 2 });
page.on('pageerror', e => console.log('pageerror', e.message));
await page.goto('http://127.0.0.1:5173/' + (process.env.Q ?? ''));
const cdp = await page.context().newCDPSession(page);
if (process.env.CPU) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); }
page.on('console', m => { if (m.text() === '__startprofile' && process.env.CPU) cdp.send('Profiler.start'); });
await page.waitForFunction(() => window.__apex, null, { timeout: 60000 });
const result = await page.evaluate(async (trackId) => {
  const g = window.__apex, w = g.world;
  const urls = performance.getEntriesByType('resource').map(e => e.name);
  const pick = n => { const u = new URL(urls.filter(u => u.includes('/shared/' + n + '.ts')).sort((a, b) => b.length - a.length)[0]); return u.pathname + u.search; };
  const { TRACKS } = await import(pick('tracks'));
  const track = TRACKS.find(t => t.id === trackId);
  let t = performance.now(); await g.select(track); const selectMs = performance.now() - t;
  t = performance.now(); await w.venueReady; const venueMs = performance.now() - t;
  await new Promise(r => setTimeout(r, 1500));
  const prof = {}, slow = [], long = []; const t0 = performance.now();
  const wrap = (obj, name, label) => { const f = obj[name].bind(obj); obj[name] = function (...a) { const s = performance.now(); try { return f(...a); } finally { const d = performance.now() - s; const p = prof[label] ??= { n: 0, t: 0, max: 0, big: [] }; p.n++; p.t += d; p.max = Math.max(p.max, d); if (d > 12) p.big.push([Math.round(s - t0), Math.round(d)]); } }; };
  new PerformanceObserver(l => l.getEntries().forEach(e => long.push([Math.round(e.startTime - t0), Math.round(e.duration)]))).observe({ type: 'longtask' });
  console.log('__startprofile'); await new Promise(r => setTimeout(r, 300));
  wrap(g, 'start', 'start'); g.start(false);
  wrap(w, 'render', 'render'); wrap(w, 'chase', 'chase'); wrap(g.sim, 'step', 'sim');
  // Fly the chase camera along the circuit so every part of the venue is drawn.
  const path = track.mapPath?.length ? track.mapPath : [track.segments[0].start, ...track.segments.map(s => s.end)];
  let along = 0; const total = path.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - path[i].x, p.z - path[i].z), 0);
  const chase = w.chase.bind(w);
  w.chase = function (sim, dt, ...rest) {
    along = Math.min(total - 1, along + 75 * dt); let d = along, i = 0;
    while (i < path.length - 2 && d > Math.hypot(path[i + 1].x - path[i].x, path[i + 1].z - path[i].z)) { d -= Math.hypot(path[i + 1].x - path[i].x, path[i + 1].z - path[i].z); i++; }
    const a = path[i], b = path[i + 1], l = Math.hypot(b.x - a.x, b.z - a.z) || 1, k = d / l;
    const p = { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k };
    const frame = { p: { x: p.x, y: p.y + 1, z: p.z }, q: { x: 0, y: Math.sin(Math.atan2(b.x - a.x, b.z - a.z) / 2), z: 0, w: Math.cos(Math.atan2(b.x - a.x, b.z - a.z) / 2) } };
    return chase(sim, dt, rest[0], frame, ...rest.slice(2));
  };
  g.keys.add('KeyW'); g.awaitingPedal = false;
  const frames = []; let last = performance.now(), run = true;
  const loop = n => { frames.push(n - last); if (n - last > 25) slow.push([Math.round(last - t0), Math.round(n - last)]); last = n; if (run) requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  const seconds = Math.min(60, total / 75 + 2);
  await new Promise(r => setTimeout(r, seconds * 1000)); run = false; g.keys.clear();
  const sorted = [...frames].sort((a, b) => a - b), q = f => sorted[Math.floor(sorted.length * f)].toFixed(1);
  const info = w.renderer.info;
  return { selectMs: Math.round(selectMs), venueMs: Math.round(venueMs), seconds: Math.round(seconds), frames: frames.length, fps: (frames.length / seconds).toFixed(1), p50: q(.5), p95: q(.95), p99: q(.99), max: sorted.at(-1).toFixed(0), over33: frames.filter(f => f > 33).length,
    slow: slow.slice(0, 25), long: long.slice(0, 25),
    prof: Object.fromEntries(Object.entries(prof).map(([k, v]) => [k, { n: v.n, avg: +(v.t / v.n).toFixed(2), max: Math.round(v.max), big: v.big.slice(0, 12) }])),
    gpu: { calls: info.render.calls, tris: info.render.triangles, programs: info.programs.length, textures: info.memory.textures, geometries: info.memory.geometries }, ratio: w.renderer.getPixelRatio(), quality: g.settings.graphicsQuality };
}, trackId);
if (process.env.CPU) {
  const { profile } = await cdp.send('Profiler.stop');
  const self = new Map(), byId = new Map(profile.nodes.map(n => [n.id, n]));
  const dt = profile.timeDeltas; profile.samples.forEach((id, i) => { const n = byId.get(id), f = n.callFrame; const key = `${f.functionName || '(anon)'} ${f.url.split('/').pop().split('?')[0]}:${f.lineNumber}`; self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0) / 1000); });
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  console.log('CPU self time (ms), total', Math.round(total)); [...self].sort((a, b) => b[1] - a[1]).slice(0, 30).forEach(([k, v]) => console.log(String(Math.round(v)).padStart(7), k));
}
console.log(JSON.stringify(result, null, 1).replace(/\[\s+(\d+),\s+(\d+)\s+\]/g, '[$1,$2]'));
await browser.close();
