/**
 * Collision-only crack seals. Imported venues are built from separate road, kerb, gravel and grass meshes whose
 * edges often stop a few centimetres short of each other. A tyre is a single suspension ray, so a 2-10 cm crack
 * lets it drop for a tick and the car feels a hit. For every open edge of a floor triangle that has another floor
 * surface within reach across a gap at about the same height, add a narrow flange just below road level
 * that spans the gap. Edges with nothing beside them (true road edges, raised kerb tops) get no flange, so the
 * physical floor never extends past what is drawn.
 */
type Grid = Map<number, number[]>;
const cellKey = (ix: number, iz: number) => ix * 1000003 + iz;

export function sealCracks(vertices: number[], indices: number[], types: number[], options: { reach: number; drop: number; tolerance: number }) {
  const { reach, drop, tolerance } = options, cell = 2;
  const triangleCount = indices.length / 3, floor = new Uint8Array(triangleCount);
  const grid: Grid = new Map();
  const at = (v: number, c: number) => vertices[indices[v] * 3 + c];
  for (let t = 0; t < triangleCount; t++) {
    const a = t * 3;
    const ux = at(a + 1, 0) - at(a, 0), uy = at(a + 1, 1) - at(a, 1), uz = at(a + 1, 2) - at(a, 2), wx = at(a + 2, 0) - at(a, 0), wy = at(a + 2, 1) - at(a, 1), wz = at(a + 2, 2) - at(a, 2);
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx, length = Math.hypot(nx, ny, nz);
    if (!length || Math.abs(ny) < .8 * length) continue;
    floor[t] = 1;
    const xs = [at(a, 0), at(a + 1, 0), at(a + 2, 0)], zs = [at(a, 2), at(a + 1, 2), at(a + 2, 2)];
    for (let ix = Math.floor(Math.min(...xs) / cell); ix <= Math.floor(Math.max(...xs) / cell); ix++) for (let iz = Math.floor(Math.min(...zs) / cell); iz <= Math.floor(Math.max(...zs) / cell); iz++) {
      const k = cellKey(ix, iz); let list = grid.get(k); if (!list) grid.set(k, list = []); list.push(t);
    }
  }
  /** Height of the floor nearest to y at (x,z), within tolerance, or NaN. */
  const floorAt = (x: number, y: number, z: number, skip: number) => {
    let best = NaN;
    for (const t of grid.get(cellKey(Math.floor(x / cell), Math.floor(z / cell))) ?? []) {
      if (t === skip) continue;
      const a = t * 3, ax = at(a, 0), az = at(a, 2), bx = at(a + 1, 0), bz = at(a + 1, 2), cx = at(a + 2, 0), cz = at(a + 2, 2);
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz); if (Math.abs(d) < 1e-12) continue;
      const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d, l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d, l3 = 1 - l1 - l2;
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
      const h = l1 * at(a, 1) + l2 * at(a + 1, 1) + l3 * at(a + 2, 1);
      if (Math.abs(h - y) <= tolerance && (Number.isNaN(best) || Math.abs(h - y) < Math.abs(best - y))) best = h;
    }
    return best;
  };
  // Open edges: used by exactly one floor triangle (positions welded at 1 mm).
  const key = (v: number) => `${Math.round(vertices[v * 3] * 1000)},${Math.round(vertices[v * 3 + 1] * 1000)},${Math.round(vertices[v * 3 + 2] * 1000)}`;
  const edges = new Map<string, { t: number; a: number; b: number; c: number; count: number }>();
  for (let t = 0; t < triangleCount; t++) if (floor[t]) for (let e = 0; e < 3; e++) {
    const a = indices[t * 3 + e], b = indices[t * 3 + (e + 1) % 3], c = indices[t * 3 + (e + 2) % 3], ka = key(a), kb = key(b), k = ka < kb ? ka + '|' + kb : kb + '|' + ka;
    const existing = edges.get(k); if (existing) existing.count++; else edges.set(k, { t, a, b, c, count: 1 });
  }
  let flanges = 0;
  for (const edge of edges.values()) {
    if (edge.count !== 1) continue;
    const ax = vertices[edge.a * 3], ay = vertices[edge.a * 3 + 1], az = vertices[edge.a * 3 + 2], bx = vertices[edge.b * 3], by = vertices[edge.b * 3 + 1], bz = vertices[edge.b * 3 + 2];
    const length = Math.hypot(bx - ax, bz - az); if (length < .01) continue;
    // Outward: horizontal perpendicular pointing away from the triangle's third vertex.
    let ox = (bz - az) / length, oz = -(bx - ax) / length;
    const mx = (ax + bx) / 2, mz = (az + bz) / 2, cx = vertices[edge.c * 3], cz = vertices[edge.c * 3 + 2];
    if ((cx - mx) * ox + (cz - mz) * oz > 0) { ox = -ox; oz = -oz; }
    // Look across the gap at three points along the edge; every one must find a neighbouring floor.
    let width = 0, found = true;
    for (const f of [.15, .5, .85]) {
      const px = ax + (bx - ax) * f, py = ay + (by - ay) * f, pz = az + (bz - az) * f;
      // Distance to the neighbouring floor across the gap; hairline cracks count too.
      let hitAt = 0;
      for (let d = .005; d <= reach; d += d < .05 ? .005 : .02) if (!Number.isNaN(floorAt(px + ox * d, py, pz + oz * d, edge.t))) { hitAt = d; break; }
      if (!hitAt) { found = false; break; }
      width = Math.max(width, hitAt);
    }
    if (!found) continue;
    // Flange quad from the edge outward past the far side of the gap, sloping down by `drop`.
    const w = Math.min(reach, width + .05), base = vertices.length / 3;
    vertices.push(ax, ay - drop * .25, az, bx, by - drop * .25, bz, ax + ox * w, ay - drop, az + oz * w, bx + ox * w, by - drop, bz + oz * w);
    indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    // Keep winding upward (the builder flips downward faces; here the normal must point up).
    const t0 = indices.length - 6, check = () => {
      const p = (i: number, c: number) => vertices[indices[t0 + i] * 3 + c];
      const ux = p(1, 0) - p(0, 0), uz = p(1, 2) - p(0, 2), wx = p(2, 0) - p(0, 0), wz = p(2, 2) - p(0, 2);
      return uz * wx - ux * wz;
    };
    if (check() < 0) { indices[t0 + 1] = base + 1; indices[t0 + 2] = base + 2; indices[t0 + 4] = base + 3; indices[t0 + 5] = base + 2; }
    types.push(types[edge.t], types[edge.t]);
    flanges++;
  }
  return flanges;
}

