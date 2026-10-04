import type { PartyLobby, PartyResponse } from '../shared/party';
import { multiplayerUrl } from './multiplayer-config';

export class PartyError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export const partyEvents = new EventTarget();
let socket: WebSocket | undefined, socketToken = '', opening: Promise<void> | undefined, serial = 0, epoch = 0;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
const roomKey = 'apex:cloudflare-room';
const savedRoom = () => { try { return sessionStorage.getItem(roomKey); } catch { return null; } };
const saveRoom = (code: string | null) => { try { if (code) sessionStorage.setItem(roomKey, code); else sessionStorage.removeItem(roomKey); } catch { /* Storage can be disabled. */ } };
let room: string | null = savedRoom();
let lobby: PartyLobby | null = null;
function mergeRace(race: NonNullable<PartyLobby['race']>) {
  if (lobby?.race?.id === race.id) { lobby = { ...lobby, race: { ...lobby.race, ...race } }; return lobby.race; }
  return race;
}
function stop() {
  epoch++;
  const old = socket; socket = undefined; opening = undefined;
  old?.close(1000, 'Session changed');
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new PartyError('Race connection interrupted.', 503)); }
  pending.clear();
}
async function connect(token: string) {
  if (socketToken !== token) { stop(); socketToken = token; }
  if (socket?.readyState === WebSocket.OPEN) return;
  if (opening) return opening;
  if (!room) throw new PartyError('Your lobby has closed.', 404);
  const connectionEpoch = epoch;
  opening = (async () => {
    const response = await fetch(multiplayerUrl(`/api/rooms/${room}/current`), { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(12000) });
    const result = await response.json();
    if (connectionEpoch !== epoch) throw new PartyError('Session changed. Try again.', 503);
    if (!response.ok) {
      if (response.status === 404) { room = null; saveRoom(null); }
      throw new PartyError(result.error ?? 'Party service unavailable.', response.status);
    }
    lobby = result.lobby;
    const url = multiplayerUrl(`/api/rooms/${room}/socket`); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = socket = new WebSocket(url, `apex.${token}`);
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new PartyError('Party service unavailable. Try again.', 503)); }, 12000);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new PartyError('Party service unavailable. Try again.', 503)); };
      ws.onclose = () => { clearTimeout(timer); if (socket === ws) stop(); reject(new PartyError('Race connection interrupted.', 503)); };
      ws.onmessage = event => {
        const packet = JSON.parse(event.data);
        if (packet.type === 'race') { packet.race = mergeRace(packet.race); partyEvents.dispatchEvent(new CustomEvent('race', { detail: packet })); return; }
        if (packet.type === 'lobby') { lobby = packet.lobby; partyEvents.dispatchEvent(new CustomEvent('lobby', { detail: packet })); return; }
        const item = pending.get(packet.id); if (!item) return;
        pending.delete(packet.id); clearTimeout(item.timer);
        if (packet.error) item.reject(new PartyError(packet.error, packet.status)); else {
          if (packet.data.race) packet.data.race = mergeRace(packet.data.race);
          if ('lobby' in packet.data) lobby = packet.data.lobby;
          item.resolve(packet.data);
        }
      };
    });
  })().finally(() => { if (connectionEpoch === epoch) opening = undefined; });
  return opening;
}
export async function requestCloudflareParty<T = PartyResponse>(path: string, token: string, method = 'GET', body?: unknown): Promise<T> {
  if (path === '' || path === '/join') {
    if (room) throw new PartyError('Leave your current lobby before joining another.', 409);
    const response = await fetch(multiplayerUrl(`/api/parties${path}`), { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(12000) });
    const result = await response.json();
    if (!response.ok) throw new PartyError(result.error ?? 'Party service unavailable.', response.status);
    lobby = result.lobby; room = (result.lobby as PartyLobby).code; saveRoom(room);
    // Membership exists even if the initial socket fails; polling can reconnect.
    try { await connect(token); } catch { /* The lobby remains recoverable. */ }
    return result;
  }
  if (!room && path === '/current') return { lobby: null } as T;
  try { await connect(token); } catch (cause) {
    if (path === '/current' && cause instanceof PartyError && cause.status === 404) return { lobby: null } as T;
    throw cause;
  }
  const id = ++serial;
  const result = await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new PartyError('Race update timed out.', 503)); }, 12000);
    pending.set(id, { resolve: value => resolve(value as T), reject, timer });
    socket!.send(JSON.stringify({ id, path, method, ...(body === undefined ? {} : { body }) }));
  });
  if (path === '/me' && method === 'DELETE' || path === '/current' && !(result as PartyResponse).lobby) { room = null; saveRoom(null); stop(); }
  return result;
}
