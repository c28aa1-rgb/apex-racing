import { medalFor, type Track } from '../shared/tracks';
import { read, write } from './storage';

/** Finished races and the best medal per circuit, saved in this browser. Every car is open to every driver. */
export type Career = { finishes: number; medals: Record<string, number> };
/** Finished races after which a driver without a nickname is nudged to choose one. */
export const NAME_NUDGE_FINISHES = 2;
export function loadCareer(): Career {
  // career:v1 also held a REP balance and bought cars from before every car was open; only these fields are kept.
  const value = read<Partial<Career>>('career:v1', { finishes: 0, medals: {} });
  const medals = Object.fromEntries(Object.entries(value.medals && typeof value.medals === 'object' ? value.medals : {}).filter(([, medal]) => Number.isInteger(medal) && medal >= 0 && medal <= 3));
  return { finishes: Number.isFinite(value.finishes) ? Math.max(0, value.finishes!) : 0, medals };
}
export function recordFinish(career: Career, track: Track, time: number): Career {
  const medal = ['Finished', 'Bronze', 'Silver', 'Gold'].indexOf(medalFor(track, time));
  return { finishes: career.finishes + 1, medals: { ...career.medals, [track.id]: Math.max(career.medals[track.id] ?? -1, medal) } };
}
export const saveCareer = (career: Career) => write('career:v1', career);
