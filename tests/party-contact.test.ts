import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { initPhysics, Input, Simulation } from '../shared/physics';
import { DT } from '../shared/physics-version';
import type { PartyPose } from '../shared/party';
import { RemoteMotion } from '../src/remote-motion';
import { handlingTrack } from './handling-harness';
before(() => initPhysics());

type Car = { sim: Simulation; motion: RemoteMotion; inbox: { at: number; pose: PartyPose }[]; sequence: number };
/**
 * Two party clients on one flat pad. Each runs only its own car; the other is the stand-in fed from 30 Hz poses that
 * arrive `latencyMs` late, drawn where it is now (RemoteMotion.present), as in a real race. Returns both cars' speeds
 * along +z each tick, the largest sideways speed of each, and the largest vertical speed and spin either car reached.
 * `frameTicks` > 1 renders (and so places the stand-in) only every few physics ticks, as on a slow screen.
 */
function duel({ gap, across = 0, speedA, speedB, inputA = 0, inputB = 0, ticks = 150, latencyMs = 60, frameTicks = 1 }:
  { gap: number; across?: number; speedA: number; speedB: number; inputA?: number; inputB?: number; ticks?: number; latencyMs?: number; frameTicks?: number }) {
  const track = handlingTrack(), cars: Car[] = [0, 1].map(() => ({ sim: new Simulation(track, 'porsche-911-gt3'), motion: new RemoteMotion(1), inbox: [], sequence: 0 }));
  try {
    for (const { sim } of cars) for (let i = 0; i < 30; i++) sim.step(0);
    const [a, b] = cars, start = a.sim.car.translation();
    b.sim.car.setTranslation({ x: start.x + across, y: start.y, z: start.z + gap }, true);
    a.sim.car.setLinvel({ x: 0, y: 0, z: speedA }, true); b.sim.car.setLinvel({ x: 0, y: 0, z: speedB }, true);
    const speeds: [number, number][] = [], side = [0, 0]; let lift = 0, spin = 0;
    for (let tick = 0; tick < ticks; tick++) {
      const now = tick * DT * 1000;
      cars.forEach((car, i) => {
        const peer = cars[1 - i];
        if (tick % 2 === 0) peer.inbox.push({ at: now + latencyMs, pose: { ...car.sim.frame(), v: car.sim.car.linvel(), t: now, sequence: ++car.sequence, lap: 1, checkpoint: 0, finished: false } });
      });
      for (const car of cars) {
        while (car.inbox.length && car.inbox[0].at <= now) car.motion.add(car.inbox.shift()!.pose, now);
        if (tick % frameTicks === 0) car.sim.setObstacle('peer', 'porsche-911-gt3', car.motion.present(now), frameTicks * DT);
      }
      a.sim.step(inputA); b.sim.step(inputB);
      speeds.push([a.sim.car.linvel().z, b.sim.car.linvel().z]);
      cars.forEach(({ sim }, i) => { const v = sim.car.linvel(), w = sim.car.angvel(); lift = Math.max(lift, v.y); spin = Math.max(spin, Math.abs(w.y)); side[i] = Math.max(side[i], Math.abs(v.x)); });
    }
    return { speeds, lift, spin, side, final: speeds.at(-1)! };
  } finally { for (const { sim } of cars) sim.dispose(); }
}
/** Each car's speed change from the contact: its final speed against the same run with the other car far off the road. */
const effect = (run: ReturnType<typeof duel>, alone: ReturnType<typeof duel>) => [0, 1].map(i => run.final[i] - alone.final[i]);

test('a light tap in a party race nudges both cars and launches neither', () => {
  for (const frameTicks of [1, 4]) {
    const setup = { gap: 6, speedA: 23, speedB: 20, frameTicks }, run = duel(setup), alone = duel({ ...setup, across: 60 });
    const [behind, ahead] = effect(run, alone), label = `${frameTicks === 1 ? '60' : '15'} fps: rear car ${behind.toFixed(2)} m/s, front car +${ahead.toFixed(2)} m/s`;
    // Equal cars closing at 3 m/s share it: each changes by about half, never by the whole closing speed or more.
    assert.ok(behind < -.5 && behind > -3, label);
    assert.ok(ahead > .5 && ahead < 3, label);
    assert.ok(run.lift < 1 && run.spin < .5, `${label}; lift ${run.lift.toFixed(2)} m/s, spin ${run.spin.toFixed(2)} rad/s`);
  }
});

test('a hard hit in a party race moves both cars, the struck one forward', () => {
  const setup = { gap: 6, speedA: 32, speedB: 20 }, run = duel(setup), alone = duel({ ...setup, across: 60 });
  const [behind, ahead] = effect(run, alone), label = `rear car ${behind.toFixed(2)} m/s, front car +${ahead.toFixed(2)} m/s`;
  assert.ok(behind < -4 && behind > -12, label);
  assert.ok(ahead > 4 && ahead < 12, label);
  assert.ok(run.lift < 1 && run.spin < 1, `${label}; lift ${run.lift.toFixed(2)} m/s, spin ${run.spin.toFixed(2)} rad/s`);
});

test('leaning on a car alongside pushes it aside without flinging either car', () => {
  const setup = { gap: .5, across: 2.4, speedA: 25, speedB: 25, inputA: Input.Left, ticks: 90 }, run = duel(setup), alone = duel({ ...setup, across: 60 });
  const label = `sideways: leaning car ${run.side[0].toFixed(2)} m/s (alone ${alone.side[0].toFixed(2)}), other car ${run.side[1].toFixed(2)} m/s; spin ${run.spin.toFixed(2)}`;
  assert.ok(run.side[1] > .5, `the other car feels it: ${label}`);
  assert.ok(run.side[1] < 6 && run.side[0] < alone.side[0], label);
  assert.ok(run.lift < 1 && run.spin < 2, label);
});
