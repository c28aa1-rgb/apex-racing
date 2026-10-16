import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PartyUpdates } from '../src/party-network';
import { RemoteMotion } from '../src/remote-motion';
import { orientation } from '../shared/tracks';
import type { PartyPose } from '../shared/party';
import { updateSchema } from '../shared/party-room';
import { PARTY_MAX_IN_FLIGHT, PARTY_POSE_HZ, PARTY_POSE_INTERVAL_MS } from '../shared/party-network';
import { Game } from '../src/game';
import { roomLocationHint } from '../cloudflare/room-placement';

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
test('small timer variations do not halve the pose cadence', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const updates = new PartyUpdates({ ready: () => true, send: async () => {}, receive: () => {}, error: () => {} });
  for (let i = 0; i < 6; i++) { now = i * PARTY_POSE_INTERVAL_MS + [0, .2, .1][i % 3]; updates.tick(now); await flush(); }
  assert.equal(updates.sent, 6);
  assert.ok(updates.diagnostics().sendIntervalMs.p95! < PARTY_POSE_INTERVAL_MS + 1);
  updates.stop();
});
test('pose cadence stays at 30 Hz with 150 ms replies and stops without stale callbacks', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const pending: { at: number; resolve: () => void }[] = [], sent: number[] = [];
  let received = 0;
  const updates = new PartyUpdates({ ready: () => true,
    send: () => { sent.push(now); return new Promise<void>(resolve => pending.push({ at: now + 150, resolve })); },
    receive: () => { received++; }, error: cause => { throw cause; } });
  for (now = 0; now <= 1001; now++) {
    for (const reply of pending.filter(p => p.at === now)) reply.resolve();
    await flush(); updates.tick(now);
  }
  assert.equal(sent.length, PARTY_POSE_HZ + 1);
  assert.ok(sent.every((at, i) => i === 0 || Math.abs(at - sent[i - 1] - PARTY_POSE_INTERVAL_MS) < 1));
  assert.equal(updates.diagnostics().rttMs.p95, 150);
  assert.ok(updates.peakInFlight <= PARTY_MAX_IN_FLIGHT);
  updates.stop(); const before = received;
  pending.forEach(reply => reply.resolve()); await flush();
  assert.equal(received, before); assert.equal(updates.inFlight, 0);
});

test('congestion skips old poses with a bounded queue and sends a fresh pose after recovery', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const pending: (() => void)[] = [], poses: number[] = [];
  const updates = new PartyUpdates({ ready: () => true,
    send: () => { poses.push(now); return new Promise<void>(resolve => pending.push(resolve)); }, receive: () => {}, error: () => {} });
  for (now = 0; now <= 1000; now += 50) updates.tick(now);
  assert.equal(poses.length, PARTY_MAX_IN_FLIGHT); assert.equal(updates.inFlight, PARTY_MAX_IN_FLIGHT); assert.equal(updates.skipped, 21 - PARTY_MAX_IN_FLIGHT);
  pending.forEach(resolve => resolve()); await flush();
  now = 1050; updates.tick(now);
  assert.equal(poses.at(-1), 1050);
  updates.stop(); pending.forEach(resolve => resolve()); await flush();
});

const poseAt = (ms: number, sequence: number, speed = 90): PartyPose => {
  const radius = 300, angle = speed / radius * ms / 1000;
  const v = { x: speed * Math.cos(angle), y: 0, z: speed * Math.sin(angle) };
  return { sequence, t: ms, p: { x: radius * Math.sin(angle), y: 0, z: radius * (1 - Math.cos(angle)) },
    q: orientation({ x: v.x / speed, y: 0, z: v.z / speed }), v, lap: 1, checkpoint: 0, finished: false };
};

for (const hz of [20, 30]) test(`${hz} Hz remote motion stays continuous through jitter, bursts and missed high-speed updates`, t => {
  const motion = new RemoteMotion(), packets: { arrival: number; pose: PartyPose }[] = [];
  let lastArrival = 0;
  for (let ms = 0, sequence = 1; ms < 12000; ms += 1000 / hz, sequence++) {
    // Two missing poses and variable transit time create gaps and bursts on a TCP-like stream.
    if (sequence % 40 === 0 || sequence % 40 === 1 && sequence > 1) continue;
    const delay = [40, 70, 130, 45, 90, 60][sequence % 6];
    lastArrival = Math.max(lastArrival + 1, ms + delay);
    packets.push({ arrival: lastArrival, pose: poseAt(ms, sequence) });
  }
  let next = 0, previous: ReturnType<RemoteMotion['sample']>, maxStep = 0, maxCurveError = 0, totalAge = 0, frames = 0;
  for (let now = 0; now < 12000; now += 1000 / 60) {
    while (packets[next]?.arrival <= now) { const packet = packets[next++]; motion.add(packet.pose, packet.arrival); }
    const sample = motion.sample(now);
    if (sample && previous && now > 2000) {
      maxStep = Math.max(maxStep, Math.hypot(sample.p.x - previous.p.x, sample.p.z - previous.p.z));
      const expected = poseAt(sample.t, 0);
      maxCurveError = Math.max(maxCurveError, Math.hypot(sample.p.x - expected.p.x, sample.p.z - expected.p.z));
      totalAge += now - sample.t; frames++;
    }
    previous = sample;
  }
  const stats = motion.diagnostics(12000);
  t.diagnostic(JSON.stringify({ hz, maxStep, maxCurveError, meanPlaybackAgeMs: totalAge / frames, ...stats }));
  assert.equal(stats.resets, 0, 'normal travel across a delivery gap must not look like a teleport');
  assert.ok(maxStep < 2.5, `frame jump: ${maxStep} m at 60 Hz`);
  assert.ok(maxCurveError < 1, `curve error: ${maxCurveError} m`);
  assert.ok(stats.interpolatedFrames / (stats.interpolatedFrames + stats.extrapolatedFrames) > .9);
  assert.ok(stats.bufferMs <= 250); assert.ok(stats.missingSequences > 0);
});

