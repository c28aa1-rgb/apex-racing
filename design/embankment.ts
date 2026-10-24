/**
 * Embankments for raised roads. Where a road sits above the terrain beside it (the hill roads), the terrain is raised
 * into a bank that meets the road's shoulder and falls away at a drivable slope, so a car that leaves the road can
 * drive back up. Terrain is only ever raised, never lowered, and only along stretches that need it.
 *
 * The same functions reshape the visible terrain and the collision terrain (identical meshes in the export), so what
 * the player sees is what the car drives on.
 */

export type RoadPath = { name: string; width: number; points: number[][] };
type Segment = { ax: number; az: number; ay: number; bx: number; bz: number; by: number; half: number };

/** Bank geometry: top just under the road surface, flat for a shoulder, then this rise per metre outwards. */
const TOP = .12, SHOULDER = 1.5, SLOPE = .35;
/** How far beyond the shoulder a bank may reach (a deeper drop is left partly open). */
const REACH = 30;
/** Raised stretches: the road more than this above the ground just beyond its edge. */
const RAISED = .4;

/** Height of the terrain (highest floor below `below`) at a point, from triangles in a coarse grid. */
export function terrainSampler(positions: ArrayLike<number>, indices: ArrayLike<number>, cell = 24) {
  const grid = new Map<string, number[]>();
  for (let t = 0; t < indices.length / 3; t++) {
    const xs = [0, 1, 2].map(k => positions[indices[t * 3 + k] * 3]), zs = [0, 1, 2].map(k => positions[indices[t * 3 + k] * 3 + 2]);
    for (let x = Math.floor(Math.min(...xs) / cell); x <= Math.floor(Math.max(...xs) / cell); x++)
      for (let z = Math.floor(Math.min(...zs) / cell); z <= Math.floor(Math.max(...zs) / cell); z++) (grid.get(`${x},${z}`) ?? grid.set(`${x},${z}`, []).get(`${x},${z}`)!).push(t);
  }
  return (x: number, z: number, below = Infinity) => {
    let best = -Infinity;
    for (const t of grid.get(`${Math.floor(x / cell)},${Math.floor(z / cell)}`) ?? []) {
      const [a, b, c] = [0, 1, 2].map(k => indices[t * 3 + k] * 3);
      const x1 = positions[a], z1 = positions[a + 2], x2 = positions[b], z2 = positions[b + 2], x3 = positions[c], z3 = positions[c + 2];
      const d = (z2 - z3) * (x1 - x3) + (x3 - x2) * (z1 - z3); if (Math.abs(d) < 1e-9) continue;
      const l1 = ((z2 - z3) * (x - x3) + (x3 - x2) * (z - z3)) / d, l2 = ((z3 - z1) * (x - x3) + (x1 - x3) * (z - z3)) / d, l3 = 1 - l1 - l2;
      if (l1 < -1e-4 || l2 < -1e-4 || l3 < -1e-4) continue;
      const y = l1 * positions[a + 1] + l2 * positions[b + 1] + l3 * positions[c + 1];
      if (y < below && y > best) best = y;
    }
    return best;
  };
}

/**
 * The bank height field. Only road stretches that stand above the terrain beside them take part (measured against the
 * original terrain), so flat city streets and the expressway's viaduct (excluded by name) are left alone.
 */
