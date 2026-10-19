// Visual surface maps for the racing-line bake: what each half-metre of every circuit LOOKS like from above.
//
//   npm run dev   (in another terminal; or set GAME_URL to a running dev server)
//   node --import tsx design/build-venue-surface.ts [--track=id[,id]]
//
// The collision mesh's surface labels come from whole materials, so texture atlases mixing asphalt and grass label
// real road as grass and gravel traps as asphalt in places. This draws each venue straight down, unlit, in tiles
// along its drive trace (tests/racing-line-inspection.html, in the installed Google Chrome via Playwright),
// clipped to the road's level, and classifies every pixel by colour: near-neutral grey is road (asphalt,
// concrete), red is kerb, green is grass, warm beige is gravel or sand, and white wider than paint (a banner or
// logo lying on the run-off) is off the track. A 5x5 majority vote removes texture speckle;
// cells that are too dark or mixed to call stay unknown, and the bake falls back to the collision label there.
//
// Output: design/surfaces/<id>.bin.gz: int32 header [x0*100, z0*100, cell*1000, width, height] then one byte per
// cell (0 road, 1 grass, 2 gravel, 255 unknown), rows from -z.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { TRACKS } from '../shared/tracks';

const arg = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const only = arg('track')?.split(','), base = process.env.GAME_URL ?? 'http://127.0.0.1:5173';
/** Cell size (native units), tile size (cells), and how far from the trace the map reaches (native units). */
const CELL = .5, TILE = 128, REACH = 45;
export const SURFACE_ROAD = 0, SURFACE_GRASS = 1, SURFACE_GRAVEL = 2, SURFACE_UNKNOWN = 255;
/** Raw class for white pixels, sorted out once the whole map is in (see below). */
const WHITE = 254;

/** One pixel (linear 0-255 from the render target) to a surface class. */
function classify(r: number, g: number, b: number) {
  const srgb = (v: number) => 255 * Math.pow(v / 255, 1 / 2.2);
  r = srgb(r); g = srgb(g); b = srgb(b);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), saturation = (max - min) / (max || 1);
  if (max < 40) return SURFACE_UNKNOWN;                          // nothing drawn, or too dark to judge
  if (min > 205) return WHITE;                                   // painted lines on the road, or banners lying on the run-off
  if (r > g * 1.35 && r > b * 1.35) return SURFACE_ROAD;         // red kerb
  if (saturation < .12) return SURFACE_ROAD;                     // near neutral: asphalt (some venues' is warm), concrete, paint
  // Grass and gravel both have clearly less blue than green; tinted asphalt does not.
  if (g > r + 2 && g - b >= 8) return SURFACE_GRASS;             // green-dominant
  if (r >= g - 2 && g - b >= 10) return SURFACE_GRAVEL;          // warm: gravel, sand, dirt
  return SURFACE_ROAD;                                           // blue or other painted markings, tinted asphalt
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  mkdirSync('design/surfaces', { recursive: true });
  for (const track of TRACKS) {
    if (only && !only.includes(track.id)) continue;
    const trace = track.mapPath!;
    const x0 = Math.min(...trace.map(p => p.x)) - REACH, z0 = Math.min(...trace.map(p => p.z)) - REACH;
    const W = Math.ceil((Math.max(...trace.map(p => p.x)) + REACH - x0) / CELL), H = Math.ceil((Math.max(...trace.map(p => p.z)) + REACH - z0) / CELL);
    const raw = new Uint8Array(W * H).fill(SURFACE_UNKNOWN);
    const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
    await page.goto(`${base}/tests/racing-line-inspection.html?track=${track.id}`);
    await page.waitForFunction(() => (window as unknown as { __venueReady?: () => boolean }).__venueReady?.(), null, { timeout: 300000 });
    const span = TILE * CELL;
    let tiles = 0;
    for (let tz = 0; tz * TILE < H; tz++) for (let tx = 0; tx * TILE < W; tx++) {
      const cx = x0 + (tx + .5) * span, cz = z0 + (tz + .5) * span;
      // Only tiles the trace passes near, clipped to the road's level there.
      const near = trace.filter(p => Math.abs(p.x - cx) < span / 2 + REACH && Math.abs(p.z - cz) < span / 2 + REACH);
      if (!near.length) continue;
      const top = Math.max(...near.map(p => p.y)) + 4, bottom = Math.min(...near.map(p => p.y)) - 5;
      const b64 = await page.evaluate(([x, z, size, pixels, t, b]) => (window as unknown as { __albedoTile: (...a: number[]) => Promise<string> }).__albedoTile(x, z, size, pixels, t, b), [cx, cz, span, TILE, top, bottom]);
      const rgba = Buffer.from(b64, 'base64');
      for (let r = 0; r < TILE; r++) for (let c = 0; c < TILE; c++) {
        const gx = tx * TILE + c, gz = tz * TILE + r;
        if (gx >= W || gz >= H) continue;
        const k = (r * TILE + c) * 4;
        raw[gz * W + gx] = classify(rgba[k], rgba[k + 1], rgba[k + 2]);
      }
      tiles++;
    }
    await page.close();
    // White wider than 2.5 m (it survives a 5x5 erosion) is a banner or logo lying beside the road: off the track.
    // Thinner white is paint on the road; it stays unknown and takes its neighbours' class below.
    const wide = new Uint8Array(W * H);
    for (let z = 2; z < H - 2; z++) for (let x = 2; x < W - 2; x++) {
      let all = true;
      for (let dz = -2; dz <= 2 && all; dz++) for (let dx = -2; dx <= 2 && all; dx++) all = raw[(z + dz) * W + x + dx] === WHITE;
      if (all) for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) wide[(z + dz) * W + x + dx] = 1;
    }
    for (let k = 0; k < W * H; k++) if (raw[k] === WHITE) raw[k] = wide[k] ? SURFACE_GRAVEL : SURFACE_UNKNOWN;
    // 5x5 majority vote; a winner needs 60% of the known cells, and at least half the window known.
    const surface = new Uint8Array(W * H).fill(SURFACE_UNKNOWN), counts = [0, 0, 0];
    for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
      counts.fill(0);
      let known = 0;
      for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
        const X = x + dx, Z = z + dz;
        if (X < 0 || Z < 0 || X >= W || Z >= H) continue;
        const c = raw[Z * W + X];
        if (c !== SURFACE_UNKNOWN) { counts[c]++; known++; }
      }
      if (known < 13) continue;
      const best = counts.indexOf(Math.max(...counts));
      if (counts[best] >= known * .6) surface[z * W + x] = best;
    }
    const header = new Int32Array([Math.round(x0 * 100), Math.round(z0 * 100), Math.round(CELL * 1000), W, H]);
    const file = gzipSync(Buffer.concat([Buffer.from(header.buffer), Buffer.from(surface)]), { level: 9 });
    writeFileSync(`design/surfaces/${track.id}.bin.gz`, file);
    const share = (c: number) => (surface.filter(v => v === c).length / surface.filter(v => v !== SURFACE_UNKNOWN).length * 100).toFixed(0);
    console.log(`${track.id.padEnd(12)} ${tiles} tiles, ${W}x${H} cells, road ${share(SURFACE_ROAD)}% grass ${share(SURFACE_GRASS)}% gravel ${share(SURFACE_GRAVEL)}% of known, ${(file.length / 1024).toFixed(0)} kB`);
  }
} finally {
  await browser.close();
}
