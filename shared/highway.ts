/**
 * The Endless Highway: a divided six-lane highway generated from a seed, as long as anyone drives it, in either direction.
 *
 * Everything here is plain arithmetic in float64 (no Three, no Rapier), so the simulation, the renderer and the tests
 * build the same road. The centreline's heading and height are smooth functions of the distance s along it; positions
 * are integrated chunk by chunk (CHUNK metres, a sample every STEP metres) outwards from s = 0, so a chunk's first
 * sample is exactly the previous chunk's last.
 *
 * Cross-section, by lateral offset `lat` (metres to the right of the direction of increasing s): a concrete median
 * barrier on the centreline, then each carriageway's inner shoulder, three lanes and an outer shoulder, a guardrail at
 * ±RAIL and a gravel verge dropping into a ditch and the desert beyond. Traffic keeps right: lat > 0 drives towards
 * increasing s, lat < 0 the other way.
 */

/** Metres in a mile: the mile posts count them from s = 0 (the game reads speed in mph). */
export const MILE = 1609.344;
/** Metres per chunk, and between centreline samples. */
export const CHUNK = 200, STEP = 5, SAMPLES = CHUNK / STEP + 1;
export const LANE_WIDTH = 3.7, LANES = 3;
/** Inner edge of the fast lane, the outer edge of the slow lane, the edge of the paved shoulder, and the guardrail line. */
export const LANE_INNER = 1.6, LANE_OUTER = LANE_INNER + LANES * LANE_WIDTH, ROAD_EDGE = LANE_OUTER + 3, RAIL = ROAD_EDGE + .45;
/** Half-width of the median barrier's base and its height. */
export const MEDIAN_HALF = .3, MEDIAN_HEIGHT = .82;
/** Guardrail height (top of the beam) and the terrain's reach from the centreline. */
export const RAIL_HEIGHT = .78, TERRAIN_REACH = 460;

/** Centre of lane 0-5 as a lateral offset: 0-2 run with s (0 is the fast lane by the median), 3-5 against it. */
export const laneCentre = (lane: number) => lane < LANES ? LANE_INNER + (lane + .5) * LANE_WIDTH : -(LANE_INNER + (lane - LANES + .5) * LANE_WIDTH);
/** Whether a lane runs with increasing s. */
export const forwardLane = (lane: number) => lane < LANES;

export type HighwaySample = {
  s: number; x: number; y: number; z: number;
  /** Direction of travel (radians: 0 faces +z, increasing turns towards +x, i.e. left) and slope dy/ds. */
  heading: number; grade: number;
  /** Superelevation: the road's height changes by bank metres per metre of lat. */
  bank: number;
};
export type PropKind = 'marker' | 'sign' | 'gantry' | 'overpass' | 'pole' | 'tree' | 'shrub' | 'rock' | 'delineator';
/** Something standing beside the road: where (s, lat), turned by yaw from the road's heading, and its size. */
export type Prop = { kind: PropKind; s: number; lat: number; yaw: number; scale: number; variant: number };
export type HighwayChunk = { index: number; s0: number; samples: HighwaySample[]; props: Prop[] };

/** 32-bit hash of integers, for seeded value noise and prop placement. */
function hash(seed: number, a: number, b = 0) {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(a | 0, 0xc2b2ae35) ^ Math.imul(b | 0, 0x27d4eb2f);
  h = Math.imul(h ^ h >>> 15, 0x2c1b3c6d); h = Math.imul(h ^ h >>> 12, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
/** Quintic fade: continuous slope and curvature, so the road's curvature never jumps. */
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
/** Smooth 1D value noise in [-1, 1], one random value every `scale` metres. */
function noise(seed: number, s: number, scale: number) {
  const u = s / scale, i = Math.floor(u), t = u - i;
  const a = hash(seed, i) * 2 - 1, b = hash(seed, i + 1) * 2 - 1;
  return a + (b - a) * fade(t);
}
/** Smooth 2D value noise in [-1, 1] for the desert floor. */
function noise2(seed: number, x: number, z: number, scale: number) {
  const u = x / scale, v = z / scale, i = Math.floor(u), j = Math.floor(v), tu = fade(u - i), tv = fade(v - j);
  const corner = (di: number, dj: number) => hash(seed, i + di, j + dj) * 2 - 1;
  const top = corner(0, 0) + (corner(1, 0) - corner(0, 0)) * tu, bottom = corner(0, 1) + (corner(1, 1) - corner(0, 1)) * tu;
  return top + (bottom - top) * tv;
}
const smooth = (edge0: number, edge1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0))); return t * t * (3 - 2 * t); };

