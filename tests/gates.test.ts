import test from 'node:test';
import assert from 'node:assert/strict';
import { collisionGeometry, initPhysics, Simulation } from '../shared/physics';
import { fittedGate, insideGate } from '../shared/gates';
import { placementGate, trackById, type Track } from '../shared/tracks';

// Placements recorded with the /dev checkpoint recorder on the real venues.
const RECORDED = [
  { track: 'spa', position: { x: 485.15875244140625, y: 70.29539134502411, z: 952.2172241210938 }, heading: -0.9358205872149958 },
  { track: 'indianapolis', position: { x: 616.7730712890625, y: 8.978380823135376, z: -270.2718505859375 }, heading: -1.7502656434479733 },
  { track: 'marina-bay', position: { x: -311.76654052734375, y: 47.43900921344757, z: 237.363037109375 }, heading: 1.5023485784381643 }
];

for (const placement of RECORDED) test(`${placement.track} checkpoint spans the whole road and run-off`, async () => {
  const base = trackById(placement.track)!;
  await initPhysics(base);
  const gate = fittedGate(base, placementGate(base, placement), await collisionGeometry(base));
  assert.ok(gate.roadRight - gate.roadLeft >= 8, 'the painted line covers a full racing surface');
  assert.ok(gate.left <= gate.roadLeft - 3 && gate.right >= gate.roadRight + 3, 'the trigger reaches past both road edges');
  // The outer lanes sit on the last drivable ground before a barrier or the reach limit.
  const lanes = [gate.roadLeft + .6, 0, gate.roadRight - .6, gate.left + 3.5, gate.right - 3.5];
  for (const lateral of lanes) {
    const at = (along: number) => ({ x: gate.position.x + gate.forward.x*along + gate.side.x*lateral, z: gate.position.z + gate.forward.z*along + gate.side.z*lateral });
    const surface = gate.heightAt(0, lateral);
    assert.ok(insideGate(gate, { ...at(0), y: surface + .7 }), `a car ${lateral.toFixed(1)} m across counts`);
    assert.ok(!insideGate(gate, { ...at(0), y: surface + 12 }), 'a road passing high overhead does not');
    // Drive the real simulation through the plane at this lateral offset.
    const track: Track = { ...base, checkpoints: [placementGate(base, placement)] };
    const sim = new Simulation(track);
    try {
      const start = at(-4);
      sim.car.setTranslation({ x: start.x, y: gate.heightAt(-4, lateral) + .9, z: start.z }, true);
      sim.car.setRotation(gate.rotation, true);
      sim.car.setLinvel({ x: gate.forward.x*25, y: 0, z: gate.forward.z*25 }, true);
      sim.car.setAngvel({ x: 0, y: 0, z: 0 }, true);
      for (let tick = 0; tick < 30 && !sim.checkpoint; tick++) sim.step(0);
      assert.equal(sim.checkpoint, 1, `checkpoint credit ${lateral.toFixed(1)} m across the ${placement.track} gate`);
    } finally { sim.dispose(); }
  }
  // Moving backwards through the gate never awards credit.
  const track: Track = { ...base, checkpoints: [placementGate(base, placement)] };
  const sim = new Simulation(track);
  try {
    const start = { x: gate.position.x + gate.forward.x*4, z: gate.position.z + gate.forward.z*4 };
    sim.car.setTranslation({ ...start, y: gate.heightAt(4, 0) + .9 }, true);
    sim.car.setLinvel({ x: -gate.forward.x*25, y: 0, z: -gate.forward.z*25 }, true);
    for (let tick = 0; tick < 30; tick++) sim.step(0);
    assert.equal(sim.checkpoint, 0);
  } finally { sim.dispose(); }
});

test('gates without physical geometry keep the route-width trigger', () => {
  const track = trackById('bugatti')!, gate = fittedGate(track, track.checkpoints[0]);
  assert.equal(gate.right - gate.left, track.checkpoints[0].width + 1.6);
  assert.ok(insideGate(gate, { ...gate.position, y: gate.position.y + .5 }));
});
