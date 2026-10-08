// Manual gearbox through the real keyboard path: `node tests/gearbox-browser.mjs` (needs `npm run dev`).
// Rapid E taps all land, rapid Q taps all land, a downshift that would over-rev is refused with a warning, and the tachometer renders.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { gameUrl, gameReady } from './browser-page.mjs';
const shots = process.env.SHOTS ?? 'work/gearbox';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu'] });
try {
  const page = await browser.newPage({ viewport: { width: 1470, height: 920 }, deviceScaleFactor: 2 });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(gameUrl('/'));
  await gameReady(page);
  await page.evaluate(() => { const g = window.__apex; g.setSettings({ advancedDriving: true, pointerLock: false }); g.start(false); });
  await page.waitForFunction(() => window.__apex.state.mode === 'racing');
  await page.locator('body').click({ position: { x: 700, y: 400 } }).catch(() => {});
  const gear = () => page.evaluate(() => window.__apex.sim.gear);
  assert.equal(await page.evaluate(() => window.__apex.sim.manual), true);
  // A run waits for the first pedal press before physics starts.
  await page.keyboard.down('KeyS'); await page.waitForTimeout(150); await page.keyboard.up('KeyS'); await page.waitForTimeout(300);
  // Three quick taps, faster than one shift takes, must reach 4th.
  for (let i = 0; i < 3; i++) { await page.keyboard.press('KeyE'); await page.waitForTimeout(30); }
  await page.waitForTimeout(800); assert.equal(await gear(), 4, 'queued upshifts');
  // At walking pace, two quick taps down land in 2nd.
  for (let i = 0; i < 2; i++) { await page.keyboard.press('KeyQ'); await page.waitForTimeout(30); }
  await page.waitForTimeout(800); assert.equal(await gear(), 2, 'queued downshifts');
  // Pull away in 1st (2nd lugs from a standstill), build speed into 2nd, then try dropping two gears to 1st: refused, warning shown.
  await page.keyboard.press('KeyQ'); await page.waitForTimeout(500);
  await page.keyboard.down('KeyW'); await page.waitForTimeout(2000); await page.keyboard.press('KeyE'); await page.waitForTimeout(2500); await page.keyboard.up('KeyW');
  const before = await page.evaluate(() => ({ gear: window.__apex.sim.gear, speed: window.__apex.state.speed }));
  await page.screenshot({ path: `${shots}/tach-driving.png` });
  await page.keyboard.press('KeyQ'); await page.waitForTimeout(30); await page.keyboard.press('KeyQ'); await page.waitForTimeout(450);
  const after = await page.evaluate(() => ({ gear: window.__apex.sim.gear, blocked: window.__apex.sim.blockedShifts, text: document.querySelector('.tachometer small b')?.textContent }));
  await page.screenshot({ path: `${shots}/tach-blocked.png` });
  console.log({ before, after });
  assert.ok(after.gear >= 2, 'never dropped into 1st at speed');
  assert.ok(after.blocked > 0 && /Too fast/.test(after.text ?? ''), 'blocked downshift is reported');
  assert.equal(await page.locator('.tachometer').count(), 1); assert.equal(await page.locator('.rpm-panel').count(), 0);
  const boxes = await page.evaluate(() => Object.fromEntries(['.tachometer', '.speedometer', '.race-left', '.timer-panel'].map(s => { const r = document.querySelector(s).getBoundingClientRect(); return [s, [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]]; })));
  console.log(boxes); assert.ok(boxes['.tachometer'][2] < boxes['.speedometer'][0], 'tach left of speedometer'); assert.ok(boxes['.race-left'][1] < 200, 'minimap at top');
  assert.deepEqual(errors, []); console.log('ok');
} finally { await browser.close(); }