/**
 * The road for one seed. Chunks are built on demand and cached; release() forgets the ones far behind. Chunk start
 * positions are kept for every chunk built so far (two numbers each), since each chunk starts where the last ended.
 */
export class HighwayRoad {
  private chunks = new Map<number, HighwayChunk>();
  /** Centreline x, z at the start of each chunk built (index → [x, z]). */
  private starts = new Map<number, [number, number]>([[0, [0, 0]]]);
  constructor(readonly seed: number) {}

  /**
   * Heading at s: long sweeping bends (radius 800 m and up) with straights between, around a mean heading of 0 so the
   * road never loops back on itself.
   */
  heading(s: number) { return .4 * noise(this.seed + 11, s, 2000) + .07 * noise(this.seed + 12, s, 600); }
  /** Height of the centreline at s: rolling, never steeper than about 3%. */
  height(s: number) { return 10 * noise(this.seed + 21, s, 1700) + 1.5 * noise(this.seed + 22, s, 500); }
  /** Superelevation from the curvature: the outside of a bend raised up to 3.5%. */
  bank(s: number) {
    const curvature = (this.heading(s + 2) - this.heading(s - 2)) / 4;
    return Math.max(-.035, Math.min(.035, curvature * 30));
  }

  /** The chunk holding distance s. */
  indexOf(s: number) { return Math.floor(s / CHUNK); }
  chunk(index: number): HighwayChunk {
    const known = this.chunks.get(index); if (known) return known;
    const [x0, z0] = this.start(index), s0 = index * CHUNK, samples: HighwaySample[] = [];
    let x = x0, z = z0;
    for (let k = 0; k < SAMPLES; k++) {
      const s = s0 + k * STEP;
      if (k) { const [dx, dz] = this.advance(s - STEP); x += dx; z += dz; }
      samples.push({ s, x, y: this.height(s), z, heading: this.heading(s), grade: (this.height(s + .5) - this.height(s - .5)), bank: this.bank(s) });
    }
    // The next chunk starts exactly here. Behind s = 0 the next start came first (integrated backwards): end on it exactly.
    const next = this.starts.get(index + 1);
    if (next) { samples[SAMPLES - 1].x = next[0]; samples[SAMPLES - 1].z = next[1]; } else this.starts.set(index + 1, [x, z]);
    const chunk = { index, s0, samples, props: this.placeProps(index, s0) };
    this.chunks.set(index, chunk);
    return chunk;
  }
  /** Simpson's rule over one STEP from s: the centreline's travel in x and z. */
  private advance(s: number): [number, number] {
    const a = this.heading(s), m = this.heading(s + STEP / 2), b = this.heading(s + STEP);
    return [STEP / 6 * (Math.sin(a) + 4 * Math.sin(m) + Math.sin(b)), STEP / 6 * (Math.cos(a) + 4 * Math.cos(m) + Math.cos(b))];
  }
  /** Start of a chunk: walked outwards from the nearest chunk already known, forwards or backwards. */
  private start(index: number): [number, number] {
    const known = this.starts.get(index); if (known) return known;
    if (index > 0) { this.chunk(index - 1); return this.starts.get(index)!; }
    // Behind s = 0: integrate backwards from the start of the chunk after this one.
    const [x1, z1] = this.start(index + 1);
    let x = x1, z = z1;
    for (let k = SAMPLES - 1; k > 0; k--) { const [dx, dz] = this.advance((index * CHUNK) + (k - 1) * STEP); x -= dx; z -= dz; }
    this.starts.set(index, [x, z]);
    return [x, z];
  }
  /** Forgets chunks outside [from, to] (their starts are kept). */
  release(from: number, to: number) { for (const index of this.chunks.keys()) if (index < from || index > to) this.chunks.delete(index); }

