// Smooth-track gate (what the player SEES). Playwright against the dev server: drives the same lap with the
// same driver as tests/smooth-audit.ts (tests/smooth-route.ts, loaded through Vite) and measures the rendered car.
//
//   node tests/smooth-visual-audit.mjs [--track=id[,id]] [--cars=id,...] [--seconds=N]
//        [--out=work/smooth-audit/<name>.json] [--label=<name>] [--saved=work/smooth-audit/circuit-config.json|api]
//        [--base=http://127.0.0.1:5173] [--serve] [--shots=5] [--headed] [--centerlines=work/smooth-audit|none]
//
// --saved=<file> (default) applies the snapshot with the app's own functions (src/dev-spawns.ts, exactly as
// src/main.ts does with the API config on boot); --saved=api uses the config the app fetched itself.
// --serve starts a private in-process Vite (own port + cacheDir, no watcher) when no dev server is running.
//
// Per rendered frame (one physics tick, world.chase(sim, 1/60) as a 60 Hz display; lengths in metres = units * mpu):
//   wheelTravel     max |wheel.position.y - wheel.userData.rest[1]| per rendered wheel (wheel slides through the body)
//   bodyJump        per-frame change of the rendered body's height above the visible road under its four wheels
//                   (what the player sees bounce; the physics chassis may compress underneath a rigid model)
//   visibleTyreGap  rendered wheel centre height above the visible floor plane (perpendicular, so banking does not
//                   inflate it) minus the tyre radius, for wheels whose physics wheel is in contact, on the lane
//   bodyBelowFloor  lowest point of the rendered body (car model without wheels: its underside sampled on a 0.2 m
//                   grid in car space) above the visible floor under that point; bodyBoxBottom is the same for the
//                   body's Box3 bottom face (3x5 points; info only, Box3 corners are not real body)
// The visible floor is tests/smooth-route.ts visibleFloor(): Simulation.visibleGroundAt's ray plus the hit normal.
// Screenshots: the `shots` worst frames per track (chase camera, metric overlay drawn in, values in the file name)
// to work/smooth-audit/visual/<label>/. Exit code 1 if any target is violated or the page threw.
import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const flag = name => process.argv.includes(`--${name}`);
const outPath = arg('out') ?? 'work/smooth-audit/smooth-visual-audit.json';
const label = arg('label') ?? basename(outPath).replace(/\.json$/, '');
const savedSource = arg('saved') ?? 'work/smooth-audit/circuit-config.json';
const secondsLimit = arg('seconds') !== undefined ? Number(arg('seconds')) : undefined;
const shots = Number(arg('shots') ?? 5);
const shotDir = `work/smooth-audit/visual/${label}`;
// Same route source as tests/smooth-audit.ts: circuits without a saved drive trace use <dir>/<id>-centerline.json.
const centerlineDir = arg('centerlines') ?? 'work/smooth-audit';
const centerlineJson = async id => { if (centerlineDir === 'none') return undefined; try { return JSON.parse(await readFile(`${centerlineDir}/${id}-centerline.json`, 'utf8')); } catch { return undefined; } };
export const TARGETS = { wheelTravelMaxCm: 5, bodyJumpMaxCm: 3, tyreGapBandCm: [-2, 4], tyreGapInBandShare: .99, bodyBelowFloorMinCm: 0 };

let base = arg('base') ?? 'http://127.0.0.1:5173', vite;
const reachable = async url => { try { return (await fetch(url, { signal: AbortSignal.timeout(4000) })).ok; } catch { return false; } };
if (flag('serve')) {
  const { createServer } = await import('vite');
  vite = await createServer({ logLevel: 'warn', cacheDir: 'node_modules/.vite-smooth-visual-audit', server: { host: '127.0.0.1', port: 5199, strictPort: false, watch: null, hmr: false } });
  await vite.listen();
  base = vite.resolvedUrls.local[0].replace(/\/$/, '');
  console.log(`--serve: private Vite at ${base}`);
} else if (!await reachable(base)) {
  console.error(`No dev server at ${base}. Start it (npm run dev) or pass --serve.`); process.exit(2);
}

