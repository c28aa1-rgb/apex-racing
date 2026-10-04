/**
 * The Training Grounds: one flat, walled car park shared by free roam and the
 * hidden cone course. Physics and rendering both read this layout, so every
 * wall, parked car and cone the player sees is exactly where it collides.
 * Units are metres; +z is north, the lot is centred on the origin at y = 0.
 */
export type LotBox = { x: number; z: number; w: number; l: number; h: number; yaw: number; kind: 'wall' | 'container' | 'parked' | 'pole' | 'kiosk' | 'island' | 'gantry' };
/** `free`: also stands in free roam. Others appear only while the cone course is being run. */
export type LotCone = { x: number; z: number; role: 'slalom' | 'edge' | 'divider' | 'gate' | 'finish' | 'pad'; free: boolean };
export type LotLayout = {
  id: string; half: number; boxes: LotBox[]; cones: LotCone[];
  /** Drive into this painted box during free roam to start the cone course. */
  startZone: { x: number; z: number; w: number; l: number };
  /** Free roam spawn and the painted drift circles. */
  spawn: { x: number; z: number }; pad: { x: number; z: number; radius: number };
  /** Cone course edges; in a timed run the car's centre crossing one is a penalty. */
  edges: { points: [number, number][]; free: boolean }[];
};
/** Contact radius of a cone's base for hit tests (the visible base is 36 cm square). */
export const CONE_RADIUS = .24;
export const CONE_PENALTY_MS = 1000;

const HALF = 130;
const boxes: LotBox[] = [];
const cones: LotCone[] = [];

// Perimeter: continuous concrete barriers. Each wall is one solid collider.
for (const [x, z, w, l] of [[0, HALF, HALF * 2 + 1.6, .8], [0, -HALF, HALF * 2 + 1.6, .8], [HALF, 0, .8, HALF * 2], [-HALF, 0, .8, HALF * 2]] as const)
  boxes.push({ x, z, w, l, h: 1.15, yaw: 0, kind: 'wall' });

// North-west container yard: two stacked rows with a drivable alley between.
for (let i = 0; i < 4; i++) {
  boxes.push({ x: -112, z: 118 - i * 2.6, w: 12.2, l: 2.44, h: i % 2 ? 5.2 : 2.6, yaw: 0, kind: 'container' });
  boxes.push({ x: -96 + (i % 2) * 2, z: 96 - i * 2.6, w: 12.2, l: 2.44, h: 2.6, yaw: 0, kind: 'container' });
}
boxes.push({ x: -80, z: 120, w: 2.44, l: 12.2, h: 2.6, yaw: 0, kind: 'container' });

// West parking: one row against the wall and a double row on a kerbed island.
// A fixed pattern leaves gaps, so the bays read as a real, half-full car park.
const PARKED = [1, 0, 1, 1, 0, 0, 1, 0, 1, 1, 1, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 1, 0, 1, 0, 0, 1, 1, 0];
for (let i = 0; i < 40; i++) {
  const z = -66 + i * 3;
  if (PARKED[i]) boxes.push({ x: -126.8, z, w: 4.5, l: 1.9, h: 1.45, yaw: 0, kind: 'parked' });
  if (PARKED[(i * 7 + 3) % 40]) boxes.push({ x: -98.5, z, w: 4.5, l: 1.9, h: 1.45, yaw: 0, kind: 'parked' });
  if (PARKED[(i * 3 + 11) % 40] && i % 9 !== 4) boxes.push({ x: -91.5, z, w: 4.5, l: 1.9, h: 1.45, yaw: 0, kind: 'parked' });
}
boxes.push({ x: -95, z: -7.5, w: 1.6, l: 121, h: .16, yaw: 0, kind: 'island' });

// Light poles line the drift area and the course paddock.
for (const x of [-74, 46]) for (const z of [-96, -38, 20, 78]) boxes.push({ x, z, w: .42, l: .42, h: 11, yaw: 0, kind: 'pole' });
// Timing hut beside the cone course start.
boxes.push({ x: 48, z: -116, w: 5, l: 4, h: 3.2, yaw: 0, kind: 'kiosk' });

