import { useCallback, useEffect, useRef, useState } from 'react';
import type { CarId } from '../shared/cars';
import type { PartyLobby, PartyResponse, PartySettings } from '../shared/party';
import type { Player } from './storage';

import { MULTIPLAYER_BACKEND, API_URL } from './multiplayer-config';
import { PartyError, requestCloudflareParty, partyEvents } from './cloudflare-party';
export async function requestParty<T = PartyResponse>(path: string, token: string, method = 'GET', body?: unknown): Promise<T> {
  if (MULTIPLAYER_BACKEND === 'cloudflare') return requestCloudflareParty<T>(path, token, method, body);
  const response = await fetch(`${API_URL}/api/parties${path}`, {
    method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(12000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new PartyError(data.error ?? 'Party service unavailable. Try again.', response.status);
  return data;
}

export function useParty(player: Player | null, active: boolean) {
  const [lobby, setLobby] = useState<PartyLobby | null>(null);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(true);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const visited = useRef(false), activeRef = useRef(active), generation = useRef(0), mutating = useRef(false);
  activeRef.current = active;
  if (active) visited.current = true;
  const enabled = visited.current;
  const accept = useCallback((next: PartyLobby | null) => {
    setLobby(previous => previous && next?.code === previous.code && next.revision < previous.revision ? previous : next);
  }, []);

  useEffect(() => {
    if (MULTIPLAYER_BACKEND !== 'cloudflare' || !player || !enabled) return;
    const receive = (event: Event) => {
      const next = (event as CustomEvent).detail.lobby as PartyLobby;
      if (next.members.some(member => member.id === player.id)) { accept(next); setConnected(true); }
    };
    partyEvents.addEventListener('lobby', receive);
    return () => partyEvents.removeEventListener('lobby', receive);
  }, [player?.id, enabled, accept]);

  useEffect(() => {
    if (!player || !enabled) { setLobby(null); setChecking(false); return; }
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    setChecking(true);
    const poll = async () => {
      const version = generation.current;
      try {
        if (!mutating.current) {
          const result = await requestParty('/current', player.token);
          if (!disposed && version === generation.current) { accept(result.lobby); setConnected(true); }
        }
      } catch (cause) {
        if (!disposed && version === generation.current) {
          setConnected(false);
          if (cause instanceof PartyError && cause.status === 401) {
            setLobby(null); setError('Your driver session expired. Save your nickname to reconnect.');
          }
        }
      } finally {
        if (!disposed) { setChecking(false); timer = setTimeout(poll, activeRef.current ? 2000 : 10000); }
      }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [player?.token, enabled, accept]);

  const mutate = async (path: string, method: string, body?: unknown, identity = player) => {
    if (mutating.current || !identity) return;
    mutating.current = true; generation.current++; setBusy(true); setError('');
    try {
      const result = await requestParty(path, identity.token, method, body);
      accept(result.lobby); setConnected(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update the lobby. Try again.');
      if (cause instanceof PartyError && cause.status === 404 && path !== '/join') setLobby(null);
    } finally { generation.current++; mutating.current = false; setBusy(false); }
  };
  return {
    lobby, error, connected, checking, busy, clearError: () => setError(''),
    create: (identity: Player, carId: CarId, settings: Partial<PartySettings>) => mutate('', 'POST', { carId, settings }, identity),
    join: (identity: Player, carId: CarId, code: string) => mutate('/join', 'POST', { carId, code }, identity),
    chooseCar: (carId: CarId) => mutate('/me', 'PATCH', { carId }),
    configure: (settings: Partial<PartySettings>) => mutate('/settings', 'PATCH', settings),
    start: () => mutate('/start', 'POST'),
    reopen: () => mutate('/reopen', 'POST'),
    leave: () => mutate('/me', 'DELETE'),
  };
}
