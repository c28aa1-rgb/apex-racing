import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Parties, PARTY_PRESENCE_MS } from '../server/parties';
import { createApp } from '../server/app';
import { Store } from '../server/store';
import { requestParty } from '../src/use-party';

const host = { id: 'host', nickname: 'Apex Host' }, guest = { id: 'guest', nickname: 'Guest Driver' };

test('party transport only sends JSON content-type when a body is present', async () => {
  const original = globalThis.fetch, calls: RequestInit[] = [];
  globalThis.fetch = async (_url, init) => { calls.push(init!); return new Response(JSON.stringify({ lobby: null }), { status: 200 }); };
  try {
    await requestParty('/current', 'test-token');
    await requestParty('/me', 'test-token', 'DELETE');
    await requestParty('/settings', 'test-token', 'PATCH', { laps: 7 });
    for (const call of calls.slice(0, 2)) {
      assert.equal(new Headers(call.headers).has('Content-Type'), false);
      assert.equal(call.body, undefined);
      assert.equal(new Headers(call.headers).get('Authorization'), 'Bearer test-token');
    }
    assert.equal(new Headers(calls[2].headers).get('Content-Type'), 'application/json');
    assert.equal(calls[2].body, JSON.stringify({ laps: 7 }));
  } finally { globalThis.fetch = original; }
});

