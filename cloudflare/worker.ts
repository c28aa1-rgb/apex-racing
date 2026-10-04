import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import { Parties, createSchema, joinSchema, carSchema, settingsSchema, updateSchema, PARTY_PRESENCE_MS } from '../shared/party-room';
import type { PartyMember, PartyPose } from '../shared/party';
import { savePlayer, times } from './times';

type Identity = Pick<PartyMember, 'id' | 'nickname'>;
interface Env { RACE_ROOMS: DurableObjectNamespace<RaceRoom>; TIMES: D1Database; SESSION_SECRET: string; ALLOWED_ORIGINS: string; CONNECTION_LIMIT: RateLimit }
type Session = Identity & { exp: number };
type Attachment = { player: Identity; seen: number; window: number; count: number; raceId?: string; pose?: PartyPose };
function restoreAttachment(state: ReturnType<Parties['exportState']>, saved: Attachment) {
  for (const room of state) {
    const seen = room.seen.find(([id]) => id === saved.player.id); if (seen) seen[1] = Math.max(seen[1], saved.seen);
    const racer = room.race && room.race.id === saved.raceId ? room.race.racers.find(r => r.id === saved.player.id) : undefined;
    if (racer && saved.pose && saved.pose.sequence > (racer.pose?.sequence ?? -1)) racer.pose = saved.pose;
  }
}
const nickname = z.object({ nickname: z.string().trim().min(2).max(18).regex(/^[\p{L}\p{N} _-]+$/u) }).strict();
const command = z.object({ id: z.number().int().nonnegative(), path: z.enum(['/current', '/me', '/settings', '/start', '/reopen', '/race']), method: z.enum(['GET', 'POST', 'PATCH', 'DELETE']), body: z.unknown().optional() }).strict();
const codePattern = /^[A-HJ-NP-Z2-9]{6}$/;
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const fail = (statusCode: number, message: string): never => { throw Object.assign(new Error(message), { statusCode }); };
function error(cause: unknown) {
  if (cause instanceof z.ZodError || cause instanceof SyntaxError) return { error: 'Invalid multiplayer message.', status: 400 };
  const failure = cause as { message?: string; statusCode?: number };
  if (!failure.statusCode) console.error(cause);
  return { error: failure.statusCode ? failure.message : 'Multiplayer service unavailable.', status: failure.statusCode ?? 500 };
}
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const decode = (value: string) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
async function key(env: Env) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) fail(503, 'Configure SESSION_SECRET before using multiplayer.');
  return crypto.subtle.importKey('raw', new TextEncoder().encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function issue(env: Env, player: Identity) {
  const payload = encode(new TextEncoder().encode(JSON.stringify({ ...player, exp: Date.now() + 30 * 86400000 })));
  const signature = await crypto.subtle.sign('HMAC', await key(env), new TextEncoder().encode(payload));
  await savePlayer(env.TIMES, player);
  return { ...player, token: `${payload}.${encode(new Uint8Array(signature))}` };
}
async function authenticate(request: Request, env: Env): Promise<Identity> {
  const token = request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? request.headers.get('Sec-WebSocket-Protocol')?.replace(/^apex\./, '') ?? '';
  try {
    if (token.length > 1024) throw new Error();
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra || !await crypto.subtle.verify('HMAC', await key(env), decode(signature), new TextEncoder().encode(payload))) throw new Error();
    const session = JSON.parse(new TextDecoder().decode(decode(payload))) as Session;
    if (session.exp < Date.now() || !Number.isFinite(session.exp) || typeof session.id !== 'string' || typeof session.nickname !== 'string') throw new Error();
    return { id: session.id, nickname: session.nickname };
  } catch { return fail(401, 'Player session expired. Set your nickname again.'); }
}
async function body(request: Request, limit = 4096) {
  if (Number(request.headers.get('Content-Length')) > limit) fail(413, 'Message too large.');
  const reader = request.body?.getReader();
  if (!reader) return {};
  let size = 0, text = ''; const decoder = new TextDecoder();
  while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > limit) { await reader.cancel(); fail(413, 'Message too large.'); } text += decoder.decode(part.value, { stream: true }); }
  return JSON.parse(text + decoder.decode());
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin');
    const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map(value => value.trim());
    if (origin && !allowed.includes(origin)) return json({ error: 'Origin not allowed.' }, 403);
    const cors = { 'Access-Control-Allow-Origin': origin ?? allowed[0] ?? '', 'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization', 'Vary': 'Origin' };
    let response: Response;
    try {
      const url = new URL(request.url);
      if (request.method !== 'OPTIONS' && url.pathname !== '/api/health' && !(await env.CONNECTION_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'local' })).success) fail(429, 'Too many connection attempts. Try again shortly.');
      if (request.method === 'OPTIONS') response = new Response(null, { status: 204 });
      else if (url.pathname === '/api/health') response = json({ ok: true, backend: 'cloudflare' });
      else if (url.pathname === '/api/players' && request.method === 'POST') response = json(await issue(env, { id: crypto.randomUUID(), ...nickname.parse(await body(request)) }), 201);
      else if (url.pathname === '/api/players/me' && request.method === 'PUT') response = json(await issue(env, { ...await authenticate(request, env), ...nickname.parse(await body(request)) }));
      else if (request.method === 'GET' && /^\/api\/(leaderboards|replays)\//.test(url.pathname)) response = await times(request, env.TIMES);
      else if (url.pathname === '/api/runs' && request.method === 'POST') response = await times(request, env.TIMES, await authenticate(request, env), await body(request, 512000));
      else {
        const player = await authenticate(request, env);
        let code: string, action: string, payload: unknown;
        const socket = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})\/(socket|current)$/);
        if (socket && request.method === 'GET' && (socket[2] === 'current' || request.headers.get('Upgrade')?.toLowerCase() === 'websocket')) { code = socket[1]; action = socket[2]; }
        else if (url.pathname === '/api/parties' && request.method === 'POST') {
          payload = createSchema.parse(await body(request)); action = 'create';
          const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
          code = Array.from(crypto.getRandomValues(new Uint8Array(6)), n => alphabet[n % alphabet.length]).join('');
        } else if (url.pathname === '/api/parties/join' && request.method === 'POST') { payload = joinSchema.parse(await body(request)); code = (payload as { code: string }).code; action = 'join'; }
        else return json({ error: 'Endpoint not available on the multiplayer backend.' }, 404);
        if (!codePattern.test(code)) fail(400, 'Invalid lobby code.');
        const headers = new Headers({ 'X-Player': JSON.stringify(player) });
        if (action === 'socket') { headers.set('Upgrade', 'websocket'); headers.set('Sec-WebSocket-Protocol', request.headers.get('Sec-WebSocket-Protocol')!); }
        response = await env.RACE_ROOMS.get(env.RACE_ROOMS.idFromName(code)).fetch(new Request(`https://room/${action}?code=${code}`, { method: action === 'socket' ? 'GET' : 'POST', headers, body: action === 'socket' ? undefined : JSON.stringify(payload) }));
      }
    } catch (cause) { const result = error(cause); response = json({ error: result.error }, result.status); }
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'no-store');
    headers.set('X-Content-Type-Options', 'nosniff');
    for (const [name, value] of Object.entries(cors)) headers.set(name, value);
    response = new Response(response.body, { status: response.status, headers, ...(response.webSocket ? { webSocket: response.webSocket } : {}) });
    return response;
  },
} satisfies ExportedHandler<Env>;

