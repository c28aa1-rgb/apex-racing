// A/B of distance culling at fixed camera points: `node tests/cull-ab.mjs [trackId...]` (needs `npm run dev`).
// Interleaves cull on/off in one page so machine load hits both equally; reports draw calls, triangles, median render ms.
import { chromium } from '@playwright/test';
const ids = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', e => console.log('pageerror', e.message));
  await page.goto('http://127.0.0.1:5173/');
  await page.waitForFunction(() => window.__apex?.state.modelReady && window.__apex.state.trackReady);
  const all = await page.evaluate(async () => { const { TRACKS } = await import('/shared/tracks.ts'); const g = window.__apex; g.frame = () => {}; document.getElementById('app').style.display = 'none'; return TRACKS.map(t => t.id); });
  for (const id of ids.length ? ids : all) {
    await page.evaluate(async id => { const { TRACKS } = await import('/shared/tracks.ts'), w = window.__apex.world; w.setTrack(TRACKS.find(t => t.id === id)); w.car.visible = false; w.ghost.visible = false; w.trackGroup.visible = false; w.garageGroup.visible = false; }, id);
    await page.waitForFunction(() => window.__apex.world.venueGroup.children.length > 0);
    const rows = await page.evaluate(async id => {
      const { TRACKS, spawnGate } = await import('/shared/tracks.ts'), t = TRACKS.find(t => t.id === id), w = window.__apex.world, gl = w.renderer.getContext();
      w.venueGroup.visible = true; w.wideView = false; const out = [];
      for (const fraction of [0, .25, .5, .75]) {
        const s = t.segments[Math.floor(t.segments.length * fraction)], p = fraction === 0 ? spawnGate(t).position : s.start;
        const f = fraction === 0 ? spawnGate(t).forward : { x: s.end.x - s.start.x, y: s.end.y - s.start.y, z: s.end.z - s.start.z };
        const l = Math.hypot(f.x, f.z); w.camera.position.set(p.x - f.x / l * 14, p.y + 7, p.z - f.z / l * 14);
        w.camera.lookAt(p.x + f.x / l * 65, p.y + 1, p.z + f.z / l * 65); w.camera.fov = 68; w.camera.updateProjectionMatrix();
        const row = { fraction };
        for (const mode of ['off', 'on', 'off', 'on']) {
          const cull = w.cullVenue.bind(w);
          if (mode === 'off') { for (const e of w.cullEntries) e.mesh.visible = true; w.cullVenue = () => {}; } else { w.cullVenue = cull; w.cullFar = -1; }
          for (let i = 0; i < 4; i++) { w.render(); gl.finish(); await new Promise(requestAnimationFrame); }
          const times = []; for (let i = 0; i < 14; i++) { const a = performance.now(); w.render(); gl.finish(); times.push(performance.now() - a); await new Promise(requestAnimationFrame); }
          times.sort((a, b) => a - b); const r = w.renderer.info.render;
          row[mode] = { calls: r.calls, tris: r.triangles, ms: +times[7].toFixed(2) };
          w.cullVenue = cull;
        }
        out.push(row);
      }
      return out;
    }, id);
    console.log(id); for (const r of rows) console.log(' ', r.fraction, 'off', JSON.stringify(r.off), 'on', JSON.stringify(r.on));
  }
} finally { await browser.close(); }