test('the buffer recovers within two seconds after a temporary network slowdown', () => {
  const motion = new RemoteMotion();
  let ms = 0, sequence = 1;
  const add = (age: number) => { motion.add(poseAt(ms, sequence++), ms + age); ms += PARTY_POSE_INTERVAL_MS; };
  for (let i = 0; i < 90; i++) add(40);
  const stable = motion.diagnostics(ms).bufferMs;
  for (let i = 0; i < 15; i++) add(180);
  assert.ok(motion.diagnostics(ms).bufferMs > stable + 80);
  for (const age of [150, 120, 90, 60, 40]) add(age);
  for (let i = 0; i < 60; i++) add(40);
  assert.ok(motion.diagnostics(ms).bufferMs < stable + 10);
  assert.equal(motion.diagnostics(ms).resets, 0);
});

test('clock corrections converge without jumping or reversing the shared timeline', () => {
  const game = Object.create(Game.prototype) as Game;
  const clock = game as unknown as { serverOffsetRtt: number };
  clock.serverOffsetRtt = Infinity;
  game.noteServerClock(1000, 0, 100);
  let before = game.serverTime(100);
  for (let i = 0; i < 200; i++) {
    const now = 200 + i * PARTY_POSE_INTERVAL_MS;
    const unchanged = game.serverTime(now);
    game.noteServerClock(now + 850, now, now);
    const updated = game.serverTime(now);
    assert.ok(Math.abs(updated - unchanged) <= .5);
    assert.ok(updated > before); before = updated;
  }
  assert.ok(Math.abs(game.serverTime(10000) - 10850) < .01);
});

test('room placement defaults to the host and accepts only supported Cloudflare hints', () => {
  assert.equal(roomLocationHint(), undefined); assert.equal(roomLocationHint('auto'), undefined);
  for (const hint of ['wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'apac-ne', 'apac-se', 'oc', 'afr', 'me']) assert.equal(roomLocationHint(hint), hint);
  assert.throws(() => roomLocationHint('invalid'), { message: 'Invalid RACE_ROOM_LOCATION_HINT.', statusCode: 503 });
});

test('prediction stops after 100 ms, reordered samples are ignored and respawns snap', () => {
  const motion = new RemoteMotion();
  motion.add(poseAt(0, 1), 30); motion.add(poseAt(50, 2), 80);
  const early = motion.sample(400)!, later = motion.sample(1200)!;
  assert.deepEqual(early.p, later.p, 'a connection stall cannot drift for another 700 ms');
  assert.equal(motion.add(poseAt(0, 1), 1300), false);
  const respawn = { ...poseAt(100, 3), p: { x: -500, y: 3, z: 0 } };
  motion.add(respawn, 150);
  assert.deepEqual(motion.sample(160)!.p, respawn.p);
  assert.equal(motion.diagnostics(160).resets, 1);
});

test('legacy poses still interpolate and velocity is optional, finite and bounded at the server', () => {
  const motion = new RemoteMotion(), first = poseAt(0, 1), second = poseAt(50, 2);
  delete first.v; delete second.v;
  motion.add(first, 30); motion.add(second, 80);
  assert.ok(Number.isFinite(motion.sample(100)!.p.x));
  const update = { raceId: '00000000-0000-4000-8000-000000000000', ready: true, pose: first };
  assert.ok(updateSchema.safeParse(update).success);
  assert.ok(updateSchema.safeParse({ ...update, pose: poseAt(100, 3) }).success);
  assert.equal(updateSchema.safeParse({ ...update, pose: { ...first, v: { x: Infinity, y: 0, z: 0 } } }).success, false);
  assert.equal(updateSchema.safeParse({ ...update, pose: { ...first, v: { x: 2000, y: 0, z: 0 } } }).success, false);
});
