// Two real drivers in one party race: `node tests/party-sync-browser.mjs` (needs `npm run dev`; GAME_URL picks another server).
// Checks the random grid, the shared lights-out instant, the jump-start warning and penalty, live standings agreeing on both
// screens, and how far each screen draws the other car from where it really is (should stay within a few metres at speed).
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { gameUrl, gameReady } from './browser-page.mjs';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu'] });
const errors = [];
const driver = async (name) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } }), page = await context.newPage();
  page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  await page.goto(gameUrl('/'));
  await page.evaluate(async name => { const r = await fetch('/api/players', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nickname: name }) }); localStorage.setItem('apex:player', JSON.stringify(await r.json())); localStorage.setItem('apex:settings', JSON.stringify({ pointerLock: false })); }, name);
  await page.reload(); await gameReady(page, { track: false });
  return page;
};
const party = (page, path, method, body) => page.evaluate(async ({ path, method, body }) => { const p = JSON.parse(localStorage.getItem('apex:player')); const r = await fetch('/api/parties' + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${p.token}` }, body: body ? JSON.stringify(body) : undefined }); return r.json(); }, { path, method, body });
try {
  const a = await driver('Alpha'), b = await driver('Bravo');
  await party(a, '/me', 'DELETE').catch(() => {}); await party(b, '/me', 'DELETE').catch(() => {});
  const created = await party(a, '', 'POST', { carId: 'porsche-911-gt3', settings: { laps: 1 } });
  await party(b, '/join', 'POST', { carId: 'porsche-911-gt3', code: created.lobby.code });
  for (const p of [a, b]) await p.getByRole('button', { name: 'Party', exact: true }).click();
  await a.waitForTimeout(2500);
  const started = await party(a, '/start', 'POST');
  console.log('slots', JSON.stringify(started.lobby.race.racers.map(r => [r.nickname, r.slot])));
  for (const p of [a, b]) await p.waitForFunction(() => window.__apex.state.mode === 'countdown', null, { timeout: 120000 });
  // Jump-start warning appears while throttle is held during the countdown.
  await b.evaluate(() => window.__apex.keys.add('KeyW')); await b.waitForTimeout(300);
  assert.ok(await b.locator('.jump-warning').count() > 0, 'jump-start warning shows while the throttle is held');
  const goGap = await Promise.all([a, b].map(p => p.evaluate(() => window.__apex.serverTime(window.__apex.countdownUntil))));
  console.log('lights-out instant differs by', Math.abs(goGap[0] - goGap[1]).toFixed(1), 'ms (server clock)');
  assert.ok(Math.abs(goGap[0] - goGap[1]) < 250, 'both screens put lights-out at the same server moment');
  for (const p of [a, b]) await p.waitForFunction(() => window.__apex.state.mode === 'racing', null, { timeout: 30000 });
  assert.ok(await b.locator('.jump-penalty').count() > 0, 'jump-start penalty banner shows');
  await a.evaluate(() => window.__apex.keys.add('KeyW'));
  await a.waitForTimeout(5000);
  for (let i = 0; i < 4; i++) {
    const [ra, rb] = await Promise.all([a, b].map(p => p.evaluate(() => { const g = window.__apex, s = g.sim.car.translation(), v = g.sim.car.linvel(), r = [...g.remoteCars.values()][0].group.position; return { self: s, speed: Math.hypot(v.x, v.z), drawn: { x: r.x, y: r.y, z: r.z }, order: [...document.querySelectorAll('.party-race-order li span')].map(e => e.textContent) }; })));
    const err = (drawn, real) => Math.hypot(drawn.x - real.x, drawn.z - real.z).toFixed(1);
    assert.ok(+err(ra.drawn, rb.self) < 8 && +err(rb.drawn, ra.self) < 8, 'each screen draws the other car close to its real position');
    assert.deepEqual(ra.order, rb.order, 'both screens agree on the race order');
    console.log(`t+${i}: speeds ${ra.speed.toFixed(0)}/${rb.speed.toFixed(0)} m/s · Alpha draws Bravo ${err(ra.drawn, rb.self)} m off · Bravo draws Alpha ${err(rb.drawn, ra.self)} m off · order A:${ra.order} B:${rb.order}`);
    await a.waitForTimeout(1000);
  }
  assert.deepEqual(errors, []);
  console.log('Party sync checks passed.');
} finally { await browser.close(); }