export class RaceRoom extends DurableObject<Env> {
  private parties = new Parties();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const state = await ctx.storage.get<ReturnType<Parties['exportState']>>('room') ?? [];
      for (const ws of ctx.getWebSockets()) restoreAttachment(state, ws.deserializeAttachment() as Attachment);
      this.parties.restoreState(state);
    });
  }
  private async persist() {
    const state = this.parties.exportState();
    if (state.length) { await this.ctx.storage.put('room', state); if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + PARTY_PRESENCE_MS); }
    else { await this.ctx.storage.deleteAll(); await this.ctx.storage.deleteAlarm(); }
  }
  private broadcast(raceOnly = false, exclude?: WebSocket) {
    const room = this.parties.exportState()[0];
    if (!room) return;
    const { seen, ...lobby } = room;
    // ponytail: batch up to eight poses; field-level deltas if measured bandwidth requires it.
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      try { ws.send(JSON.stringify(raceOnly && lobby.race ? { type: 'race', race: this.compact(lobby.race), serverNow: Date.now() } : { type: 'lobby', lobby, serverNow: Date.now() })); } catch { /* Close handler handles membership. */ }
    }
  }
  private compact(race: NonNullable<ReturnType<Parties['current']>>['race']) {
    if (!race) return undefined;
    return { id: race.id, startAt: race.startAt, ended: race.ended, racers: race.racers };
  }
  async fetch(request: Request) {
    try {
      const player = JSON.parse(request.headers.get('X-Player')!) as Identity;
      const url = new URL(request.url), code = url.searchParams.get('code')!;
      if (url.pathname === '/socket') {
        if (!this.parties.current(player)) fail(404, 'Your lobby has closed. Create or join a lobby.');
        const existing = this.ctx.getWebSockets().filter(ws => (ws.deserializeAttachment() as Attachment).player.id === player.id);
        for (const ws of existing) ws.close(1000, 'Reconnected elsewhere');
        if (this.ctx.getWebSockets().length - existing.length >= 8) fail(409, 'This lobby is full.');
        const pair = new WebSocketPair();
        pair[1].serializeAttachment({ player, seen: Date.now(), window: Date.now(), count: 0 } satisfies Attachment);
        this.ctx.acceptWebSocket(pair[1]);
        return new Response(null, { status: 101, webSocket: pair[0], headers: { 'Sec-WebSocket-Protocol': request.headers.get('Sec-WebSocket-Protocol')! } });
      }
      if (url.pathname === '/current') {
        const lobby = this.parties.current(player);
        if (!lobby) fail(404, 'Your lobby has closed. Create or join a lobby.');
        return json({ lobby });
      }
      const payload = await request.json();
      const lobby = url.pathname === '/create'
        ? (() => { if (this.parties.exportState().length) fail(409, 'Lobby code collision. Try again.'); const data = createSchema.parse(payload); return this.parties.create(player, data.carId, data.settings, code); })()
        : (() => { const data = joinSchema.parse(payload); return this.parties.join(player, code, data.carId); })();
      await this.persist(); this.broadcast();
      return json({ lobby });
    } catch (cause) { const result = error(cause); return json({ error: result.error }, result.status); }
  }
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    let id: number | undefined;
    try {
      if (typeof message !== 'string' || new TextEncoder().encode(message).length > 2048) { ws.close(1009, 'Message too large'); return; }
      const saved = ws.deserializeAttachment() as Attachment;
      if (Date.now() - saved.window >= 1000) { saved.window = Date.now(); saved.count = 0; }
      if (++saved.count > 30) { ws.close(1008, 'Too many messages'); return; }
      ws.serializeAttachment(saved);
      const data = command.parse(JSON.parse(message)); id = data.id;
      const player = saved.player;
      let result: unknown, changed = true;
      if (data.path === '/current' && data.method === 'GET') { result = { lobby: this.parties.current(player) }; changed = false; }
      else if (data.path === '/me' && data.method === 'DELETE') { this.parties.leave(player); result = { lobby: null }; }
      else if (data.path === '/me' && data.method === 'PATCH') result = { lobby: this.parties.car(player, carSchema.parse(data.body).carId) };
      else if (data.path === '/settings' && data.method === 'PATCH') result = { lobby: this.parties.settings(player, settingsSchema.partial().parse(data.body)) };
      else if (data.path === '/start' && data.method === 'POST') result = { lobby: this.parties.start(player, {}) };
      else if (data.path === '/reopen' && data.method === 'POST') result = { lobby: this.parties.reopen(player) };
      else if (data.path === '/race' && data.method === 'POST') {
        const update = updateSchema.parse(data.body), before = this.parties.exportState()[0]?.revision;
        result = this.parties.update(player, update.raceId, update.ready, update.pose);
        saved.raceId = update.raceId;
        saved.pose = (result as ReturnType<Parties['update']>).race.racers.find(r => r.id === player.id)?.pose;
        changed = before !== this.parties.exportState()[0]?.revision;
      } else fail(400, 'Invalid multiplayer command.');
      saved.seen = Date.now(); ws.serializeAttachment(saved);
      if (changed) await this.persist();
      ws.send(JSON.stringify({ id, data: data.path === '/race' ? { ...(result as ReturnType<Parties['update']>), race: this.compact((result as ReturnType<Parties['update']>).race) } : result }));
      if (data.path !== '/current') this.broadcast(data.path === '/race' && !changed, data.path === '/race' && !changed ? ws : undefined);
      if (data.method === 'DELETE') ws.close(1000, 'Left lobby');
    } catch (cause) { ws.send(JSON.stringify({ id, ...error(cause) })); }
  }
  async webSocketClose(ws: WebSocket) {
    const state = this.parties.exportState();
    // A closed socket may be absent from getWebSockets() when hibernation wakes us.
    restoreAttachment(state, ws.deserializeAttachment() as Attachment); this.parties.restoreState(state);
    ws.close(1000, 'Disconnected');
    await this.persist();
    if (this.parties.exportState().length) await this.ctx.storage.setAlarm(Date.now() + 20_001);
  }
  async webSocketError(ws: WebSocket) { ws.close(1011, 'Connection failed'); await this.webSocketClose(ws); }
  async alarm() {
    this.parties.sweep();
    for (const ws of this.ctx.getWebSockets()) if (Date.now() - (ws.deserializeAttachment() as Attachment).seen > PARTY_PRESENCE_MS) ws.close(1000, 'Session inactive');
    await this.persist(); this.broadcast();
    if (this.parties.exportState().length) await this.ctx.storage.setAlarm(Date.now() + PARTY_PRESENCE_MS);
  }
}