  /** The centreline at s, between samples. */
  at(s: number): HighwaySample {
    const chunk = this.chunk(this.indexOf(s)), u = (s - chunk.s0) / STEP, k = Math.min(SAMPLES - 2, Math.floor(u)), t = u - k;
    const a = chunk.samples[k], b = chunk.samples[k + 1];
    // Position along the chord is within millimetres of the arc at these radii; heading and height come exact.
    return { s, x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, y: this.height(s), heading: this.heading(s), grade: a.grade + (b.grade - a.grade) * t, bank: a.bank + (b.bank - a.bank) * t };
  }
  /** A point on the road surface at (s, lat), lifted `lift` metres. */
  point(s: number, lat: number, lift = 0) { return pointOn(this.at(s), lat, lift); }
  /** Where a lane's centre is at s, and which way its traffic faces. */
  lanePose(s: number, lane: number) {
    const sample = this.at(s), p = pointOn(sample, laneCentre(lane));
    return { ...p, heading: forwardLane(lane) ? sample.heading : sample.heading + Math.PI, grade: forwardLane(lane) ? sample.grade : -sample.grade };
  }
  /**
   * Distance along the road and lateral offset of a world point, searched within `reach` metres of a guess. Exact for
   * points near the road; used for scoring, traffic and recovery.
   */
  project(x: number, z: number, guess: number, reach = 60): { s: number; lat: number } {
    let best = Infinity, bestS = guess, bestLat = 0;
    const from = Math.floor((guess - reach) / STEP) * STEP, to = guess + reach;
    let previous = this.at(from);
    for (let s = from + STEP; s <= to + STEP; s += STEP) {
      const next = this.at(s), ex = next.x - previous.x, ez = next.z - previous.z, l2 = ex * ex + ez * ez || 1;
      const t = Math.min(1, Math.max(0, ((x - previous.x) * ex + (z - previous.z) * ez) / l2));
      const px = previous.x + ex * t, pz = previous.z + ez * t, d = (x - px) ** 2 + (z - pz) ** 2;
      if (d < best) {
        best = d; bestS = previous.s + STEP * t;
        const h = previous.heading + (next.heading - previous.heading) * t;
        bestLat = (x - px) * -Math.cos(h) + (z - pz) * Math.sin(h);
      }
      previous = next;
    }
    return { s: bestS, lat: bestLat };
  }

  /**
   * Height of the ground at (s, lat), the road surface included: paved out to the guardrail, a gravel verge falling to a
   * shallow ditch, then the desert's low dunes and washes rising and falling either side.
   */
  ground(s: number, lat: number) {
    const sample = this.at(s), a = Math.abs(lat);
    const road = sample.y + sample.bank * Math.max(-RAIL - 1.5, Math.min(RAIL + 1.5, lat));
    if (a <= RAIL + 1.5) return road;
    const p = pointOn(sample, lat);
    // Ditch: down 0.9 m at RAIL + 6, back up by RAIL + 12.
    const ditch = -.9 * smooth(RAIL + 1.5, RAIL + 6, a) * (1 - smooth(RAIL + 6, RAIL + 13, a));
    // Near the road the desert is nearly flat (low hummocks and washes); further out it rolls into hills.
    const near = 1.6 * noise2(this.seed + 32, p.x, p.z, 70) + 2.4 * noise2(this.seed + 31, p.x, p.z, 260);
    const hills = 9 * noise2(this.seed + 33, p.x, p.z, 700) + 26 * Math.max(0, noise2(this.seed + 34, p.x, p.z, 1600));
    return road + ditch + (near + 1) * smooth(RAIL + 8, RAIL + 60, a) + (hills + 3) * smooth(120, TERRAIN_REACH, a);
  }

