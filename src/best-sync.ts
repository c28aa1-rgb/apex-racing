import { CONE_TRACK, TRACKS, type Track } from '../shared/tracks';
import type { Run } from '../shared/replay';
import { hasLocalStartPlacement } from './dev-spawns';
import { api, bestRun, read, write, type Player } from './storage';

/**
 * Keeps the leaderboard in step with the personal bests saved on this device.
 * Every best on a published layout is posted once per player; a post that fails
 * (offline, server down, no nickname yet) is retried on the next sync. The
 * server keeps only each player's fastest time, so re-posting is harmless.
 */
const postedKey = (player: Player, run: Run) => `posted:${player.id}:${run.trackId}`;
const stamp = (run: Run) => `${run.trackVersion}:${run.physicsVersion}:${run.timeMs}`;

/** Records that this run reached the leaderboard, so the next sync skips it. */
export function markPosted(run: Run) {
  const player = read<Player | null>('player', null);
  if (player) write(postedKey(player, run), stamp(run));
}

let syncing: Promise<number> | undefined;
/** Posts every unposted personal best. Resolves with how many were posted. */
export function syncBests(): Promise<number> {
  if (syncing) return syncing;
  // Cleared once settled, so the next call (after a nickname is set, or the next finish) syncs again.
  const run = syncing = (async () => {
    const player = read<Player | null>('player', null);
    if (!player) return 0;
    let posted = 0;
    for (const track of [...TRACKS, CONE_TRACK] as Track[]) {
      if (track.kind === 'lot' || hasLocalStartPlacement(track)) continue;
      const best = bestRun(track);
      if (!best || read<string | null>(postedKey(player, best), null) === stamp(best)) continue;
      try { await api('/runs', best); markPosted(best); posted++; }
      catch { /* Offline or rejected: tried again on the next sync. */ }
    }
    return posted;
  })();
  void run.finally(() => { if (syncing === run) syncing = undefined; });
  return run;
}