/**
 * Chassis walls. A steep face only blocks the car body when it stands at least `minHeight` above the floor on
 * its lower side: barriers, walls and real obstacles. Kerb risers, seam skirts hanging under the road and the
 * sides of low strips are left to the tyres, so the body never snags on them.
 * Returns 1 per wall triangle.
 */
export function chassisWalls(vertices: number[], indices: number[], minHeight: number) {
  const triangleCount = indices.length / 3, cell = 2, grid = new Map<number, number[]>(), floor = new Uint8Array(triangleCount), walls = new Uint8Array(triangleCount);
  const at = (v: number, c: number) => vertices[indices[v] * 3 + c];
  const normalOf = (t: number) => {
    const a = t * 3, ux = at(a + 1, 0) - at(a, 0), uy = at(a + 1, 1) - at(a, 1), uz = at(a + 1, 2) - at(a, 2), wx = at(a + 2, 0) - at(a, 0), wy = at(a + 2, 1) - at(a, 1), wz = at(a + 2, 2) - at(a, 2);
    return { nx: uy * wz - uz * wy, ny: uz * wx - ux * wz, nz: ux * wy - uy * wx };
  };
  for (let t = 0; t < triangleCount; t++) {
    const { nx, ny, nz } = normalOf(t), length = Math.hypot(nx, ny, nz);
    if (!length || Math.abs(ny) < .6 * length) continue;
    floor[t] = 1;
    const a = t * 3, xs = [at(a, 0), at(a + 1, 0), at(a + 2, 0)], zs = [at(a, 2), at(a + 1, 2), at(a + 2, 2)];
    for (let ix = Math.floor(Math.min(...xs) / cell); ix <= Math.floor(Math.max(...xs) / cell); ix++) for (let iz = Math.floor(Math.min(...zs) / cell); iz <= Math.floor(Math.max(...zs) / cell); iz++) {
      const k = cellKey(ix, iz); let list = grid.get(k); if (!list) grid.set(k, list = []); list.push(t);
    }
  }
  /** Highest floor at (x,z) that is not above `top` (+5 cm), or -Infinity. */
  const floorBelow = (x: number, z: number, top: number) => {
    let best = -Infinity;
    for (const t of grid.get(cellKey(Math.floor(x / cell), Math.floor(z / cell))) ?? []) {
      const a = t * 3, ax = at(a, 0), az = at(a, 2), bx = at(a + 1, 0), bz = at(a + 1, 2), cx = at(a + 2, 0), cz = at(a + 2, 2);
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz); if (Math.abs(d) < 1e-12) continue;
      const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d, l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d, l3 = 1 - l1 - l2;
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
      const h = l1 * at(a, 1) + l2 * at(a + 1, 1) + l3 * at(a + 2, 1);
      if (h <= top + .05 && h > best) best = h;
    }
    return best;
  };
  for (let t = 0; t < triangleCount; t++) {
    if (floor[t]) continue;
    const { nx, nz } = normalOf(t), horizontal = Math.hypot(nx, nz);
    if (!horizontal) { walls[t] = 1; continue; }
    const a = t * 3, top = Math.max(at(a, 1), at(a + 1, 1), at(a + 2, 1)), v = [0, 1, 2].find(i => at(a + i, 1) === top)!;
    // Look just in front of and behind the face, beside its top corner.
    const ox = nx / horizontal * .2, oz = nz / horizontal * .2;
    // A side with no floor at all (a crack, the underside of the venue) says nothing about height; a face with no
    // floor on either side is free-standing and stays a wall.
    let low = Infinity, measured = false;
    // Compare floor and face top at the same place (beside the top corner): on a steep road, the floor under the
    // face's centre can be far below its top even for a sliver lying in the road surface.
    for (const [px, pz] of [[at(a + v, 0), at(a + v, 2)]]) for (const side of [1, -1]) {
      const h = floorBelow(px + ox * side, pz + oz * side, top);
      if (h > -Infinity) { measured = true; low = Math.min(low, h); }
    }
    walls[t] = !measured || top - low >= minHeight ? 1 : 0;
  }
  return walls;
}