test('parties enforce capacity, membership, ownership and host succession', () => {
  const parties = new Parties();
  const room = parties.create(host, 'porsche-911-gt3', { maxPlayers: 2 });
  assert.match(room.code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(parties.create(host, 'celica-gt4').code, room.code);
  parties.join(guest, room.code, 'red-bull-rb19');
  assert.equal(parties.join(guest, room.code, 'red-bull-rb19').members.length, 2);
  assert.throws(() => parties.join({ id: 'third', nickname: 'Third Driver' }, room.code, 'celica-gt4'), /full/);
  assert.throws(() => parties.settings(guest, { laps: 8 }), /Only the host/);
  assert.throws(() => parties.settings(host, { maxPlayers: 1 }), /lower than/);
  const changed = parties.settings(host, { trackId: 'spa', weather: 'rain', laps: 12, maxPlayers: 4 });
  assert.deepEqual(parties.current(guest)?.settings, changed.settings);
  parties.car(guest, 'mazda-787b');
  assert.equal(parties.current(host)?.members[1].carId, 'mazda-787b');
  assert.equal(parties.current(host)?.members[0].carId, 'porsche-911-gt3');
  const other = parties.create({ id: 'outsider', nickname: 'Outsider' }, 'celica-gt4');
  assert.throws(() => parties.join(guest, other.code, 'celica-gt4'), /Leave your current/);
  assert.equal(parties.current(guest)?.code, room.code);
  const snapshot = parties.current(host)!; snapshot.settings.laps = 99; snapshot.members[0].nickname = 'Mutated';
  assert.equal(parties.current(host)?.settings.laps, 12);
  assert.equal(parties.current(host)?.members[0].nickname, host.nickname);
  parties.leave(host);
  assert.equal(parties.current(guest)?.hostId, guest.id);
  assert.equal(parties.settings(guest, { weather: 'snow' }).settings.weather, 'snow');
  parties.leave(guest);
  assert.equal(parties.current(guest), null);
  assert.throws(() => parties.join(host, room.code, 'celica-gt4'), /not found/);
});

test('presence expires disconnected members while refreshing names and preserving active guests', () => {
  let now = 0; const parties = new Parties(() => now);
  const room = parties.create(host, 'porsche-911-gt3');
  parties.join(guest, room.code, 'celica-gt4');
  now = PARTY_PRESENCE_MS - 10_000;
  assert.equal(parties.current({ ...guest, nickname: 'New Name' })?.members[1].nickname, 'New Name');
  now = PARTY_PRESENCE_MS + 1; parties.sweep();
  assert.equal(parties.current(host), null);
  assert.equal(parties.current(guest)?.hostId, guest.id);
  now += PARTY_PRESENCE_MS + 1; parties.sweep();
  assert.equal(parties.current(guest), null);
  assert.throws(() => parties.join(host, room.code, 'celica-gt4'), /not found/);
});

test('party API validates payloads, authenticates players and synchronizes independent clients', async () => {
  const store = new Store(); await store.init();
  const app = await createApp(store, async () => { throw new Error('Race validation is outside lobby scope'); });
  try {
    const identities = await Promise.all(['Host', 'Guest', 'Outsider'].map(nickname => store.createPlayer(nickname)));
    const headers = identities.map(player => ({ authorization: `Bearer ${player.token}` }));
    assert.equal((await app.inject({ url: '/api/parties/current' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/parties', headers: headers[0], payload: { carId: 'missing' } })).statusCode, 400);
    const created = await app.inject({ method: 'POST', url: '/api/parties', headers: headers[0], payload: { carId: 'porsche-911-gt3', settings: { laps: 5 } } });
    assert.equal(created.statusCode, 201, created.body);
    const code = created.json().lobby.code;
    assert.equal(created.headers['cache-control'], 'no-store');
    assert.equal(created.body.includes(identities[0].token), false);
    assert.equal((await app.inject({ method: 'POST', url: '/api/parties/join', headers: headers[1], payload: { code: ` ${code.toLowerCase()} `, carId: 'celica-gt4' } })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/parties/current', headers: headers[2] })).json().lobby, null);
    assert.equal((await app.inject({ method: 'PATCH', url: '/api/parties/settings', headers: headers[1], payload: { laps: 10 } })).statusCode, 403);
    for (const payload of [{ laps: 0 }, { laps: 1.5 }, { laps: 100 }, { weather: 'storm' }, { trackId: 'missing' }, { maxPlayers: 9 }, { hostId: identities[1].id }]) {
      assert.equal((await app.inject({ method: 'PATCH', url: '/api/parties/settings', headers: headers[0], payload })).statusCode, 400, JSON.stringify(payload));
    }
    assert.equal((await app.inject({ method: 'PATCH', url: '/api/parties/me', headers: headers[1], payload: { carId: 'red-bull-rb19', id: identities[0].id } })).statusCode, 400);
    await app.inject({ method: 'PATCH', url: '/api/parties/settings', headers: headers[0], payload: { trackId: 'daytona', weather: 'fog', laps: 7 } });
    await app.inject({ method: 'PATCH', url: '/api/parties/me', headers: headers[1], payload: { carId: 'red-bull-rb19' } });
    const fromGuest = (await app.inject({ url: '/api/parties/current', headers: headers[1] })).json().lobby;
    assert.equal(fromGuest.settings.trackId, 'daytona'); assert.equal(fromGuest.settings.weather, 'fog'); assert.equal(fromGuest.settings.laps, 7);
    assert.equal(fromGuest.members[1].carId, 'red-bull-rb19');
    assert.equal((await app.inject({ method: 'POST', url: '/api/parties/start', headers: headers[1] })).statusCode, 403);
    const started = await app.inject({ method: 'POST', url: '/api/parties/start', headers: headers[0] });
    assert.equal(started.statusCode, 200, started.body);
    const raceId = started.json().lobby.race.id;
    assert.equal((await app.inject({ method: 'PATCH', url: '/api/parties/me', headers: headers[1], payload: { carId: 'celica-gt4' } })).statusCode, 409);
    const raceUpdate = { raceId, ready: true };
    assert.equal((await app.inject({ method: 'POST', url: '/api/parties/race', headers: headers[2], payload: raceUpdate })).statusCode, 409);
    assert.equal((await app.inject({ method: 'POST', url: '/api/parties/race', headers: headers[1], payload: { ...raceUpdate, playerId: identities[0].id } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/parties/race', headers: headers[0], payload: raceUpdate })).json().race.startAt, null);
    const ready = (await app.inject({ method: 'POST', url: '/api/parties/race', headers: headers[1], payload: raceUpdate })).json();
    assert.ok(ready.race.startAt > ready.serverNow);
    assert.equal(ready.race.racers.length, 2);
    assert.equal(JSON.stringify(ready).includes(identities[0].token), false);
    assert.equal((await app.inject({ method: 'POST', url: '/api/parties/reopen', headers: headers[1] })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/parties/reopen', headers: headers[0] })).statusCode, 200);
    await app.inject({ method: 'DELETE', url: '/api/parties/me', headers: headers[0] });
    const successor = (await app.inject({ url: '/api/parties/current', headers: headers[1] })).json().lobby;
    assert.equal(successor.hostId, identities[1].id);
    assert.equal((await app.inject({ method: 'PATCH', url: '/api/parties/settings', headers: headers[1], payload: { laps: 2 } })).statusCode, 200);
  } finally { await app.close(); await store.close(); }
});