const savedConfig = savedSource === 'api' ? undefined : JSON.parse(await readFile(savedSource, 'utf8'));
const browser = await chromium.launch({ channel: 'chrome', headless: !flag('headed') });
const pageErrors = [], consoleErrors = [];
let exitCode = 0;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
  // Module URLs the app loaded are read back from resource timing (so ?t= HMR variants resolve to the app's instance).
  await page.addInitScript(() => performance.setResourceTimingBufferSize(100000));
  await page.goto(`${base}/`);
  // The menu may boot into the Training Grounds with no circuit ready; each run selects its own circuit below.
  await page.waitForFunction(() => window.__apex?.state.modelReady, null, { timeout: 180000 });

  const boot = await page.evaluate(async ({ savedConfig }) => {
    const mod = async path => { const hit = performance.getEntriesByType('resource').map(e => e.name).find(n => { try { return new URL(n).pathname === path; } catch { return false; } }); return import(hit ?? path); };
    const [tracks, spawns, route] = await Promise.all([mod('/shared/tracks.ts'), mod('/src/dev-spawns.ts'), import('/tests/smooth-route.ts')]);
    const game = window.__apex;
    game.frame = () => {};
    document.getElementById('app').style.display = 'none';
    let config = savedConfig, source = 'file';
    if (!config) { source = 'api'; const response = await fetch('/api/dev-circuit-config'); config = response.ok ? await response.json() : undefined; if (!config) source = 'app boot (API unavailable: browser drafts/built-in)'; }
    // Does the layout the app loaded at boot equal the snapshot? (Only the drive traces are compared.)
    const bootMatches = config ? Object.fromEntries(tracks.TRACKS.map(t => [t.id, JSON.stringify(t.mapPath ?? null) === JSON.stringify(config.maps?.[t.id] ?? null)])) : {};
    if (config) for (const track of tracks.TRACKS) {
      // Same application as src/main.ts boot and tests/smooth-audit.ts.
      spawns.applyStartPlacement(track, config.starts?.[track.id]); spawns.applyFinishPlacement(track, config.finishes?.[track.id]);
      spawns.applyRoadWidthOverrides(track, config.roads?.[track.id]); track.mapPath = config.maps?.[track.id];
      if (config.checkpoints) spawns.applyCheckpoints(track, config.checkpoints[track.id]);
    }
    window.__sva = { tracks, route };
    return { source, bootMatches, venueTracks: route.VENUE_TRACKS, defaultCars: route.DEFAULT_CARS, trackIds: tracks.TRACKS.map(t => t.id) };
  }, { savedConfig });
  const trackIds = arg('track')?.split(',').filter(Boolean) ?? boot.venueTracks;
  const carIds = arg('cars')?.split(',').filter(Boolean) ?? boot.defaultCars;
  for (const id of trackIds) if (!boot.trackIds.includes(id)) throw new Error(`Unknown track ${id}`);
  console.log(`saved layouts: ${boot.source}${savedConfig ? `; app boot config equals snapshot for ${trackIds.filter(id => boot.bootMatches[id]).length}/${trackIds.length} tracks` : ''}`);

  // Installs the per-run driver/measurement loop in the page (kept on window.__sva between chunks).
  await page.evaluate(() => {
    const S = window.__sva;
    S.begin = async ({ trackId, carId, secondsLimit, shots, centerline }) => {
      const game = window.__apex, world = game.world, track = S.tracks.TRACKS.find(t => t.id === trackId);
      if (game.state.track !== track || !game.state.trackReady) await game.select(track, true);
      await world.venueReady;
      if (!game.state.trackReady) throw new Error(`track ${trackId} not ready: ${game.state.notice}`);
      await game.selectCar(carId); // fresh Simulation at the (saved) grid for this car
      if (!game.state.modelReady) throw new Error(`car ${carId} model not ready: ${game.modelError}`);
      const sim = game.sim, mpu = track.metersPerUnit, R = S.route;
      sim.maxTicks = Infinity;
      const route = R.buildRoute(track, track.mapPath?.length ? undefined : R.parseCenterline(centerline)), driver = new R.RouteDriver(route, R.speedProfile(route, carId)), start = driver.start(sim);
      world.cameraMode = 'chase';
      world.chase(sim, 1 / 60, true); world.car.updateMatrixWorld(true);
      // Body underside in car space: lowest vertex per 0.2 m cell of every non-wheel mesh; keep cells within 0.3 m of the lowest.
      const V = () => world.center.clone(), inverse = world.car.matrixWorld.clone().invert(), wheels = new Set(world.wheelGroups);
      const isWheel = o => { for (let a = o; a && a !== world.car; a = a.parent) if (wheels.has(a) || /^apex-wheel-/.test(a.name)) return true; return false; };
      const cells = new Map(), box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }, cell = .2;
      world.car.traverse(o => {
        if (!o.isMesh || isWheel(o)) return;
        const m = inverse.clone().multiply(o.matrixWorld), pos = o.geometry.getAttribute('position'), v = V();
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(m);
          box.min = [Math.min(box.min[0], v.x), Math.min(box.min[1], v.y), Math.min(box.min[2], v.z)]; box.max = [Math.max(box.max[0], v.x), Math.max(box.max[1], v.y), Math.max(box.max[2], v.z)];
          const key = `${Math.floor(v.x / cell)},${Math.floor(v.z / cell)}`, c = cells.get(key);
          if (!c || v.y < c.y) cells.set(key, { x: v.x, y: v.y, z: v.z });
        }
      });
      // Between the axles and inside the wheels: where a body sunk into the road shows. Wings and splitters ahead of or
      // behind the axles may legitimately touch a rising crest or banking, as on a real car.
      const axles = world.wheelGroups.map(w => w.userData.rest), minZ = Math.min(...axles.map(a => a[2])) + .1, maxZ = Math.max(...axles.map(a => a[2])) - .1, maxX = Math.max(...axles.map(a => Math.abs(a[0])));
      const underside = [...cells.values()].filter(c => c.y <= box.min[1] + .3 && c.z >= minZ && c.z <= maxZ && Math.abs(c.x) <= maxX);
      const boxBottom = [];
      for (const fx of [0, .5, 1]) for (const fz of [0, .25, .5, .75, 1]) boxBottom.push({ x: box.min[0] + (box.max[0] - box.min[0]) * fx, y: box.min[1], z: box.min[2] + (box.max[2] - box.min[2]) * fz });
      const restBottom = Math.min(...world.wheelGroups.map(w => w.userData.rest[1] - w.userData.radius));
      const lapM = driver.lapLength * mpu, limit = secondsLimit !== undefined ? Math.round(secondsLimit * 60) : Math.ceil((lapM / 18 + 120) * 60);
      S.run = {
        game, world, sim, track, carId, mpu, route, driver, start, limit, underside, boxBottom, V, shots,
        tick: 0, settleUntil: 0, lastRespawns: sim.respawns, respawns: 0, lapFinishedGate: false, lastOffset: undefined, laneFrames: 0,
        maxMph: 0, maxBankMph: 0, travelMax: [0, 0, 0, 0], travel: [], jump: [], gaps: [], gapFrames: 0, gapFramesInBand: 0, gapWheelsInBand: 0,
        body: [], boxBody: [], frames: [], kept: [],
      };
      return { lapM, route: route.source, start, wheels: world.wheelGroups.length, undersidePoints: underside.length, bodyBoxM: box, staticClearanceM: box.min[1] - restBottom };
    };
    const cm = (r, units) => units * r.mpu * 100;
    const capture = (r, frame) => {
      r.world.render();
      return document.getElementById('world').toDataURL('image/jpeg', .85);
    };
    S.advance = n => {
      const r = S.run, { sim, world, driver, V } = r, R = S.route, [lo, hi] = [-2, 4];
      for (let k = 0; k < n && !driver.done && r.tick < r.limit; k++) {
        const input = driver.input(sim);
        sim.step(input);
        if (sim.finished) { sim.finished = false; sim.checkpoint = 0; r.lapFinishedGate = true; } // keep driving past the line
        const tick = r.tick++;
        world.chase(sim, 1 / 60); world.car.updateMatrixWorld(true);
        const p = sim.car.translation(), speedMph = sim.speed * r.mpu * R.MPH;
        if (sim.respawns !== r.lastRespawns) { r.respawns += sim.respawns - r.lastRespawns; r.lastRespawns = sim.respawns; r.settleUntil = tick + 30; driver.locate(p, true); r.lastOffset = undefined; }
        if (tick < r.settleUntil) continue;
        const onLane = Math.abs(driver.lateral) <= driver.halfWidth;
        if (onLane) r.laneFrames++;
        r.maxMph = Math.max(r.maxMph, speedMph);
        const normals = [0, 1, 2, 3].filter(i => sim.vehicle.wheelIsInContact(i)).map(i => sim.vehicle.wheelContactNormal(i)).filter(Boolean);
        if (normals.length >= 3 && normals.reduce((s, q) => s + q.y, 0) / normals.length < Math.cos(15 * Math.PI / 180)) r.maxBankMph = Math.max(r.maxBankMph, speedMph);
        // wheelTravel
        let travel = 0;
        world.wheelGroups.forEach((wheel, i) => { const t = cm(r, Math.abs(wheel.position.y - wheel.userData.rest[1])); r.travelMax[i] = Math.max(r.travelMax[i] ?? 0, t); travel = Math.max(travel, t); });
        r.travel.push(travel);
        // bodyJump
        const floors = world.wheelGroups.map(w => R.visibleFloor(sim, w.getWorldPosition(V()))).filter(Boolean);
        const offset = floors.length >= 3 ? world.car.position.y - floors.reduce((sum, f) => sum + f.y, 0) / floors.length : undefined;
        const jump = r.lastOffset === undefined || offset === undefined ? 0 : cm(r, Math.abs(offset - r.lastOffset)); r.lastOffset = offset;
        r.jump.push(jump);
        // visibleTyreGap (grounded physics wheel, on the lane)
        const gaps = [];
        if (onLane) for (const wheel of world.wheelGroups) {
          if (!sim.vehicle.wheelIsInContact(wheel.userData.index)) continue;
          const centre = wheel.getWorldPosition(V()), floor = R.visibleFloor(sim, centre);
          if (!floor) continue;
          const gap = cm(r, R.heightAbove(centre, floor) - wheel.userData.radius);
          gaps.push(gap); r.gaps.push(gap); if (gap >= lo && gap <= hi) r.gapWheelsInBand++;
        }
        if (gaps.length) { r.gapFrames++; if (gaps.every(g => g >= lo && g <= hi)) r.gapFramesInBand++; }
        // bodyBelowFloor (on the lane)
        let body, boxBody;
        if (onLane) {
          const lowest = points => { let min = Infinity; for (const c of points) { const q = V().set(c.x, c.y, c.z).applyMatrix4(world.car.matrixWorld), floor = R.visibleFloor(sim, q); if (floor) min = Math.min(min, cm(r, R.heightAbove(q, floor))); } return Number.isFinite(min) ? min : undefined; };
          body = lowest(r.underside); boxBody = lowest(r.boxBottom);
          if (body !== undefined) r.body.push(body); if (boxBody !== undefined) r.boxBody.push(boxBody);
        }
        // Frame score: > 1 means a target is violated; the worst frames get a screenshot.
        const gapLo = gaps.length ? Math.min(...gaps) : undefined, gapHi = gaps.length ? Math.max(...gaps) : undefined;
        const parts = { wheelTravel: travel / 5, bodyJump: jump / 3, tyreGap: gaps.length ? Math.max(gapLo < 0 ? -gapLo / -lo : 0, gapHi > 0 ? gapHi / hi : 0) : 0, bodyBelowFloor: body !== undefined && body < 0 ? 1 - body : 0 };
        const metric = Object.keys(parts).reduce((a, b) => parts[b] > parts[a] ? b : a), score = parts[metric];
        const frame = { tick, score: +score.toFixed(3), metric, x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), distanceM: +(driver.progress * r.mpu).toFixed(1), lateralM: +(driver.lateral * r.mpu).toFixed(2), speedMph: +speedMph.toFixed(1),
          wheelTravelCm: +travel.toFixed(2), bodyJumpCm: +jump.toFixed(2), tyreGapCm: gaps.map(g => +g.toFixed(2)), bodyBelowFloorCm: body === undefined ? null : +body.toFixed(2), bodyBoxBottomCm: boxBody === undefined ? null : +boxBody.toFixed(2) };
        r.frames.push(frame);
        // Keep the `shots` worst frames (at least 60 ticks apart) with an image captured right now.
        if (score > .05 && r.shots > 0) {
          const near = r.kept.find(f => Math.abs(f.tick - tick) < 60);
          if (near) { if (score > near.score * 1.1) { Object.assign(near, frame, { image: capture(r, frame) }); } }
          else if (r.kept.length < r.shots) r.kept.push({ ...frame, image: capture(r, frame) });
          else { const min = r.kept.reduce((a, b) => b.score < a.score ? b : a); if (score > min.score * 1.1) Object.assign(min, frame, { image: capture(r, frame) }); }
        }
      }
      return { tick: r.tick, done: driver.done, drivenM: driver.progress * r.mpu, mph: sim.speed * r.mpu * R.MPH, limit: r.limit };
    };
    S.finish = () => {
      const r = S.run, sorted = a => Float64Array.from(a).sort(), pct = (a, q) => a.length ? +a[Math.min(a.length - 1, Math.max(0, Math.round(q / 100 * (a.length - 1))))].toFixed(2) : null;
      const travel = sorted(r.travel), jump = sorted(r.jump), gaps = sorted(r.gaps), body = sorted(r.body), boxBody = sorted(r.boxBody);
      const worstFrames = [], byScore = [...r.frames].sort((a, b) => b.score - a.score);
      for (const f of byScore) { if (worstFrames.length >= 20) break; if (worstFrames.every(w => Math.abs(w.tick - f.tick) >= 30)) worstFrames.push(f); }
      return {
        track: r.track.id, car: r.carId, route: r.route.source, start: r.start.teleported ? 'placed on route' : 'saved grid',
        lapM: +(r.driver.lapLength * r.mpu).toFixed(1), drivenM: +(r.driver.progress * r.mpu).toFixed(1), lapComplete: r.driver.done, lapFinishedGate: r.lapFinishedGate,
        frames: r.tick, seconds: +(r.tick / 60).toFixed(1), maxMph: +r.maxMph.toFixed(1), maxBankMph: +r.maxBankMph.toFixed(1), respawns: r.respawns, laneShare: +(r.laneFrames / Math.max(1, r.frames.length)).toFixed(4),
        wheelTravel: { maxCm: pct(travel, 100), p99Cm: pct(travel, 99), perWheelMaxCm: r.travelMax.map(t => +t.toFixed(2)), framesOver5cm: r.travel.filter(t => t > 5).length },
        bodyJump: { maxCm: pct(jump, 100), p99Cm: pct(jump, 99), framesOver3cm: r.jump.filter(j => j > 3).length },
        visibleTyreGap: { wheelFrames: gaps.length, frames: r.gapFrames, min: pct(gaps, 0), p1: pct(gaps, 1), p50: pct(gaps, 50), p99: pct(gaps, 99), max: pct(gaps, 100),
          frameInBandShare: +(r.gapFramesInBand / Math.max(1, r.gapFrames)).toFixed(4), wheelInBandShare: +(r.gapWheelsInBand / Math.max(1, gaps.length)).toFixed(4) },
        bodyBelowFloor: { frames: body.length, minCm: pct(body, 0), p1: pct(body, 1), p50: pct(body, 50), negativeFrames: r.body.filter(b => b < 0).length, negativeShare: +(r.body.filter(b => b < 0).length / Math.max(1, body.length)).toFixed(4), undersidePoints: r.underside.length },
        bodyBoxBottom: { minCm: pct(boxBody, 0), p1: pct(boxBody, 1), p50: pct(boxBody, 50) },
        worstFrames, kept: r.kept,
      };
    };
  });

  const runs = [], shotsByTrack = {};
  await mkdir(shotDir, { recursive: true });
  const header = 'track         car              lap%  max/bank mph  travel cm  jump cm  tyreGap p1/p50/p99 cm  inBand  body cm  box cm  result';
  console.log(header);
  for (const trackId of trackIds) {
    const candidates = [];
    for (const carId of carIds) {
      const started = Date.now();
      let info;
      try {
        info = await page.evaluate(args => window.__sva.begin(args), { trackId, carId, secondsLimit, shots, centerline: await centerlineJson(trackId) });
        let progress;
        do progress = await page.evaluate(n => window.__sva.advance(n), 600); while (!progress.done && progress.tick < progress.limit);
      } catch (error) {
        runs.push({ track: trackId, car: carId, error: String(error?.message ?? error), violations: [`harness error: ${String(error?.message ?? error).slice(0, 200)}`] });
        console.log(`${trackId.padEnd(13)} ${carId.padEnd(16)} ERROR ${error?.message ?? error}`);
        continue;
      }
      const result = await page.evaluate(() => window.__sva.finish());
      const { kept, ...summary } = result;
      Object.assign(summary, { setup: info });
      candidates.push(...kept.map(k => ({ ...k, car: carId, track: trackId })));
      const v = summary.violations = [];
      if (summary.wheelTravel.maxCm > TARGETS.wheelTravelMaxCm) v.push(`wheelTravel ${summary.wheelTravel.maxCm} cm > ${TARGETS.wheelTravelMaxCm}`);
      if (summary.bodyJump.maxCm > TARGETS.bodyJumpMaxCm) v.push(`bodyJump ${summary.bodyJump.maxCm} cm > ${TARGETS.bodyJumpMaxCm}`);
      if (summary.visibleTyreGap.frameInBandShare < TARGETS.tyreGapInBandShare) v.push(`visibleTyreGap in [-2,+4] cm on ${(summary.visibleTyreGap.frameInBandShare * 100).toFixed(1)}% of frames < 99%`);
      if (summary.bodyBelowFloor.minCm !== null && summary.bodyBelowFloor.minCm < TARGETS.bodyBelowFloorMinCm) v.push(`bodyBelowFloor ${summary.bodyBelowFloor.minCm} cm`);
      if (!summary.lapComplete && secondsLimit === undefined) v.push(`driver: lap incomplete (${summary.drivenM}/${summary.lapM} m)`);
      if (summary.respawns) v.push(`respawns ${summary.respawns}`);
      runs.push(summary);
      const s = summary, g = s.visibleTyreGap;
      console.log(`${s.track.padEnd(13)} ${s.car.padEnd(16)} ${(s.drivenM / s.lapM * 100).toFixed(0).padStart(4)}  ${`${s.maxMph.toFixed(0)}/${s.maxBankMph.toFixed(0)}`.padEnd(12)} ${String(s.wheelTravel.maxCm).padStart(9)} ${String(s.bodyJump.maxCm).padStart(8)}  ${`${g.p1}/${g.p50}/${g.p99}`.padEnd(22)} ${(g.frameInBandShare * 100).toFixed(1).padStart(6)}% ${String(s.bodyBelowFloor.minCm).padStart(7)} ${String(s.bodyBoxBottom.minCm).padStart(7)}  ${v.length ? 'FAIL' : 'pass'}  (${((Date.now() - started) / 1000).toFixed(0)} s)`);
      for (const violation of v) console.log(`    - ${violation}`);
    }
    // The `shots` worst frames of this track across its cars, with the metrics drawn in and in the file name.
    const chosen = [];
    for (const c of candidates.sort((a, b) => b.score - a.score)) { if (chosen.length >= shots) break; if (chosen.every(o => o.car !== c.car || Math.abs(o.tick - c.tick) >= 60)) chosen.push(c); }
    shotsByTrack[trackId] = [];
    for (const [rank, c] of chosen.entries()) {
      const fmt = n => n === null || n === undefined ? 'na' : (Math.round(n * 10) / 10).toFixed(1);
      const gapRange = c.tyreGapCm.length ? `${fmt(Math.min(...c.tyreGapCm))}..${fmt(Math.max(...c.tyreGapCm))}` : 'na';
      const file = `${shotDir}/${trackId}-${rank + 1}-${c.car}-t${c.tick}-d${Math.round(c.distanceM)}m-${c.metric}-score${fmt(c.score)}-travel${fmt(c.wheelTravelCm)}cm-jump${fmt(c.bodyJumpCm)}cm-gap${gapRange}cm-body${fmt(c.bodyBelowFloorCm)}cm.png`;
      const image = await loadImage(Buffer.from(c.image.split(',')[1], 'base64'));
      const canvas = createCanvas(image.width, image.height), ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      const lines = [`${trackId} · ${c.car} · tick ${c.tick} · ${c.distanceM} m · lateral ${c.lateralM} m · ${c.speedMph} mph`, `worst: ${c.metric} (score ${c.score}; >1 violates)`,
        `wheelTravel ${fmt(c.wheelTravelCm)} cm (<=5)   bodyJump ${fmt(c.bodyJumpCm)} cm (<=3)`, `tyreGap ${c.tyreGapCm.map(fmt).join(' / ') || 'na'} cm ([-2,+4])`, `bodyBelowFloor ${fmt(c.bodyBelowFloorCm)} cm (>=0)   box ${fmt(c.bodyBoxBottomCm)} cm`];
      ctx.fillStyle = 'rgba(0,0,0,.62)'; ctx.fillRect(10, 10, 640, 24 * lines.length + 14);
      ctx.font = '17px sans-serif'; ctx.fillStyle = '#fff';
      lines.forEach((line, i) => ctx.fillText(line, 20, 34 + i * 24));
      await writeFile(file, canvas.toBuffer('image/png'));
      const { image: _, ...meta } = c;
      shotsByTrack[trackId].push({ ...meta, file });
    }
  }
  const failed = runs.filter(r => r.violations.length);
  if (pageErrors.length) console.log(`page errors: ${pageErrors.length}\n  ${pageErrors.slice(0, 5).join('\n  ')}`);
  const pass = failed.length === 0 && pageErrors.length === 0;
  const report = { generated: new Date().toISOString(), base, saved: boot.source, bootMatchesSaved: boot.bootMatches, label, cli: process.argv.slice(2), targets: TARGETS,
    units: 'cm (world units * track.metersPerUnit * 100); one frame = one physics tick rendered with world.chase(sim, 1/60)', pass, runs, screenshots: shotsByTrack, pageErrors, consoleErrors: consoleErrors.slice(0, 50) };
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(report, null, 1));
  console.log(`${pass ? 'PASS' : 'FAIL'}: ${runs.length - failed.length}/${runs.length} runs within targets${pageErrors.length ? `, ${pageErrors.length} page errors` : ''}. Report: ${outPath}  Screenshots: ${shotDir}/`);
  exitCode = pass ? 0 : 1;
} catch (error) {
  console.error(error); exitCode = 2;
} finally {
  await browser.close();
  await vite?.close();
}
process.exit(exitCode);
