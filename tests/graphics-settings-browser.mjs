// Graphics presets and custom options: `node tests/graphics-settings-browser.mjs` (needs `npm run dev`).
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('http://127.0.0.1:5173/');
  await page.evaluate(() => localStorage.clear()); await page.reload();
  await page.waitForFunction(() => window.__apex?.state.modelReady);
  const expected = { lowest: [.6, false, 0, 1400], performance: [.85, false, 0, 1800], balanced: [1, true, 0, 2600], high: [1.25, true, 0, 3600], cinematic: [1.25, true, 0, 5000] };
  const dpr = await page.evaluate(() => devicePixelRatio);
  for (const [id, [ratio, shadows, passes, fogFar]] of Object.entries(expected)) {
    const r = await page.evaluate(id => { const g = window.__apex, w = g.world; g.setSettings({ graphicsQuality: id }); w.wideView = false; w.render(); return { q: g.settings.graphicsQuality, ratio: w.renderer.getPixelRatio(), shadows: w.renderer.shadowMap.enabled, passes: w.composer?.passes.length ?? 0, fogFar: w.scene.fog.far }; }, id);
    assert.equal(r.q, id); assert.equal(r.shadows, shadows, id + ' shadows'); assert.equal(r.fogFar, fogFar, id + ' fog');
    assert.equal(r.ratio, Math.min(dpr, ratio), id + ' ratio');
    const want = id === 'cinematic' ? 4 : id === 'high' ? 3 : 0; assert.equal(r.passes, want, id + ' passes');
    console.log(id, JSON.stringify(r));
  }
  // Editing one option flips the label to Custom, and survives reload.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Graphics', exact: true }).click();
  await page.getByLabel('Graphics quality').selectOption('balanced');
  await page.getByLabel('Shadows').selectOption('2048');
  assert.equal(await page.evaluate(() => window.__apex.settings.graphicsQuality), 'custom');
  assert.equal(await page.getByLabel('Graphics quality').inputValue(), 'custom');
  await page.getByLabel('Frame rate limit').selectOption('30');
  assert.equal(await page.evaluate(() => window.__apex.world.fpsCap), 30);
  await page.getByLabel('Bloom').check();
  assert.equal(await page.evaluate(() => window.__apex.world.composer?.passes.length), 3);
  await page.evaluate(() => window.__apex.setGraphics({ drawDistance: 1000 }));
  assert.equal(await page.evaluate(() => { const w = window.__apex.world; w.wideView = false; w.render(); return w.scene.fog.far; }), 1000);
  assert.equal(await page.locator('.settings-panel').evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await page.reload(); await page.waitForFunction(() => window.__apex?.state.modelReady);
  const kept = await page.evaluate(() => ({ q: window.__apex.settings.graphicsQuality, g: window.__apex.settings.graphics, cap: window.__apex.world.fpsCap }));
  assert.equal(kept.q, 'custom'); assert.equal(kept.g.shadows, 2048); assert.equal(kept.g.bloom, true); assert.equal(kept.g.drawDistance, 1000); assert.equal(kept.cap, 30);
  // Setting options back to an exact preset renames it.
  await page.evaluate(() => { const g = window.__apex; g.setSettings({ graphicsQuality: 'performance' }); g.setGraphics({ shadows: 1024 }); g.setGraphics({ shadows: 0 }); });
  assert.equal(await page.evaluate(() => window.__apex.settings.graphicsQuality), 'performance');
  // Frame cap really throttles drawing.
  const frames = await page.evaluate(async () => { const g = window.__apex; g.setGraphics({ fpsCap: 30 }); const r = g.world.render.bind(g.world); let n = 0; g.world.render = (...a) => { n++; return r(...a); }; await new Promise(res => setTimeout(res, 2000)); g.world.render = r; return n / 2; });
  console.log('rendered fps with 30 cap:', frames); assert.ok(frames <= 34, 'cap holds');
  assert.deepEqual(errors.filter(e => !/ERR_|Failed to load resource/.test(e)), []);
  console.log('ok');
} finally { await browser.close(); }
