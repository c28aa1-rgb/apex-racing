import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store';
import { createApp } from '../server/app';
import { DT, MAX_TICKS, PHYSICS_VERSION } from '../shared/physics';
import { TRACKS } from '../shared/tracks';
import type { Run } from '../shared/replay';

// These fixtures test transport/storage, not completed-lap validity. Actual
// replay determinism is exercised separately with the live physics engine.
test('steering samples survive best-run updates, API fetches and a database restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'apex-replay-storage-'));
  const track = TRACKS[0];
  const run: Run = { trackId: track.id, trackVersion: track.version, physicsVersion: PHYSICS_VERSION,
    carId: 'porsche-963', timeMs: 10000, inputs: [1, 5, 5], steering: [1.1, .7, 1.35] };
  const improved: Run = { ...run, timeMs: 9000, inputs: [1, 9, 9], steering: [.9, 1.2, 1.1] };
  const { steering: _unused, ...legacy } = run;
  const store = new Store(undefined, directory); await store.init();
  const app = await createApp(store, async () => { throw new Error('No validation expected in a storage fixture'); });
  let id = '', legacyId = '';
  try {
    const player = await store.createPlayer('Storage Driver');
    assert.deepEqual(await store.save(player.id, run), { improved: true });
    id = (await store.leaderboard(track.id, track.version))[0].id as string;
    assert.deepEqual((await app.inject({ url: `/api/replays/${id}` })).json(), run);
    assert.deepEqual(await store.save(player.id, improved), { improved: true });
    assert.deepEqual(await store.save(player.id, run), { improved: false });
    assert.deepEqual(await store.replay(id), improved);
    const other = await store.createPlayer('Legacy Driver');
    await store.save(other.id, legacy);
    legacyId = (await store.leaderboard(track.id, track.version)).find(row => row.playerId === other.id)!.id as string;
    assert.deepEqual(await store.replay(legacyId), legacy);
  } finally { await app.close(); await store.close(); }
  const reopened = new Store(undefined, directory); await reopened.init();
  try {
    assert.deepEqual(await reopened.replay(id), improved);
    assert.deepEqual(await reopened.replay(legacyId), legacy);
  } finally { await reopened.close(); }
});

test('API accepts a maximum-length replay including steering without truncation', async () => {
  const store = new Store(); await store.init();
  const run: Run = { trackId: TRACKS[0].id, trackVersion: TRACKS[0].version, physicsVersion: PHYSICS_VERSION,
    carId: 'porsche-963', timeMs: Math.round(MAX_TICKS * DT * 1000),
    inputs: Array(MAX_TICKS).fill(5), steering: Array.from({length: MAX_TICKS}, (_, i) => i % 2 ? .7 : 1.35) };
  let validated = false;
  const app = await createApp(store, async value => {
    assert.deepEqual(value, run); validated = true;
    return { timeMs: run.timeMs, ticks: MAX_TICKS, checkpoints: 4, respawns: 0 };
  });
  try {
    const player = await store.createPlayer('Long Replay');
    const result = await app.inject({ method: 'POST', url: '/api/runs',
      headers: { authorization: `Bearer ${player.token}` }, payload: run });
    assert.equal(result.statusCode, 201, result.body);
    assert.ok(validated);
    const id = result.json().entries[0].id;
    assert.deepEqual((await app.inject({ url: `/api/replays/${id}` })).json(), run);
  } finally { await app.close(); await store.close(); }
});
