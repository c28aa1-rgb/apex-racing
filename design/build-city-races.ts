/**
 * Builds the city street races from the road map: each route is stitched from pieces of the city's roads (curved
 * through the junctions), given timing gates, a start box, and a police roadblock across every road that leaves it.
 *
 *   npm run build:city-races        (after build:city, which writes the road map)
 *
 * Writes shared/city-races.data.ts, read by the game and the server alike (the roadblocks are solid).
 */
import { readFileSync, writeFileSync } from 'node:fs';

type Road = { name: string; district: string; width: number; closed: boolean; points: number[][] };
/** Traffic cruising speed by district (m/s), as in src/city-traffic.ts. */
const DISTRICT_SPEED: Record<string, number> = { Highway: 29, Outer: 20, Industrial: 15, Commercial: 15, Downtown: 13, Training: 15 };
const roads: Road[] = JSON.parse(readFileSync('public/models/tracks/racing-city.map.json', 'utf8')).paths;
const road = (name: string) => roads.find(r => r.name === name)!;

/** A route: pieces of roads, each from one point index to another (wrapping on closed roads, either direction). */
type Piece = { road: string; from: number; to: number; dir: 1 | -1 };
type RaceSpec = {
  id: string; name: string; subtitle: string; description: string; accent: string; laps: number; closed: boolean;
  pieces: Piece[]; start: number; finish?: number; medals: [number, number, number];
};
const RACES: RaceSpec[] = [
  {
    id: 'city-grand-loop', name: 'Grand Loop', subtitle: 'Downtown · 2 laps', accent: '#ff5d5d', laps: 2, closed: true,
    description: 'Two laps of downtown: flat out along Grand Avenue, then the long sweep round the south side of Founders Loop. Traffic stays on the road.',
    pieces: [{ road: 'GrandAvenue', from: 0, to: 100, dir: 1 }, { road: 'FoundersLoop', from: 114, to: 280, dir: -1 }],
    start: 40, medals: [0, 0, 0],
  },
  {
    id: 'city-ridge-sprint', name: 'Ridge Sprint', subtitle: 'Coast to downtown', accent: '#ffb347', laps: 1, closed: false,
    description: 'Up the coastal expressway at full speed, onto Commerce Circuit, then over the Ridge Run crest and down into downtown.',
    pieces: [{ road: 'CoastalExpressway', from: 220, to: 0, dir: -1 }, { road: 'CommerceCircuit', from: 75, to: 103, dir: 1 }, { road: 'RidgeRun', from: 257, to: 8, dir: -1 }],
    start: 25, medals: [0, 0, 0],
  },
];

type P = { x: number; y: number; z: number; w: number; v: number };
const lerp = (a: P, b: P, t: number): P => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t, w: a.w + (b.w - a.w) * t, v: Math.min(a.v, b.v) });
const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

/** The point indices a piece covers, in driving order. */
function indices(piece: Piece) {
  const r = road(piece.road), n = r.points.length, out: number[] = [];
  // Closed roads repeat their first point at the end; step over the duplicate when wrapping.
  const count = r.closed && dist(at(r, 0), at(r, n - 1)) < .5 ? n - 1 : n;
  for (let i = piece.from; ; i = (i + piece.dir + count) % count) { out.push(i); if (i === piece.to || out.length > count) break; }
  return out;
}
const at = (r: Road, i: number): P => ({ x: r.points[i][0], y: r.points[i][1], z: r.points[i][2], w: r.width, v: DISTRICT_SPEED[r.district] ?? 15 });