export function embankments(roads: RoadPath[], ground: (x: number, z: number, below?: number) => number, exclude: RegExp, paved?: (x: number, z: number, below?: number) => number) {
  const segments: Segment[] = [], byRoad: Record<string, number> = {};
  for (const road of roads) {
    if (exclude.test(road.name)) continue;
    const half = road.width / 2;
    for (let i = 1; i < road.points.length; i++) {
      const [ax, ay, az] = road.points[i - 1], [bx, by, bz] = road.points[i], dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz) || 1;
      let drop = 0;
      for (const side of [-1, 1]) for (const [x, y, z] of [[ax, ay, az], [bx, by, bz]]) {
        const g = ground(x - dz / l * side * (half + 3), z + dx / l * side * (half + 3), y + .5);
        drop = Math.max(drop, g === -Infinity ? 0 : y - g);
      }
      if (drop > RAISED) { segments.push({ ax, az, ay, bx, bz, by, half }); byRoad[road.name] = (byRoad[road.name] ?? 0) + 1; }
    }
  }
  const CELL = 20, grid = new Map<string, Segment[]>(), reach = (s: Segment) => s.half + SHOULDER + REACH;
  for (const s of segments) {
    const r = reach(s);
    for (let x = Math.floor((Math.min(s.ax, s.bx) - r) / CELL); x <= Math.floor((Math.max(s.ax, s.bx) + r) / CELL); x++)
      for (let z = Math.floor((Math.min(s.az, s.bz) - r) / CELL); z <= Math.floor((Math.max(s.az, s.bz) + r) / CELL); z++) (grid.get(`${x},${z}`) ?? grid.set(`${x},${z}`, []).get(`${x},${z}`)!).push(s);
  }
  /** Bank height at (x, z), or -Infinity where no raised road is near. */
  const height = (x: number, z: number) => {
    let best = -Infinity;
    for (const s of grid.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`) ?? []) {
      const dx = s.bx - s.ax, dz = s.bz - s.az, l2 = dx * dx + dz * dz || 1, t = Math.min(1, Math.max(0, ((x - s.ax) * dx + (z - s.az) * dz) / l2));
      const cx = s.ax + dx * t, cz = s.az + dz * t, d = Math.hypot(x - cx, z - cz);
      const out = d - s.half - SHOULDER; if (out > REACH) continue;
      // The bank starts from the road's real surface at its nearest edge: on a curve the road tilts, and its low edge
      // sits below the centre line the export gives.
      let y = s.ay + (s.by - s.ay) * t;
      if (paved && d > .01) {
        const k = Math.min(d, s.half - .3) / d, edge = paved(cx + (x - cx) * k, cz + (z - cz) * k, y + 2);
        if (edge > -Infinity) y = Math.min(y, edge);
      }
      y -= TOP;
      best = Math.max(best, out <= 0 ? y : y - out * SLOPE);
    }
    // Under the road itself the bank stays just below the actual road surface (roads tilt on curves).
    if (paved && best > -Infinity) { const road = paved(x, z, best + 3); if (road > -Infinity) best = Math.min(best, road - TOP); }
    return best;
  };
  /** Whether a point is near enough to a raised road to need finer terrain. */
  const near = (x: number, z: number, margin: number) => (grid.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`) ?? []).some(s => {
    const dx = s.bx - s.ax, dz = s.bz - s.az, l2 = dx * dx + dz * dz || 1, t = Math.min(1, Math.max(0, ((x - s.ax) * dx + (z - s.az) * dz) / l2));
    return Math.hypot(x - s.ax - dx * t, z - s.az - dz * t) < reach(s) + margin;
  });
  return { height, near, segments: segments.length, byRoad };
}

/**
 * Splits terrain triangles near raised roads into a fine mesh (every edge halved `levels` times), so the bank can take
 * shape. Shared edges are split once, so the refined area has no cracks; its outer edge stays on the original
 * (untouched) terrain. Every per-vertex attribute is interpolated.
 */
export function refine(attributes: { values: number[]; size: number }[], indices: number[], pick: (triangle: number) => boolean, levels = 3) {
  let current = indices, chosen = new Set<number>();
  for (let t = 0; t < current.length / 3; t++) if (pick(t)) chosen.add(t);
  for (let level = 0; level < levels; level++) {
    const next: number[] = [], nextChosen = new Set<number>(), midpoints = new Map<string, number>();
    const mid = (a: number, b: number) => {
      const key = a < b ? `${a},${b}` : `${b},${a}`, known = midpoints.get(key); if (known !== undefined) return known;
      const id = attributes[0].values.length / attributes[0].size;
      for (const { values, size } of attributes) for (let k = 0; k < size; k++) values.push((values[a * size + k] + values[b * size + k]) / 2);
      midpoints.set(key, id); return id;
    };
    for (let t = 0; t < current.length / 3; t++) {
      const a = current[t * 3], b = current[t * 3 + 1], c = current[t * 3 + 2];
      if (!chosen.has(t)) { next.push(a, b, c); continue; }
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      for (const triangle of [[a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]]) { nextChosen.add(next.length / 3); next.push(...triangle); }
    }
    current = next; chosen = nextChosen;
  }
  return current;
}

/** Smooth vertex normals from the faces around each vertex. */
export function smoothNormals(positions: ArrayLike<number>, indices: ArrayLike<number>) {
  const normals = new Float32Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t] * 3, indices[t + 1] * 3, indices[t + 2] * 3];
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const wx = positions[c] - positions[a], wy = positions[c + 1] - positions[a + 1], wz = positions[c + 2] - positions[a + 2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
    for (const v of [a, b, c]) { normals[v] += nx; normals[v + 1] += ny; normals[v + 2] += nz; }
  }
  for (let v = 0; v < normals.length; v += 3) { const l = Math.hypot(normals[v], normals[v + 1], normals[v + 2]) || 1; normals[v] /= l; normals[v + 1] /= l; normals[v + 2] /= l; }
  return normals;
}
