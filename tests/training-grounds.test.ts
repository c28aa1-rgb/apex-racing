import test from 'node:test';
import assert from 'node:assert/strict';
import { initPhysics, Input, Simulation } from '../shared/physics';
import { validateReplay } from '../shared/replay';
import { CONE_TRACK, TRACKS, TRAINING_GROUNDS, trackById, type Track } from '../shared/tracks';
import { CONE_PENALTY_MS, TRAINING_LOT } from '../shared/lot';
import { driveTrack } from './driver';

/** A racing line through the slalom and the three cone gates, for the test driver only. */
function racingLine(): Track {
  const line = [[71, -112], [71, -96], [65.5, -82], [76.5, -66], [65.5, -50], [76.5, -34], [65.5, -18], [71, 0], [71, 56], [76, 76], [82.5, 82], [89, 76], [93, 56], [90, 30], [100, 12], [90, -6], [95, -30], [95, -92], [88, -103], [50, -104], [25, -101.5], [-8, -106.5], [-40, -104], [-55, -96], [-60, -86], [-50, -68], [-60, -50], [-50, -32], [-60, -14], [-50, 4], [-60, 22], [-50, 40], [-55, 76], [-48, 100], [-30, 106], [0, 96], [22, 100], [30, 86], [30, 40], [30, -40]];
  return { ...CONE_TRACK, segments: line.slice(0, -1).map((p, i) => ({ id: `line-${i}`, next: null, start: { x: p[0], y: 0, z: p[1] }, end: { x: line[i + 1][0], y: 0, z: line[i + 1][1] }, width: 8, surface: 'road' as const, rails: false })) };
}

test('hidden tracks stay out of public lists but resolve for the leaderboard', () => {
  assert.ok(!TRACKS.some(track => track.lot));
  assert.equal(trackById('cones'), CONE_TRACK);
  assert.equal(trackById('training'), TRAINING_GROUNDS);
});

test('free roam never finishes and has no five-minute clock of its own', async () => {
  await initPhysics(TRAINING_GROUNDS);
  const sim = new Simulation(TRAINING_GROUNDS); sim.maxTicks = Infinity;
  try {
    for (let i = 0; i < 900; i++) sim.step(Input.Throttle | (i > 240 ? Input.Left | Input.Drift : 0));
    assert.equal(sim.finished, false); assert.equal(sim.checkpoint, 0); assert.equal(sim.penalties, 0);
    assert.ok(sim.grounded, 'the flat slab carries the car');
    assert.ok(Math.abs(sim.car.translation().y) < 1.5);
  } finally { sim.dispose(); }
});

test('perimeter walls are solid', async () => {
  await initPhysics(TRAINING_GROUNDS);
  const sim = new Simulation(TRAINING_GROUNDS); sim.maxTicks = Infinity;
  try {
    for (let i = 0; i < 60 * 25; i++) sim.step(Input.Throttle);
    assert.ok(sim.car.translation().z < TRAINING_LOT.half, `car stopped at the north wall (z ${sim.car.translation().z.toFixed(1)})`);
  } finally { sim.dispose(); }
});

test('driving straight up the slalom knocks cones and each one costs a second', async () => {
  await initPhysics(CONE_TRACK);
  const sim = new Simulation(CONE_TRACK);
  try {
    for (let i = 0; i < 60 * 8; i++) sim.step(Input.Throttle);
    assert.ok(sim.penalties >= 3, `expected slalom hits, got ${sim.penalties}`);
    assert.equal(sim.timeMs, Math.round(sim.ticks / 60 * 1000) + sim.penalties * CONE_PENALTY_MS);
  } finally { sim.dispose(); }
});

test('a cone-course run replays to the same time, penalties included, and a tampered time fails', async () => {
  await initPhysics(CONE_TRACK);
  const { run, finished } = driveTrack(racingLine());
  assert.ok(finished, 'test driver completes the course');
  const result = await validateReplay(run);
  assert.equal(result.timeMs, run.timeMs);
  console.log(`cone course: ${(run.timeMs / 1000).toFixed(3)} s`);
  await assert.rejects(validateReplay({ ...run, timeMs: run.timeMs - 1000 }), /does not match/);
});

test('a run starts where the car stopped in the start box, and the server replays it from there', async () => {
  await initPhysics(CONE_TRACK);
  const origin = { x: 69.5, z: -110.2, heading: 0.04 };
  const { run, finished } = driveTrack(racingLine(), undefined, origin);
  assert.ok(finished);
  assert.deepEqual(run.origin, origin);
  const sim = new Simulation(CONE_TRACK, run.carId, origin);
  try { assert.ok(Math.abs(sim.car.translation().x - origin.x) < .01 && Math.abs(sim.car.translation().z - origin.z) < .01, 'the car starts exactly on the origin'); } finally { sim.dispose(); }
  assert.equal((await validateReplay(run)).timeMs, run.timeMs);
  await assert.rejects(validateReplay({ ...run, origin: { ...origin, z: -80 } }), /start box/);
  await assert.rejects(validateReplay({ ...run, origin: { ...origin, x: 40 } }), /start box/);
});

test('leaving the course costs a second', async () => {
  await initPhysics(CONE_TRACK);
  const sim = new Simulation(CONE_TRACK, undefined, { x: 71, z: -110, heading: Math.PI / 4 });
  try {
    // Angled north-east out of the start box, straight across the divider: a course edge is crossed.
    for (let i = 0; i < 60 * 3; i++) sim.step(Input.Throttle);
    assert.ok(sim.offCourse >= 1, `expected an off-course penalty, got ${sim.offCourse}`);
    assert.ok(sim.penalties >= sim.offCourse);
  } finally { sim.dispose(); }
});

test('free roam keeps only the east section of cones standing', async () => {
  await initPhysics(TRAINING_GROUNDS);
  const sim = new Simulation(TRAINING_GROUNDS); sim.maxTicks = Infinity;
  try {
    // Drive straight north along the west corridor's slalom line: those cones exist only in a run.
    sim.car.setTranslation({ x: -55, y: 1, z: -100 }, true);
    for (let i = 0; i < 60 * 8; i++) sim.step(Input.Throttle);
    assert.ok(sim.car.translation().z > 20, 'the car drove up the corridor');
    const westHits = TRAINING_LOT.cones.filter((c, i) => !c.free && sim.coneHits[i] >= 0).length;
    assert.equal(westHits, 0);
  } finally { sim.dispose(); }
});
