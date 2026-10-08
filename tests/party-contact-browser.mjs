// Two real browser drivers in one party race: `node tests/party-contact-browser.mjs` (needs `npm run dev`).
// Checks car-to-car contact, rolling on after the finish, the finished car fading for the other driver, and the HUD layout.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { BASE, gameReady } from './browser-page.mjs';
const base = BASE, shots = process.env.SHOTS ?? 'work/party-contact';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu'] });
const errors = [];
const driver = async (name) => {
  const context = await browser.newContext({ viewport: { width: 1470, height: 920 } }), page = await context.newPage();
  page.on('pageerror', e => errors.push(`${name}: ${e.stack}`));
  await page.goto(base);
  await page.evaluate(async name => { const r = await fetch('/api/players', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nickname: name }) }); localStorage.setItem('apex:player', JSON.stringify(await r.json())); localStorage.setItem('apex:settings', JSON.stringify({ pointerLock: false })); }, name);
  await page.reload(); await gameReady(page, { track: false });
  return page;
};
const party = (page, path, method, body) => page.evaluate(async ({ path, method, body }) => { const p = JSON.parse(localStorage.getItem('apex:player')); const r = await fetch('/api/parties' + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${p.token}` }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j)); return j; }, { path, method, body });
try {
  const a = await driver('Alpha'), b = await driver('Bravo');
  await party(a, '/me', 'DELETE').catch(() => {}); await party(b, '/me', 'DELETE').catch(() => {});
  const created = await party(a, '', 'POST', { carId: 'ferrari-488-gt3', settings: { laps: 1 } });
  await party(b, '/join', 'POST', { carId: 'porsche-911-gt3', code: created.lobby.code });
  for (const p of [a, b]) await p.getByRole('button', { name: 'Party', exact: true }).click();
  await a.waitForTimeout(2500);
  await party(a, '/start', 'POST');
  // Joining shows a loading screen, not an empty scene.
  await b.waitForSelector('.party-loading', { timeout: 10000 });
  console.log('loading screen:', (await b.locator('.party-loading-step').innerText()).trim());
  await b.screenshot({ path: `${shots}/loading.png` });
  for (const p of [a, b]) await p.waitForFunction(() => window.__apex.state.mode === 'racing', null, { timeout: 120000 });
  await a.waitForTimeout(1500);
  // HUD: standings and minimap must not overlap.
  const layout = await b.evaluate(() => { const box = s => { const r = document.querySelector(s)?.getBoundingClientRect(); return r && [r.left, r.top, r.right, r.bottom].map(Math.round); }; return { map: box('.race-left'), order: box('.party-race-order'), status: box('.party-race-status'), camera: box('.camera-toggle') }; });
  console.log('layout', layout);
  const overlap = (p, q) => p && q && p[0] < q[2] && q[0] < p[2] && p[1] < q[3] && q[1] < p[3];
  for (const k of ['order', 'status', 'camera']) assert.ok(!overlap(layout.map, layout[k]), `minimap overlaps ${k}`);
  await b.screenshot({ path: `${shots}/hud.png` });
  // Contact: put Alpha 9 m behind Bravo's car on Alpha's screen and floor it.
  const contact = await a.evaluate(async () => {
    const g = window.__apex, remote = [...g.remoteCars.values()][0], target = remote.group.position, q = remote.group.quaternion;
    const back = { x: -2 * (q.x * q.z + q.w * q.y), z: -(1 - 2 * (q.x * q.x + q.y * q.y)) };
    g.sim.car.setTranslation({ x: target.x + back.x * 9, y: target.y + .3, z: target.z + back.z * 9 }, true); g.sim.car.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true); g.sim.car.setLinvel({ x: 0, y: 0, z: 0 }, true);
    g.keys.add('KeyW'); await new Promise(r => setTimeout(r, 2500)); g.keys.delete('KeyW');
    const p = g.sim.car.translation(); return { gap: Math.hypot(p.x - target.x, p.z - target.z), height: p.y - target.y };
  });
  console.log('contact', contact);
  assert.ok(contact.gap > 2.5 && contact.gap < 7, `stopped against the other car (gap ${contact.gap.toFixed(1)} m)`);
  await a.screenshot({ path: `${shots}/contact.png` });
  // Smoothness: while Alpha drives, Bravo's view of Alpha should move every frame without 10 Hz steps.
  await a.evaluate(() => { const g = window.__apex; g.sim.car.setTranslation({ x: g.sim.car.translation().x, y: g.sim.car.translation().y + .2, z: g.sim.car.translation().z }, true); });
  await a.evaluate(() => { const g = window.__apex, r = [...g.remoteCars.values()][0].group.position; const p = g.sim.car.translation(); g.sim.car.setTranslation({ x: p.x + (p.x - r.x) * 2, y: p.y, z: p.z + (p.z - r.z) * 2 }, true); g.keys.add('KeyW'); });
  await b.waitForTimeout(1200);
  const motion = await b.evaluate(async () => {
    const g = window.__apex, group = [...g.remoteCars.values()][0].group, speeds = [], gaps = []; let last = group.position.clone(), lastT = performance.now();
    for (let i = 0; i < 120; i++) { const t = await new Promise(requestAnimationFrame); const d = group.position.distanceTo(last), dt = (t - lastT) / 1000; if (dt > 0) { speeds.push(d / dt); gaps.push(dt * 1000); } last = group.position.clone(); lastT = t; }
    // Smooth motion: speed changes little from one frame to the next (relative to the running speed).
    const mean = speeds.reduce((x, y) => x + y, 0) / speeds.length, jerk = speeds.slice(1).map((v, i) => [v, speeds[i]]).filter(([v, w]) => v > 3 && w > 3).map(([v, w]) => Math.abs(v - w) / ((v + w) / 2)).sort((x, y) => x - y);
    return { fps: +(1000 / (gaps.reduce((x, y) => x + y, 0) / gaps.length)).toFixed(0), meanSpeed: +mean.toFixed(2), movingFrames: jerk.length, spikes: speeds.slice(2, -1).filter((v, i) => { const a = speeds[i + 1], b = speeds[i + 3]; return v > 2 && (v > 1.25 * Math.max(a, b) || v < .75 * Math.min(a, b)); }).length, still: speeds.filter(v => v < .01).length, speeds: speeds.map(v => +v.toFixed(1)).join(' ') };
  });
  await a.evaluate(() => window.__apex.keys.delete('KeyW'));
  console.log('remote motion on Bravo', motion);
  assert.ok(motion.movingFrames > 10 && motion.spikes <= 1, 'remote car moves smoothly every frame (no per-packet stutter)');
  // Finish: Alpha crosses the line; it keeps rolling, and Bravo sees it fade out.
  // Move clear ahead of Bravo first, as a driver crossing the line would be.
  await a.evaluate(() => { const g = window.__apex, remote = [...g.remoteCars.values()][0], t = remote.group.position, q = remote.group.quaternion; const f = { x: 2 * (q.x * q.z + q.w * q.y), z: 1 - 2 * (q.x * q.x + q.y * q.y) }; g.sim.car.setTranslation({ x: t.x + f.x * 25, y: t.y + .3, z: t.z + f.z * 25 }, true); g.sim.car.setLinvel({ x: 0, y: 0, z: 0 }, true); });
  await a.evaluate(() => { const g = window.__apex; g.keys.add('KeyW'); setTimeout(() => g.keys.delete('KeyW'), 800); setTimeout(() => { g.sim.finished = true; }, 800); });
  await a.waitForFunction(() => window.__apex.state.mode === 'party-finished', null, { timeout: 10000 });
  const p0 = await a.evaluate(() => ({ ...window.__apex.sim.car.translation() }));
  await a.waitForTimeout(2000);
  const rolled = await a.evaluate(p0 => { const p = window.__apex.sim.car.translation(); return Math.hypot(p.x - p0.x, p.z - p0.z); }, p0);
  console.log('rolled after finish', rolled.toFixed(1), 'm');
  assert.ok(rolled > 5, 'finished car keeps driving');
  const follow = await a.evaluate(() => { const g = window.__apex; return g.world.camera.position.distanceTo(g.world.car.position); });
  console.log('camera distance to own car after finish', follow.toFixed(1)); assert.ok(follow < 25, 'camera follows the car after the finish');
  await a.waitForSelector('.party-spectate'); await a.getByRole('button', { name: 'Next driver' }).click(); await a.waitForTimeout(700);
  const watch = await a.evaluate(() => { const g = window.__apex, remote = g.remoteCars.get(g.spectating); return { id: g.spectating, distance: remote && g.world.camera.position.distanceTo(remote.group.position) }; });
  console.log('spectating', watch, (await a.locator('.party-spectate strong').innerText()));
  assert.ok(watch.id && watch.distance < 25, 'spectator camera follows the other driver');
  await a.screenshot({ path: `${shots}/spectate.png` });
  await b.waitForTimeout(800); await b.screenshot({ path: `${shots}/fading.png` });
  await b.waitForFunction(() => [...window.__apex.remoteCars.values()][0].group.visible === false, null, { timeout: 12000 });
  const bravoSpeed = await b.evaluate(() => window.__apex.state.speed);
  console.log('Bravo speed after Alpha jumped past', bravoSpeed); assert.ok(bravoSpeed < 20, 'a teleporting car does not launch the other car');
  const solid = await b.evaluate(() => window.__apex.sim.obstacles.size);
  assert.equal(solid, 0, 'faded car is no longer solid');
  console.log('faded out for the other driver');
  await party(a, '/reopen', 'POST').catch(() => {}); await party(a, '/me', 'DELETE').catch(() => {}); await party(b, '/me', 'DELETE').catch(() => {});
  if (errors.length) console.log('page errors', errors);
  assert.deepEqual(errors, []); console.log('ok');
} finally { await browser.close(); }
