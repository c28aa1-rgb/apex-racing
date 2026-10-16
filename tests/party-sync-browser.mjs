// Two real drivers in one party race: `node tests/party-sync-browser.mjs` (needs `npm run dev`; GAME_URL picks another server).
// Checks the random grid, the shared lights-out instant, the jump-start warning and penalty, live standings agreeing on both
// screens, and how far each screen draws the other car from where it really is (should stay within a few metres at speed).
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { gameUrl, gameReady } from './browser-page.mjs';
const shots = process.env.SHOTS ?? 'work/party-network';
const delayMs = Number(process.env.NETWORK_DELAY_MS ?? 0), jitterMs = Number(process.env.NETWORK_JITTER_MS ?? 0);
await mkdir(shots, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu'] });
const errors = [], pages = [];
const timers = new Set();
let packet = 0;
const latency = () => Math.max(0, delayMs + [-1, .5, 0, 1, -.5][packet++ % 5] * jitterMs);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const driver = async (name) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } }), page = await context.newPage();
  pages.push(page);
  page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  if (delayMs || jitterMs) {
    await page.route('**/api/parties/race', async route => {
      await sleep(latency()); const response = await route.fetch(); await sleep(latency()); await route.fulfill({ response });
    });
    await page.routeWebSocket('**/api/rooms/*/socket', ws => {
      const server = ws.connectToServer();
      const forward = (source, target) => {
        let deadline = 0;
        const schedule = action => {
          deadline = Math.max(deadline + 1, performance.now() + latency());
          const timer = setTimeout(() => { timers.delete(timer); try { action(); } catch {} }, Math.max(0, deadline - performance.now()));
          timers.add(timer);
        };
        source.onMessage(message => schedule(() => target.send(message)));
        source.onClose((code, reason) => schedule(() => { void target.close({ code, reason }).catch(() => {}); }));
      };
      forward(ws, server); forward(server, ws);
    });
  }
  await page.goto(gameUrl('/'));
  await page.evaluate(async name => { const storage = await import('/src/storage.ts'); storage.write('player', await storage.api('/players', { nickname: name })); storage.write('settings', { pointerLock: false }); }, name);
  await page.reload(); await gameReady(page, { track: false });
  return page;
};
const party = (page, path, method, body) => page.evaluate(async ({ path, method, body }) => { const { read } = await import('/src/storage.ts'); const { requestParty } = await import('/src/use-party.ts'); return requestParty(path, read('player', null).token, method, body); }, { path, method, body });
try {
  const a = await driver('Alpha'), b = await driver('Bravo');
  const { PARTY_MAX_IN_FLIGHT, PARTY_POSE_INTERVAL_MS } = await a.evaluate(async () => {
    const { PARTY_MAX_IN_FLIGHT, PARTY_POSE_INTERVAL_MS } = await import('/shared/party-network.ts');
    return { PARTY_MAX_IN_FLIGHT, PARTY_POSE_INTERVAL_MS };
  });
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
  await a.waitForTimeout(3000);
  for (const page of [a, b]) {
    const timestampError = await page.evaluate(() => {
      const g = window.__apex, pose = g.partyPose();
      return Math.abs(pose.t - g.serverTime(g.previous - g.accumulator * 1000));
    });
    assert.ok(timestampError < .1, 'pose timestamps describe the physics tick, not the later send timer');
  }
  const motion = await b.evaluate(async () => {
    const group = [...window.__apex.remoteCars.values()][0].group, speeds = [];
    let last = group.position.clone(), lastT = performance.now();
    for (let i = 0; i < 60; i++) {
      const now = await new Promise(requestAnimationFrame), dt = (now - lastT) / 1000;
      if (dt > 0) speeds.push(group.position.distanceTo(last) / dt);
      last.copy(group.position); lastT = now;
    }
    const changes = speeds.slice(1).map((v, i) => Math.abs(v - speeds[i]) / Math.max(1, (v + speeds[i]) / 2)).sort((a, b) => a - b);
    return { meanSpeed: speeds.reduce((a, b) => a + b, 0) / speeds.length, movingFraction: speeds.filter(v => v > .1).length / speeds.length,
      p95RelativeSpeedChange: changes[Math.ceil((changes.length - 1) * .95)],
      ...(changes[Math.ceil((changes.length - 1) * .95)] >= .3 ? { speeds, poses: [...window.__apex.remoteCars.values()][0].motion.samples.slice(-12) } : {}) };
  });
  console.log('rendered remote motion', motion);
  assert.ok(motion.meanSpeed > 5 && motion.movingFraction > .9, 'remote cars move between packets, not only when a pose arrives');
  assert.ok(motion.p95RelativeSpeedChange < .3, 'normal network jitter does not cause frame-to-frame speed spikes');
  await a.waitForTimeout(1000);
  for (let i = 0; i < 4; i++) {
    const [ra, rb] = await Promise.all([a, b].map(p => p.evaluate(() => { const g = window.__apex, s = g.sim.car.translation(), v = g.sim.car.linvel(), r = [...g.remoteCars.values()][0].group.position; return { self: s, speed: Math.hypot(v.x, v.z), drawn: { x: r.x, y: r.y, z: r.z }, stats: g.multiplayerDiagnostics(), order: [...document.querySelectorAll('.party-race-order li span')].map(e => e.textContent) }; })));
    const err = (drawn, real) => Math.hypot(drawn.x - real.x, drawn.z - real.z).toFixed(1);
    const budgets = [ra, rb].map((driver, index) => Math.max(8, [rb.speed, ra.speed][index] * Math.max(0, driver.stats.remotes[0].playbackAgeMs ?? 0) / 1000 + 3));
    console.log('position budgets', budgets.map(n => n.toFixed(1)), 'errors', err(ra.drawn, rb.self), err(rb.drawn, ra.self));
    assert.ok(+err(ra.drawn, rb.self) < budgets[0] && +err(rb.drawn, ra.self) < budgets[1], 'position error must stay within the measured network/display delay budget');
    assert.ok(ra.stats.remotes[0].latestPoseAgeMs < 500 && rb.stats.remotes[0].latestPoseAgeMs < 500, 'fresh poses arrive within half a second');
    assert.deepEqual(ra.order, rb.order, 'both screens agree on the race order');
    console.log(`t+${i}: speeds ${ra.speed.toFixed(0)}/${rb.speed.toFixed(0)} m/s · Alpha draws Bravo ${err(ra.drawn, rb.self)} m off · Bravo draws Alpha ${err(rb.drawn, ra.self)} m off · order A:${ra.order} B:${rb.order}`);
    await a.waitForTimeout(1000);
  }
  const diagnostics = await Promise.all([a, b].map(page => page.evaluate(() => window.__apex.multiplayerDiagnostics())));
  console.log('network diagnostics', JSON.stringify({ delayMs, jitterMs, drivers: diagnostics }));
  for (const stats of diagnostics) {
    assert.ok(stats.connection.received > 50, 'both drivers receive sustained updates');
    assert.ok(stats.connection.peakInFlight <= PARTY_MAX_IN_FLIGHT, 'updates never accumulate an unbounded request queue');
    assert.equal(stats.connection.failed, 0, 'normal jitter must not lose the race connection');
    assert.ok(stats.connection.sendIntervalMs.p95 < PARTY_POSE_INTERVAL_MS + 15, 'reply latency must not set the send cadence');
    assert.ok(stats.remotes[0].received > 20, 'remote poses keep arriving');
  }
  await writeFile(`${shots}/diagnostics.json`, JSON.stringify({ delayMs, jitterMs, motion, drivers: diagnostics }, null, 2));
  await b.screenshot({ path: `${shots}/desktop.png` });
  await b.setViewportSize({ width: 390, height: 844 }); await b.waitForTimeout(500);
  await b.screenshot({ path: `${shots}/mobile.png` });
  await party(a, '/reopen', 'POST'); await party(a, '/me', 'DELETE'); await party(b, '/me', 'DELETE');
  assert.deepEqual(errors, []);
  console.log('Party sync checks passed.');
} catch (cause) {
  for (let i = 0; i < pages.length; i++) {
    console.log('failure diagnostics', i, await pages[i].evaluate(() => window.__apex?.multiplayerDiagnostics()).catch(() => null));
    await pages[i].screenshot({ path: `${shots}/failure-${i}.png` }).catch(() => {});
  }
  throw cause;
} finally { for (const timer of timers) clearTimeout(timer); await browser.close(); }