/** Joins the pieces with a curve through each junction (and the last back to the first on a loop), at 5 m spacing. */
function stitch(spec: RaceSpec) {
  const parts = spec.pieces.map(piece => indices(piece).map(i => at(road(piece.road), i)));
  const trim = (part: P[], fromEnd: boolean, metres: number) => {
    const list = fromEnd ? [...part].reverse() : [...part]; let left = metres;
    while (list.length > 2 && left > 0) { left -= dist(list[0], list[1]); list.shift(); }
    return fromEnd ? list.reverse() : list;
  };
  const R = 16, line: P[] = [];
  // Traffic takes the junction curves at turning speed.
  const corner = (a: P, j: P, b: P) => { const out: P[] = []; for (let k = 1; k < 8; k++) { const t = k / 8, p = lerp(lerp(a, j, t), lerp(j, b, t), t); out.push({ ...p, v: Math.min(p.v, 8) }); } return out; };
  const pieces = parts.map((part, i) => {
    let p = part;
    if (i > 0 || spec.closed) p = trim(p, false, R);
    if (i < parts.length - 1 || spec.closed) p = trim(p, true, R);
    return p;
  });
  for (let i = 0; i < pieces.length; i++) {
    line.push(...pieces[i]);
    const next = pieces[i + 1] ?? (spec.closed ? pieces[0] : undefined);
    if (next) line.push(...corner(pieces[i].at(-1)!, parts[i].at(-1)!, next[0]));
  }
  // Even spacing.
  const out: P[] = [line[0]]; let carry = 0;
  const loop = spec.closed ? [...line, line[0]] : line;
  for (let i = 1; i < loop.length; i++) {
    const a = loop[i - 1], b = loop[i], l = dist(a, b); let s = 5 - carry;
    while (s <= l) { out.push(lerp(a, b, s / l)); s += 5; }
    carry = l - (s - 5);
  }
  if (spec.closed && dist(out.at(-1)!, out[0]) < 2.5) out.pop();
  return out;
}

/** Distance along the route to the nearest point, and how far off it. */
function nearest(route: P[], closed: boolean, x: number, z: number) {
  let best = { d: Infinity, i: 0, t: 0 };
  const n = closed ? route.length : route.length - 1;
  for (let i = 0; i < n; i++) {
    const a = route[i], b = route[(i + 1) % route.length], dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / l2)), d = Math.hypot(x - a.x - dx * t, z - a.z - dz * t);
    if (d < best.d) best = { d, i, t };
  }
  return best;
}
const heading = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.atan2(b.x - a.x, b.z - a.z);
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Roadblocks: every road point inside the route's corridor whose neighbour leaves it, where that neighbour is not
 * part of the route, is a road leaving the race. A line of police cars goes across it a few metres out, with an
 * invisible wall behind them reaching over the sidewalks.
 */
function roadblocks(spec: RaceSpec, route: P[]) {
  const onRoute = new Map<string, Set<number>>();
  for (const piece of spec.pieces) { const set = onRoute.get(piece.road) ?? new Set(); for (const i of indices(piece)) set.add(i); onRoute.set(piece.road, set); }
  const halfAt = (x: number, z: number) => { const n = nearest(route, spec.closed, x, z); return { d: n.d, half: route[n.i].w / 2, n }; };
  // A sprint's own ends are open: the start and finish are the race's limits.
  const ends = spec.closed ? [] : [route[0], route.at(-1)!];
  const blocks: { x: number; y: number; z: number; heading: number; width: number; road: string }[] = [];
  for (const r of roads) {
    const n = r.points.length, own = onRoute.get(r.name) ?? new Set<number>();
    const inside = r.points.map(p => { const h = halfAt(p[0], p[2]); return h.d < h.half + 1.5; });
    for (let i = 0; i < n; i++) for (const step of [1, -1]) {
      const j = r.closed ? (i + step + n) % n : i + step; if (j < 0 || j >= n) continue;
      if (!inside[i] || inside[j] || own.has(j)) continue;
      // Walk out along the road until a few metres clear of the corridor.
      let k = j, guard = 0;
      while (guard++ < 30) { const p = r.points[k], h = halfAt(p[0], p[2]); if (h.d > h.half + 5) break; const next = r.closed ? (k + step + n) % n : k + step; if (next < 0 || next >= n) break; k = next; }
      const p = r.points[k], back = r.points[r.closed ? (k - step + n) % n : Math.max(0, Math.min(n - 1, k - step))];
      if (ends.some(e => dist(e, { x: p[0], z: p[2] }) < 60)) continue;
      if (blocks.some(b => dist(b, { x: p[0], z: p[2] }) < 12)) continue;
      blocks.push({ x: p[0], y: p[1], z: p[2], heading: heading({ x: back[0], z: back[2] }, { x: p[0], z: p[2] }), width: r.width, road: r.name });
    }
  }
  return blocks.map(b => {
    // Cars across the road, angled alternately, nose-to-tail in a line; the wall spans the road and sidewalks.
    const across = { x: -Math.cos(b.heading), z: Math.sin(b.heading) }, count = Math.max(2, Math.ceil(b.width / 5));
    const cars = Array.from({ length: count }, (_, k) => {
      const o = (k + .5) * b.width / count - b.width / 2;
      return [r3(b.x + across.x * o), r3(b.y), r3(b.z + across.z * o), r3(b.heading + Math.PI / 2 + (k % 2 ? .35 : -.35)), k % 2];
    });
    // Shorten the wall wherever it would reach back into the race's corridor.
    const reach = (side: number) => { let l = b.width / 2; while (l < b.width / 2 + 8) { const x = b.x + across.x * side * (l + .5), z = b.z + across.z * side * (l + .5), h = halfAt(x, z); if (h.d < h.half + 1) break; l += .5; } return l; };
    const left = reach(-1), right = reach(1), mid = (right - left) / 2;
    return { x: r3(b.x), y: r3(b.y), z: r3(b.z), heading: r3(b.heading), road: b.road, cars,
      wall: { x: r3(b.x + across.x * mid), y: r3(b.y), z: r3(b.z + across.z * mid), heading: r3(b.heading), length: r3(left + right) } };
  });
}

