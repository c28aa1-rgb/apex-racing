import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRACKS } from '../shared/tracks';
import { PHYSICS_VERSION } from '../shared/physics-version';
import type { Run } from '../shared/replay';

test('personal bests reach the leaderboard once per player, and failed posts retry', async () => {
  const store = new Map<string, string>(), g = globalThis as { localStorage?: unknown; fetch?: typeof fetch };
  const previous = { localStorage: g.localStorage, fetch: g.fetch };
  const posts: string[] = []; let online = true;
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  g.fetch = (async (_url: string, init?: RequestInit) => {
    if (!online) throw new TypeError('offline');
    posts.push(JSON.parse(String(init?.body)).trackId);
    return new Response(JSON.stringify({ improved: true }), { status: 201 });
  }) as typeof fetch;
  const setPlayer = (id: string) => { for (const key of ['apex:player', 'apex:player:cloudflare']) store.set(key, JSON.stringify({ id, token: 't', nickname: 'Driver' })); };
  try {
    const { syncBests } = await import('../src/best-sync');
    const [a, b] = TRACKS.filter(t => t.kind !== 'lot');
    for (const track of [a, b]) {
      const run: Run = { trackId: track.id, trackVersion: track.version, physicsVersion: PHYSICS_VERSION, carId: 'porsche-911-gt3', timeMs: 1000, inputs: Array(60).fill(1) };
      store.set(`apex:best:${track.id}`, JSON.stringify(run));
    }
    assert.equal(await syncBests(), 0, 'no nickname: nothing is posted');
    setPlayer('p1');
    online = false; assert.equal(await syncBests(), 0, 'offline: nothing marked as posted');
    online = true; assert.equal(await syncBests(), 2, 'retried once back online');
    assert.deepEqual(posts.sort(), [a.id, b.id].sort());
    assert.equal(await syncBests(), 0, 'already posted bests are skipped');
    setPlayer('p2'); assert.equal(await syncBests(), 2, 'a new player posts their bests too');
  } finally { g.localStorage = previous.localStorage; g.fetch = previous.fetch; }
});
