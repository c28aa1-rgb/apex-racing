import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CAR } from '../shared/cars';
import { Parties, settingsSchema, updateSchema } from '../shared/party-room';
import { highwayPartySeed, isRoamParty } from '../shared/party';
import { HighwayRoad, laneCentre } from '../shared/highway';

const car = DEFAULT_CAR.id;

test('a highway party: host traffic settings, no server traffic, friends join while it runs, far-off positions accepted', () => {
  let clock = 1_000_000;
  const parties = new Parties(() => clock), A = { id: 'a', nickname: 'Alpha' }, B = { id: 'b', nickname: 'Bravo' }, C = { id: 'c', nickname: 'Charlie' };
  const lobby = parties.create(A, car, { trackId: 'highway' });
  assert.ok(isRoamParty(lobby.settings));
  parties.join(B, lobby.code, car);
  // The host sets the traffic; nonsense is refused by the schema.
  assert.deepEqual(parties.settings(A, { traffic: { density: 38, speedKph: 200 } }).settings.traffic, { density: 38, speedKph: 200 });
  assert.equal(settingsSchema.partial().safeParse({ traffic: { density: 500, speedKph: 105 } }).success, false);
  assert.equal(settingsSchema.partial().safeParse({ trackId: 'highway' }).success, true);
  const race = parties.start(A, {}).race!;
  assert.equal(race.racers.length, 2);
  // Everyone builds the same road from the session id.
  assert.equal(highwayPartySeed(race.id), highwayPartySeed(race.id));
  const road = new HighwayRoad(highwayPartySeed(race.id));
  // 60 km down the road: absolute positions far outside a venue's, with the distance along it.
  const far = road.lanePose(60000, 1);
  const pose = (sequence: number, s: number) => ({ sequence, t: clock, p: { x: far.x, y: far.y, z: far.z }, q: { x: 0, y: 0, z: 0, w: 1 }, v: { x: 0, y: 0, z: 30 }, lap: 1, checkpoint: 0, finished: false, s });
  assert.equal(updateSchema.safeParse({ raceId: race.id, ready: true, pose: pose(1, 60000) }).success, true);
  for (let tick = 0; tick < 6; tick++) {
    clock += 500;
    for (const player of [A, B]) {
      const result = parties.update(player, race.id, true, tick > 1 ? pose(tick, 60000 + tick) : undefined) as { race: { startAt: number | null }; traffic?: unknown };
      assert.equal(result.traffic, undefined, 'the highway has no server traffic (each screen runs its own)');
    }
  }
  assert.ok(parties.update(A, race.id, true).race.startAt, 'driving started without lights');
  assert.equal(parties.update(A, race.id, true).race.racers.find(r => r.id === 'a')!.pose!.s, 60005);
  // A friend joins while it runs, onto a free place.
  const joined = parties.join(C, lobby.code, car);
  assert.ok(joined.race!.racers.some(r => r.id === 'c' && r.slot === 2));
  assert.ok(Math.abs(road.project(far.x, far.z, 60000).lat - laneCentre(1)) < .05);
});
