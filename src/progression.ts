import { read, write } from './storage';

/** Finished races, saved in this browser. Legacy medals are preserved but no longer awarded. */
export type Career = { finishes: number; medals: Record<string, number> };
/** Finished races after which a driver without a nickname is nudged to choose one. */
export const NAME_NUDGE_FINISHES = 2;
export function loadCareer(): Career {
  // career:v1 also held a REP balance and bought cars from before every car was open; only these fields are kept.
  const value = read<Partial<Career>>('career:v1', { finishes: 0, medals: {} });
  const medals = Object.fromEntries(Object.entries(value.medals && typeof value.medals === 'object' ? value.medals : {}).filter(([, medal]) => Number.isInteger(medal) && medal >= 0 && medal <= 3));
  return { finishes: Number.isFinite(value.finishes) ? Math.max(0, value.finishes!) : 0, medals };
}
export const recordFinish = (career: Career): Career => ({ ...career, finishes: career.finishes + 1 });
export const saveCareer = (career: Career) => write('career:v1', career);
