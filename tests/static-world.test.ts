import test from 'node:test';
import assert from 'node:assert/strict';
import { initPhysics, Input, Simulation } from '../shared/physics';
import { trackById } from '../shared/tracks';

// Restarts restore a snapshot of the venue colliders instead of rebuilding
// them. Replays and server validation depend on that being bit-identical.
test('a restored venue world steps bit-identically to a freshly built one', async () => {
  const id = 'indianapolis';
  await initPhysics(trackById(id)!);
  const inputs: number[] = []; let seed = 11;
  for (let i = 0; i < 1500; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; const r = seed / 2**32;
    inputs.push(i === 700 ? Input.Respawn : (r < .85 ? Input.Throttle : Input.Brake) | (r * 7 % 1 < .3 ? Input.Left : r * 7 % 1 > .7 ? Input.Right : 0) | (i % 400 < 60 ? Input.Drift : 0));
  }
  const drive = () => {
    // A structured clone changes object identity but not the layout, as on the server.
    const started = performance.now(), sim = new Simulation(structuredClone(trackById(id)!)), built = performance.now() - started;
    try { return { built, frames: inputs.map(input => { sim.step(input); return JSON.stringify([sim.frame(), sim.checkpoint, sim.respawns]); }) }; }
    finally { sim.dispose(); }
  };
  const fresh = drive(), restored = drive();
  assert.deepEqual(restored.frames, fresh.frames);
  assert.ok(restored.built < fresh.built, `restoring (${restored.built.toFixed(0)} ms) is faster than building (${fresh.built.toFixed(0)} ms)`);
});
