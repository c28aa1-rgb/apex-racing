import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Parties } from '../server/parties';
import { PARTY_GRIDS } from '../shared/party-grids';
import { TRACKS } from '../shared/tracks';
import type { PartyPose } from '../shared/party';
import { initPhysics, MAX_TICKS, Simulation } from '../shared/physics';
import { CAR_IDS } from '../shared/cars';

const host = { id: 'host', nickname: 'Host' }, guest = { id: 'guest', nickname: 'Guest' };
test('party time allowance extends the simulation without changing the solo limit', async () => {
  await initPhysics();
  const sim = new Simulation(TRACKS[0]);
  try {
    sim.ticks = MAX_TICKS; sim.step(0); assert.equal(sim.ticks, MAX_TICKS);
    sim.maxTicks = 60 * 3600; sim.step(0); assert.equal(sim.ticks, MAX_TICKS + 1);
  } finally { sim.dispose(); }
});
test('all circuits have eight separated slots with the original first position', () => {
  for (const track of TRACKS) {
    const grid = PARTY_GRIDS[track.id as keyof typeof PARTY_GRIDS];
    assert.equal(grid.slots.length, 8);
    assert.equal(grid.slots[0].position.x, grid.anchor.position.x);
    assert.equal(grid.slots[0].position.z, grid.anchor.position.z);
    assert.equal(grid.slots[0].heading, grid.anchor.heading);
    const f = { x: Math.sin(grid.anchor.heading), z: Math.cos(grid.anchor.heading) };
    for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) {
      const a = grid.slots[i].position, b = grid.slots[j].position;
      const along = Math.abs((a.x - b.x) * f.x + (a.z - b.z) * f.z), across = Math.abs((a.x - b.x) * f.z - (a.z - b.z) * f.x);
      assert.ok(along > 6.1 || across > 2.5, `${track.id} slots ${i + 1}/${j + 1} overlap`);
    }
  }
});

test('race waits for all drivers, locks setup, orders updates and returns results', () => {
  let now = 1000; const parties = new Parties(() => now);
  const lobby = parties.create(host, 'porsche-911-gt3', { laps: 2 });
  parties.join(guest, lobby.code, 'celica-gt4');
  assert.throws(() => parties.start(guest, {}), /Only the host/);
  const race = parties.start(host, {}).race!;
  assert.deepEqual(race.racers.map(r => r.slot).sort(), [0, 1]);
  assert.throws(() => parties.car(guest, 'mazda-787b'), /locked/);
  assert.throws(() => parties.settings(host, { laps: 3 }), /locked/);
  assert.throws(() => parties.join({ id: 'late', nickname: 'Late' }, lobby.code, 'celica-gt4'), /progress/);
  assert.equal(parties.update(host, race.id, true).race.startAt, null);
  const ready = parties.update(guest, race.id, true);
  assert.equal(ready.race.startAt, now + 6500);
  const pose: PartyPose = { sequence: 1, p: race.grid[0].position, q: race.grid[0].rotation, lap: 1, checkpoint: 0, finished: false };
  assert.equal(parties.update(host, race.id, true, pose).race.racers[0].pose, undefined);
  now += 6501;
  assert.equal(parties.update(host, race.id, true, pose).race.racers[0].pose?.sequence, 1);
  assert.equal(parties.update(host, race.id, true, { ...pose, sequence: 0 }).race.racers[0].pose?.sequence, 1);
  assert.throws(() => parties.update(host, race.id, true, { ...pose, sequence: 2, finished: true }), /Invalid race progress/);
  parties.update(host, race.id, true, { ...pose, sequence: 2, lap: 2 });
  const finish = parties.update(host, race.id, true, { ...pose, sequence: 3, lap: 2, finished: true });
  assert.equal(finish.race.racers[0].finishedAt, now);
  assert.equal(finish.race.ended, false);
  parties.leave(guest);
  assert.equal(parties.update(host, race.id, true).race.ended, true);
  const snapshot = parties.current(host)!; snapshot.race!.racers[0].nickname = 'Changed';
  assert.equal(parties.current(host)!.race!.racers[0].nickname, 'Host');
  assert.equal(parties.reopen(host).race, undefined);
  assert.throws(() => parties.update(host, race.id, true), /ended/);
});

test('changed anchors fail closed and disconnected drivers cannot hold a race open', () => {
  let now = 1000; const parties = new Parties(() => now);
  const lobby = parties.create(host, 'porsche-911-gt3'); parties.join(guest, lobby.code, 'celica-gt4');
  assert.throws(() => parties.start(host, { starts: { bugatti: { position: { x: 0, y: 0, z: 0 }, heading: 0 } } }), /Revalidate/);
  const race = parties.start(host, {}).race!;
  parties.update(host, race.id, true); parties.update(guest, race.id, true);
  now += 10_000;
  parties.current(host);
  now += 10_001;
  const result = parties.update(host, race.id, true);
  assert.equal(result.race.racers[1].disconnected, true);
  assert.throws(() => parties.update(guest, race.id, true), /no longer/);
});

test('eight drivers receive distinct slots and share one countdown and pose snapshot', () => {
  let now = 1000; const parties = new Parties(() => now);
  const players = Array.from({ length: 8 }, (_, i) => ({ id: `driver-${i}`, nickname: `Driver ${i + 1}` }));
  const lobby = parties.create(players[0], CAR_IDS[0], { maxPlayers: 8 });
  players.slice(1).forEach((player, i) => parties.join(player, lobby.code, CAR_IDS[i + 1]));
  const race = parties.start(players[0], {}).race!;
  players.slice(0, 7).forEach(player => assert.equal(parties.update(player, race.id, true).race.startAt, null));
  const start = parties.update(players[7], race.id, true).race.startAt!;
  assert.equal(new Set(race.racers.map(r => r.slot)).size, 8);
  now = start + 1;
  players.forEach((player, slot) => parties.update(player, race.id, true, { sequence: 1, p: race.grid[slot].position, q: race.grid[slot].rotation, lap: 1, checkpoint: 0, finished: false }));
  for (const player of players) {
    const snapshot = parties.update(player, race.id, true).race;
    assert.equal(snapshot.startAt, start);
    assert.equal(snapshot.racers.filter(r => r.pose).length, 8);
  }
});

test('grid order is drawn at random, so the host does not always start on pole', () => {
  const poles = new Set<string>();
  for (const roll of [0, .99]) {
    const parties = new Parties(() => 1000, () => roll);
    const lobby = parties.create(host, 'porsche-911-gt3', {});
    parties.join(guest, lobby.code, 'celica-gt4');
    const race = parties.start(host, {}).race!;
    assert.deepEqual(race.racers.map(r => r.slot).sort(), [0, 1]);
    poles.add(race.racers.find(r => r.slot === 0)!.id);
  }
  assert.equal(poles.size, 2, 'either driver can draw pole');
});