  /**
   * Roadside furniture and scenery for one chunk, from the seed and the chunk index alone: guardrail delineators, the
   * kilometre markers, the occasional guide sign, gantry and overpass, a pole line, and desert plants and rocks.
   */
  private placeProps(index: number, s0: number): Prop[] {
    const props: Prop[] = [], r = (n: number) => hash(this.seed + 41, index, n);
    let n = 0;
    for (let s = s0; s < s0 + CHUNK; s += 50) for (const side of [-1, 1]) props.push({ kind: 'delineator', s, lat: side * (RAIL + .35), yaw: 0, scale: 1, variant: 0 });
    // Mile posts on the outer edge of each carriageway, wherever a whole mile from the start falls in this chunk.
    const mile = Math.ceil(s0 / MILE);
    if (mile * MILE < s0 + CHUNK) for (const side of [1, -1]) props.push({ kind: 'marker', s: mile * MILE, lat: side * (RAIL + 1.2), yaw: 0, scale: 1, variant: mile });
    // Every few kilometres: an overpass, a gantry or a guide sign, never two in one chunk.
    const feature = r(n++);
    if (index % 17 === 3 && feature < .75) props.push({ kind: 'overpass', s: s0 + 100, lat: 0, yaw: (r(n++) - .5) * .5, scale: 1, variant: Math.floor(r(n++) * 4) });
    else if (index % 23 === 11) props.push({ kind: 'gantry', s: s0 + 80, lat: 0, yaw: 0, scale: 1, variant: index });
    else if (index % 6 === 1 && feature < .6) props.push({ kind: 'sign', s: s0 + 60, lat: RAIL + 2.5, yaw: 0, scale: 1, variant: index });
    // A wooden pole line on the far side, one pole every 60 m (by distance, so it runs on unbroken across chunks).
    for (let s = Math.ceil(s0 / 60) * 60; s < s0 + CHUNK; s += 60) props.push({ kind: 'pole', s, lat: -(RAIL + 34), yaw: 0, scale: 1, variant: 0 });
    // Desert plants and rocks: thicker in patches (a slow noise along the road), sparse close to the verge.
    const density = .55 + .45 * noise(this.seed + 51, s0, 1500);
    const plants = Math.round(70 * density);
    for (let k = 0; k < plants; k++) {
      const side = r(n++) < .5 ? -1 : 1, reach = RAIL + 9 + Math.pow(r(n++), 1.6) * (TERRAIN_REACH - RAIL - 40);
      const roll = r(n++), kind: PropKind = roll < .62 ? 'shrub' : roll < .82 ? 'rock' : 'tree';
      // Keep the pole line's corridor clear.
      if (side < 0 && Math.abs(reach - (RAIL + 34)) < 4) continue;
      props.push({ kind, s: s0 + r(n++) * CHUNK, lat: side * reach, yaw: r(n++) * Math.PI * 2, scale: kind === 'tree' ? .75 + r(n++) * .55 : kind === 'rock' ? .5 + Math.pow(r(n++), 2) * 2.4 : .6 + r(n++) * .8, variant: Math.floor(r(n++) * 4) });
    }
    return props;
  }
}

/** A point at lateral offset lat from a centreline sample (on the banked road plane), lifted `lift` metres. */
export function pointOn(sample: HighwaySample, lat: number, lift = 0) {
  return { x: sample.x - Math.cos(sample.heading) * lat, y: sample.y + sample.bank * lat + lift, z: sample.z + Math.sin(sample.heading) * lat };
}
