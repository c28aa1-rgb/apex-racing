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
