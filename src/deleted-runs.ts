import { trackById, formatTime } from '../shared/tracks';
import { carById } from '../shared/cars';
import { read, write } from './storage';

/**
 * Leaderboard runs removed by hand, so their drivers are told once why. Checkpoints count only when the middle
 * of the car crosses their painted line; these runs went round one, replayed under that rule (October 2026).
 */
const DELETED_RUNS = [
  { playerId: 'edd7e469-76a4-4102-bcbc-23e791930b3d', trackId: 'bugatti', carId: 'porsche-911-gt3', timeMs: 79550,
    reason: 'It passed 7.5 m to the side of checkpoint 4 instead of driving over it.' },
  { playerId: '920e1225-b6ca-48a3-8c70-cc5e20949793', trackId: 'bugatti', carId: 'porsche-911-gt3', timeMs: 94033,
    reason: 'It passed 10.1 m to the side of checkpoint 4 instead of driving over it.' },
  { playerId: '042b4027-7b26-4f45-b5ab-364ca841f8be', trackId: 'indianapolis', carId: 'porsche-911-gt3', timeMs: 82067,
    reason: 'It crossed checkpoint 5 just past the edge of its painted line, by about 10 cm.' },
];

export type DeletedRunNotice = { key: string; title: string; summary: string; reason: string };
const seenKey = (run: typeof DELETED_RUNS[number]) => `deleted-run-seen:${run.playerId}:${run.trackId}:${run.timeMs}`;

/**
 * Notices for this driver's removed runs that they have not dismissed yet. Each removed run is also cleared from
 * this device's personal best, so it is not shown as a best or posted to the leaderboard again.
 */
export function deletedRunNotices(playerId: string | undefined): DeletedRunNotice[] {
  if (!playerId) return [];
  return DELETED_RUNS.filter(run => run.playerId === playerId && !read(seenKey(run), false)).map(run => {
    const best = read<{ timeMs?: number } | null>(`best:${run.trackId}`, null);
    if (best?.timeMs === run.timeMs) { try { localStorage.removeItem(`apex:best:${run.trackId}`); } catch { /* storage blocked */ } }
    const track = trackById(run.trackId)?.name ?? run.trackId;
    return {
      key: seenKey(run),
      title: 'Leaderboard run removed',
      summary: `Your ${formatTime(run.timeMs)} on ${track} in the ${carById(run.carId).shortName} was removed from the leaderboard.`,
      reason: run.reason,
    };
  });
}
export const dismissDeletedRun = (notice: DeletedRunNotice) => write(notice.key, true);
