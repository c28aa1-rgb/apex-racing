import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer } from 'node:net';
import type { PartyLobby } from '../shared/party';
import { Parties } from '../shared/party-room';
import { TRACKS } from '../shared/tracks';
import { PHYSICS_VERSION } from '../shared/physics-version';

// Run a real Wrangler server: exercise HTTP, native WebSockets and separate DO instances.
test('Cloudflare rooms synchronize, isolate, validate, reconnect and cleanly leave', { timeout: 90000 }, async () => {
  const port = await new Promise<number>(resolve => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const address = server.address() as { port: number }; server.close(() => resolve(address.port)); }); });
  const directory = await mkdtemp(join(tmpdir(), 'apex-cloudflare-'));
  await promisify(execFile)(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'apex-times', '--local', '--persist-to', directory, '--file', 'cloudflare/migrations/0001_times.sql'], { env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  const child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', directory, '--var', 'SESSION_SECRET:test-secret-at-least-thirty-two-characters'], { cwd: process.cwd(), env: { ...process.env, WRANGLER_SEND_METRICS: 'false', BROWSER: 'none' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const base = `http://127.0.0.1:${port}`, sockets: WebSocket[] = [];
  async function request(path: string, token?: string, data?: unknown, origin?: string) {
    return fetch(base + path, { method: data === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}), ...(origin ? { Origin: origin } : {}) }, body: data === undefined ? undefined : JSON.stringify(data) });
  }
  async function client(code: string, token: string) {
    const ws = new WebSocket(`${base.replace('http:', 'ws:')}/api/rooms/${code}/socket`, `apex.${token}`); sockets.push(ws);
    const packets: any[] = []; ws.addEventListener('message', event => packets.push(JSON.parse(String(event.data))));
    await new Promise<void>((resolve, reject) => { ws.addEventListener('open', () => resolve(), { once: true }); ws.addEventListener('error', () => reject(new Error('WebSocket upgrade failed')), { once: true }); });
    let id = 0;
    async function wait(predicate: (packet: any) => boolean) {
      const until = Date.now() + 5000;
      while (Date.now() < until) { const found = packets.find(predicate); if (found) return found; await sleep(20); }
      throw new Error('Expected WebSocket packet missing');
    }
    return { ws, packets, wait, async send(path: string, body?: unknown, method = 'POST') { const next = ++id; ws.send(JSON.stringify({ id: next, path, method, ...(body === undefined ? {} : { body }) })); return wait(packet => packet.id === next); } };
  }
  try {
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) { try { ready = (await request('/api/health')).ok; } catch {} if (ready) break; if (child.exitCode !== null) break; await sleep(500); }
    assert.ok(ready, output.slice(-4000));
    assert.equal((await request('/api/health', undefined, undefined, 'https://untrusted.example')).status, 403);
    const preflight = await fetch(base + '/api/players', { method: 'OPTIONS', headers: { Origin: 'http://127.0.0.1:5173', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Content-Type,Authorization' } });
    assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'http://127.0.0.1:5173');
    assert.equal((await request('/api/parties', undefined, { carId: 'celica-gt4' })).status, 401);
    const identities = await Promise.all(['Host', 'Guest', 'Other', 'Third'].map(async nickname => (await request('/api/players', undefined, { nickname })).json() as Promise<{ id: string; token: string }>));
    const [host, guest, other, third] = identities;
    const track = TRACKS[0];
    const run = { trackId: track.id, trackVersion: track.version, physicsVersion: PHYSICS_VERSION, carId: 'celica-gt4', timeMs: 2000, inputs: Array(120).fill(1), steering: Array(120).fill(1), drift: Array(120).fill(.5), manual: true };
    assert.equal((await request('/api/runs', undefined, run)).status, 401);
    assert.equal((await request('/api/runs', host.token, { ...run, physicsVersion: 'obsolete' })).status, 422);
    assert.equal((await request('/api/runs', host.token, { ...run, timeMs: 1 })).status, 422);
    assert.equal((await request('/api/runs', host.token, { ...run, playerId: guest.id })).status, 422);
    assert.equal((await request('/api/runs', host.token, { ...run, trackVersion: -1 })).status, 422);
    const saved = await request('/api/runs', host.token, run); assert.equal(saved.status, 201);
    const record = await saved.json() as any; assert.equal(record.improved, true); assert.equal(record.verified, false);
    const id = record.entries[0].id;
    assert.deepEqual(await (await request(`/api/replays/${id}`)).json(), run);
    const faster = { ...run, inputs: Array(90).fill(1), steering: Array(90).fill(1), drift: Array(90).fill(.5), timeMs: 1500 };
    const improved = await (await request('/api/runs', host.token, faster)).json() as any;
    assert.equal(improved.improved, true); assert.equal(improved.entries[0].id, id);
    assert.equal((await (await request('/api/runs', host.token, run)).json() as any).improved, false);
    assert.deepEqual(await (await request(`/api/replays/${id}`)).json(), faster);
    await request('/api/runs', guest.token, { ...run, inputs: Array(60).fill(1), steering: Array(60).fill(1), drift: Array(60).fill(.5), timeMs: 1000 });
    const renamed = await fetch(base + '/api/players/me', { method: 'PUT', headers: { Authorization: `Bearer ${host.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ nickname: 'Renamed Host' }) });
    assert.equal(renamed.status, 200);
    await request('/api/runs', host.token, run); // An old signed nickname must not overwrite the database nickname.
    const board = await (await request(`/api/leaderboards/${track.id}`)).json() as any;
    assert.equal(board.verified, false); assert.deepEqual(board.entries.map((e: any) => [e.playerId,e.rank,e.timeMs,e.nickname]), [[guest.id,1,1000,'Guest'],[host.id,2,1500,'Renamed Host']]);
    assert.equal(board.entries[0].verified, false); assert.equal(board.entries[0].manual, true);
    assert.equal((await request('/api/replays/00000000-0000-4000-8000-000000000000')).status, 404);
    assert.equal((await request('/api/leaderboards/missing')).status, 404);
    assert.equal((await request('/api/runs', host.token, { ...run, inputs: Array(18000).fill(1), steering: Array(18000).fill(1.77777777777777), drift: Array(18000).fill(1.55555555555555), timeMs: 300000 })).status, 413);
    assert.equal((await request('/api/parties', host.token + 'tampered', { carId: 'celica-gt4' })).status, 401);
    assert.equal((await request('/api/parties', host.token, { carId: 'invalid' })).status, 400);
    const missing = await request('/api/parties/join', guest.token, { code: 'AAAAAA', carId: 'celica-gt4' });
    assert.equal(missing.status, 404, `${await missing.text()}\n${output.slice(-2000)}`);
    const lobby: PartyLobby = (await (await request('/api/parties', host.token, { carId: 'porsche-911-gt3', settings: { maxPlayers: 2 } })).json() as any).lobby;
    assert.ok(!(JSON.stringify(lobby).includes(host.token)));
    assert.equal((await request('/api/parties/join', guest.token, { code: lobby.code, carId: 'celica-gt4' })).status, 200);
    assert.equal((await request('/api/parties/join', third.token, { code: lobby.code, carId: 'celica-gt4' })).status, 409);
    const separate: PartyLobby = (await (await request('/api/parties', other.token, { carId: 'celica-gt4' })).json() as any).lobby;
    assert.notEqual(lobby.code, separate.code);
    assert.equal((await request(`/api/rooms/${lobby.code}/current`, other.token)).status, 404);
    const a = await client(lobby.code, host.token), b = await client(lobby.code, guest.token), c = await client(separate.code, other.token);
    assert.equal((await b.send('/start')).status, 403);
    const started = (await a.send('/start')).data.lobby.race;
    await a.send('/race', { raceId: started.id, ready: true });
    const countdown = (await b.send('/race', { raceId: started.id, ready: true })).data;
    await sleep(Math.max(0, countdown.race.startAt - Date.now() + 10));
    const pose = { sequence: 1, p: started.grid[0].position, q: started.grid[0].rotation, lap: 1, checkpoint: 0, finished: false, t: 1000 };
    await a.send('/race', { raceId: started.id, ready: true, pose });
    await b.wait(packet => packet.type === 'race' && packet.race.racers.some((r: any) => r.id === host.id && r.pose?.sequence === 1));
    await b.send('/race', { raceId: started.id, ready: true, pose: { ...pose, sequence: 2 } });
    await a.wait(packet => packet.type === 'race' && packet.race.racers.some((r: any) => r.id === guest.id && r.pose?.sequence === 2));
    assert.equal((await a.send('/race', { raceId: started.id, ready: true, playerId: guest.id, pose })).status, 400);
    assert.equal((await c.send('/current', undefined, 'GET')).data.lobby.code, separate.code);
    assert.equal(c.packets.some(packet => JSON.stringify(packet).includes(host.id)), false);
    b.ws.close(); await sleep(150);
    const reconnected = await client(lobby.code, guest.token);
    assert.equal((await reconnected.send('/race', { raceId: started.id, ready: true, pose: { ...pose, sequence: 3 } })).data.race.racers.find((r: any) => r.id === guest.id).pose.sequence, 3);
    await reconnected.send('/me', undefined, 'DELETE');
    assert.equal((await a.send('/current', undefined, 'GET')).data.lobby.members.length, 1);
    await a.send('/reopen');
    await a.send('/me', undefined, 'DELETE');
    assert.equal((await request('/api/parties/join', third.token, { code: lobby.code, carId: 'celica-gt4' })).status, 404);
    assert.equal((await c.send('/current', undefined, 'GET')).data.lobby.code, separate.code);
  } finally {
    for (const ws of sockets) ws.close();
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.kill('SIGTERM'); await Promise.race([exited, sleep(3000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
});

test('shared room state survives serialization with membership, readiness and poses', () => {
  let now = 1000;
  const first = new Parties(() => now), host = { id: 'host', nickname: 'Host' };
  const lobby = first.create(host, 'celica-gt4'); const race = first.start(host, {}).race!;
  const ready = first.update(host, race.id, true); now = ready.race.startAt! + 1;
  first.update(host, race.id, true, { sequence: 4, p: race.grid[0].position, q: race.grid[0].rotation, lap: 1, checkpoint: 0, finished: false });
  const recovered = new Parties(() => now); recovered.restoreState(JSON.parse(JSON.stringify(first.exportState())));
  assert.deepEqual(recovered.current(host), first.current(host));
  assert.equal(recovered.current(host)?.code, lobby.code);
  assert.equal(recovered.current(host)?.race?.racers[0].ready, true);
  assert.equal(recovered.current(host)?.race?.racers[0].pose?.sequence, 4);
  assert.throws(() => recovered.create({ id: 'other', nickname: 'Other' }, 'celica-gt4', {}, lobby.code), /collision/);
});