// Hidden cone course, about 900 m. North up the east slalom lane, hairpin
// round the divider, south through three cone gates, west along the bottom
// of the lot past the start box, up a second slalom on the west side, east
// along the north wall through two more gates, then south to the finish.
// Course edges are polylines: cones are laid along them, and in a timed run
// the car's centre crossing one costs a penalty (it is never possible to slip
// between cones for free).
const A = 71, B = 94.75, DIVIDER = 82.5, WEST = 58, EAST = 107;
type Point = [number, number];
const ARC = (() => { const points: Point[] = []; for (let a = 172.5; a >= 7.5; a -= 7.5) { const r = a * Math.PI / 180; points.push([Math.round((DIVIDER + Math.cos(r) * 24.5) * 100) / 100, Math.round((62 + Math.sin(r) * 24.5) * 100) / 100]); } return points; })();
/** Course edges. `free` edges also stand in free roam; the rest appear only when a run starts. */
export const COURSE_EDGES: { points: Point[]; free: boolean }[] = [
  // Original east section, as seen in free roam.
  { points: [[WEST, -98], [WEST, 60], ...ARC, [EAST, 56], [EAST, -100]], free: true },
  { points: [[DIVIDER, -100], [DIVIDER, 56]], free: true },
  // Extension: closes the east lanes and outlines the long loop.
  { points: [[EAST, -100], [EAST, -110], [78, -110]], free: false },
  { points: [[64, -110], [-66, -110], [-66, 112], [40, 112], [40, -40]], free: false },
  { points: [[20, -40], [20, 90], [-44, 90], [-44, -98], [WEST, -98]], free: false },
];
const lay = (points: Point[], free: boolean, step = 4) => {
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, az] = points[i], [bx, bz] = points[i + 1], length = Math.hypot(bx - ax, bz - az);
    // Arc points are already spaced; straight edges get a cone every `step` metres.
    const count = length > step * 1.5 ? Math.round(length / step) : 1;
    for (let k = 0; k < count; k++) {
      const t = k / count, x = Math.round((ax + (bx - ax) * t) * 100) / 100, z = Math.round((az + (bz - az) * t) * 100) / 100;
      if (!cones.some(c => Math.abs(c.x - x) < .5 && Math.abs(c.z - z) < .5)) cones.push({ x, z, role: 'edge', free });
    }
  }
  const [x, z] = points[points.length - 1];
  if (!cones.some(c => Math.abs(c.x - x) < .5 && Math.abs(c.z - z) < .5)) cones.push({ x, z, role: 'edge', free });
};
for (let z = -82; z <= -18; z += 16) cones.push({ x: A, z, role: 'slalom', free: true });
for (const edge of COURSE_EDGES) lay(edge.points, edge.free);
// Second, faster slalom up the west corridor.
for (let z = -86; z <= 40; z += 18) cones.push({ x: -55, z, role: 'slalom', free: false });
// Posts of the sign gantry, well behind the start box: a driver passes under it on the way in, and it stays behind the chase camera and out of the marshal drone's view.
for (const x of [A - 6, A + 6]) boxes.push({ x, z: -126, w: .35, l: .35, h: 5.2, yaw: 0, kind: 'gantry' });
/** Narrow cone gates, each also a timing checkpoint, in driving order. Heading is the direction of travel (0 = north). */
export const CONE_GATES = [
  { x: 90, z: 30, heading: Math.PI, free: true }, { x: 100, z: 12, heading: Math.PI, free: true }, { x: 90, z: -6, heading: Math.PI, free: true },
  { x: 25, z: -101.5, heading: -Math.PI / 2, free: false }, { x: -8, z: -106.5, heading: -Math.PI / 2, free: false },
  { x: -30, z: 106, heading: Math.PI / 2, free: false }, { x: 0, z: 96, heading: Math.PI / 2, free: false },
];
export const CHICANE = CONE_GATES.slice(0, 3);
for (const gate of CONE_GATES) for (const side of [-2.5, 2.5]) {
  // Gate cones stand either side of the line of travel.
  const sx = Math.cos(gate.heading) * side, sz = -Math.sin(gate.heading) * side;
  cones.push({ x: Math.round((gate.x + sx) * 100) / 100, z: Math.round((gate.z + sz) * 100) / 100, role: 'gate', free: gate.free });
}

export const TRAINING_LOT: LotLayout = {
  id: 'training-lot', half: HALF, boxes, cones,
  startZone: { x: A, z: -112, w: 10, l: 8 },
  spawn: { x: -15, z: -112 }, pad: { x: -15, z: 8, radius: 28 }, edges: COURSE_EDGES,
};
export const CONE_COURSE = { laneA: A, laneB: B, divider: DIVIDER, finish: { x: 30, z: 40 } };