const out = RACES.map(spec => {
  const route = stitch(spec), length = route.length * 5;
  // Timing gates about every 150 m; on a loop the start line closes each lap.
  const gate = (i: number) => { const a = route[(i - 1 + route.length) % route.length], b = route[(i + 1) % route.length], p = route[i]; return { x: r3(p.x), y: r3(p.y), z: r3(p.z), heading: r3(heading(a, b)), width: r3(p.w + 4) }; };
  const startIndex = Math.round(spec.start / 5), finishIndex = spec.closed ? startIndex : route.length - 4;
  const lapGates: ReturnType<typeof gate>[] = [];
  const span = spec.closed ? route.length : finishIndex - startIndex;
  for (let s = 30; s < span - 18; s += 30) lapGates.push(gate((startIndex + s) % route.length));
  const checkpoints: ReturnType<typeof gate>[] = [];
  for (let lap = 0; lap < spec.laps; lap++) { if (lap > 0) checkpoints.push(gate(startIndex)); checkpoints.push(...lapGates); }
  // The start box: in the right-hand lanes, just behind the start line.
  const start = gate(startIndex), boxCentre = route[(startIndex - 2 + route.length) % route.length], right = { x: -Math.cos(start.heading), z: Math.sin(start.heading) };
  const zone = { x: r3(boxCentre.x + right.x * 4.5), y: r3(boxCentre.y), z: r3(boxCentre.z + right.z * 4.5), heading: start.heading, w: 7, l: 11 };
  const blocks = roadblocks(spec, route);
  console.log(`${spec.name}: ${length} m a lap, ${checkpoints.length} gates, ${blocks.length} roadblocks (${blocks.map(b => b.road).join(', ')})`);
  return { id: spec.id, name: spec.name, subtitle: spec.subtitle, description: spec.description, accent: spec.accent, laps: spec.laps, closed: spec.closed, medals: spec.medals,
    length: length * spec.laps, route: route.map(p => [r3(p.x), r3(p.y), r3(p.z), r3(p.w), p.v]), start, finish: gate(finishIndex), zone, checkpoints, roadblocks: blocks };
});
writeFileSync('shared/city-races.data.ts', `// Generated by design/build-city-races.ts - do not edit.\n/* eslint-disable */\nexport const CITY_RACE_DATA = ${JSON.stringify(out)} as const;\n`);
console.log('wrote shared/city-races.data.ts');
