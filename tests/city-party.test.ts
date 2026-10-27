import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Parties } from '../shared/party-room';
import { PartyTraffic, PARTY_TRAFFIC_KINDS } from '../shared/city-party-traffic';
import { TrafficSim } from '../shared/city-traffic-sim';
import { CITY_ROADS, CITY_SIGNAL_POLES } from '../shared/city.data';

const car = 'porsche-911-gt3' as never;
const pose = (sequence: number, x: number, z: number) => ({ sequence, p: { x, y: 1, z }, q: { x: 0, y: 0, z: 0, w: 1 }, v: { x: 0, y: 0, z: 10 }, lap: 1, checkpoint: 0, finished: false });

test('a city party runs one traffic for two drivers, hands it back to the last one and takes late friends', () => {
  let clock = 1_000_000;
  const parties = new Parties(() => clock), A = { id: 'a', nickname: 'Alpha' }, B = { id: 'b', nickname: 'Bravo' }, C = { id: 'c', nickname: 'Charlie' };
  const lobby = parties.create(A, car, { trackId: 'racing-city' });
  parties.join(B, lobby.code, car);
  const race = parties.start(A, {}).race!;
  assert.equal(race.checkpoints.length, 0);
  let sequence = 0, asked = false, packets = 0, handoff = false;
  for (let tick = 0; tick < 400; tick++) {
    clock += 50; parties.tick();
    if (tick % 2) continue;
    for (const [player, x] of [[A, 120], [B, 140]] as const) {
      if (player === B && tick > 300) continue;
      const ready = tick > 4, result = parties.update(player, race.id, ready, ready ? pose(++sequence, x, 80) : undefined) as { traffic?: { seed?: boolean; handoff?: boolean; cars: number[][] } };
      if (result.traffic?.seed) asked = true;
      else if (result.traffic?.handoff) { handoff = true; assert.equal(player, A); }
      else if (result.traffic?.cars.length) packets++;
    }
  }
  assert.ok(asked, 'the server asks a driver for their traffic to start from');
  assert.ok(packets > 50, 'both drivers get the cars near them');
  assert.ok(handoff, 'the last driver left gets the traffic back');
  assert.equal(parties.trafficRunning, false);
  const joined = parties.join(C, lobby.code, car);
  assert.ok(joined.race!.racers.some(r => r.id === 'c'), 'a friend can join while the city party runs');
});

test('a game following the server traffic sees the same cars in the same places', () => {
  let clock = 0;
  const server = new PartyTraffic(() => clock), at = new THREE.Vector3(150, 0, 80);
  server.drive('a', at); server.drive('b', at); server.start();
  // Kinds in another order, as a game's models may load in.
  const client = new TrafficSim(CITY_ROADS, CITY_SIGNAL_POLES, [...PARTY_TRAFFIC_KINDS].reverse());
  client.spawning = false;
  let worst = 0;
  for (let tick = 0; tick < 600; tick++) {
    clock += 50; server.step();
    client.step(.05, [{ position: at, velocity: new THREE.Vector3() }]);
    const packet = server.packet('a');
    if (!packet) continue;
    for (const record of packet.cars) client.apply(record);
    client.applySignals(packet.signals);
    if (tick < 100) continue;
    for (const mine of client.cars) {
      const theirs = server.sim.byId(mine.id);
      if (theirs && theirs.position.distanceTo(at) < 200) { worst = Math.max(worst, mine.position.distanceTo(theirs.position) - mine.drift.length()); assert.equal(mine.kind.name, theirs.kind.name); }
    }
  }
  assert.ok(client.cars.length > 10);
  assert.ok(worst < 2, `cars stay within 2 m of the server's (worst ${worst.toFixed(2)} m)`);
});

test('everyone entering the city shares a public room until it is full, with no host controls', () => {
  let clock = 1_000_000;
  const parties = new Parties(() => clock), drivers = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, nickname: `Driver ${i}` }));
  const lobbies = drivers.map(d => parties.joinCity(d, car));
  assert.ok(lobbies.slice(0, 8).every(l => l.code === 'PUBLCA' && l.public), 'the first eight share the first room');
  assert.equal(lobbies[8].code, 'PUBLCB', 'the ninth starts the next room');
  const room = parties.current(drivers[0])!;
  assert.equal(room.race!.racers.length, 8);
  assert.equal(new Set(room.race!.racers.map(r => r.slot)).size, 8, 'each on their own grid place');
  for (const call of [() => parties.settings(drivers[0], { laps: 2 }), () => parties.kick(drivers[0], 'p1'), () => parties.reopen(drivers[0])])
    assert.throws(call, /no host controls/);
  // Someone leaves: their place is free for the next driver, and the list keeps only who is there.
  parties.leave(drivers[3]);
  assert.equal(parties.current(drivers[0])!.race!.racers.length, 7);
  const late = { id: 'late', nickname: 'Late' };
  assert.equal(parties.joinCity(late, car).code, 'PUBLCA');
  assert.equal(parties.current(late)!.race!.racers.find(r => r.id === 'late')!.slot, room.race!.racers.find(r => r.id === 'p3')!.slot);
  // Typed into Join a lobby, a public code works too; a private lobby never gets one.
  assert.equal(parties.join({ id: 'typed', nickname: 'Typed' }, 'PUBLCB', car).code, 'PUBLCB');
  for (let i = 0; i < 200; i++) assert.ok(!parties.create({ id: `c${i}`, nickname: 'Host' }, car).code.startsWith('PUBLC'));
  // Hours later it is still running; when the last driver goes, the room goes.
  clock += 10 * 3_600_000;
  for (const d of [...drivers.slice(0, 8), late]) { if (d === drivers[3]) continue; parties.joinCity(d, car); }
  assert.equal(parties.current(late)!.race!.ended, false);
  for (const d of [...drivers.slice(0, 8), late]) parties.leave(d);
  assert.equal(parties.joinCity({ id: 'fresh', nickname: 'Fresh' }, car).members.length, 1, 'a new session for the next arrival');
});

test('a driver racing a street race away from the public city drops out of its traffic and comes back', () => {
  let clock = 1_000_000;
  const parties = new Parties(() => clock), A = { id: 'a', nickname: 'Alpha' }, B = { id: 'b', nickname: 'Bravo' };
  const race = parties.joinCity(A, car).race!; parties.joinCity(B, car);
  let sequence = 0, handoff = false, awaySeen = false, back = false;
  for (let tick = 0; tick < 300; tick++) {
    clock += 50; parties.tick();
    if (tick % 2) continue;
    const away = tick > 100 && tick < 200;
    for (const [player, x] of [[A, 120], [B, 140]] as const) {
      const ready = tick > 4, result = parties.update(player, race.id, ready, ready && !(player === B && away) ? pose(++sequence, x, 80) : undefined, undefined, player === B && away) as { race: { racers: { id: string; away?: boolean }[] }; traffic?: { seed?: boolean; handoff?: boolean; cars: number[][] } };
      if (player === B && away) assert.equal(result.traffic, undefined, 'no traffic while away');
      if (player === A && result.traffic?.handoff) handoff = true;
      if (result.race.racers.find(r => r.id === 'b')?.away) awaySeen = true;
      if (player === B && tick > 210 && result.traffic?.cars.length) back = true;
    }
  }
  assert.ok(awaySeen, 'others see the driver is away');
  assert.ok(handoff, 'the driver left in the city runs the traffic meanwhile');
  assert.ok(back, 'back in the city, they get the shared traffic again');
});
