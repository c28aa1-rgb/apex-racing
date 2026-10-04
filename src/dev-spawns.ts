import { orientation, placementGate, type Track } from '../shared/tracks';
export { placementGate } from '../shared/tracks';
import type { CockpitOffset, StartPlacement } from './world';
import type { CarId } from '../shared/cars';

const STORAGE_KEY = 'apex:dev-start-placements:v1';
const FINISH_STORAGE_KEY = 'apex:dev-finish-placements:v1';
const ROAD_WIDTH_STORAGE_KEY = 'apex:dev-road-widths:v1';
const COCKPIT_OFFSET_STORAGE_KEY = 'apex:dev-cockpit-offsets:v1';
export type StartPlacements = Record<string, StartPlacement>;
export type FinishPlacements = Record<string, StartPlacement>;
export type RoadWidthOverrides = Record<string, Record<number, number>>;
export type CockpitOffsets = Partial<Record<CarId, CockpitOffset>>;
const defaultWidths = new Map<string, number[]>();
const defaultFinishes = new Map<string, Track['finish']>();
const defaultCheckpoints=new Map<string,Track['checkpoints']>();
const checkpointKey='apex:dev-checkpoints:v1';
export type CheckpointLayouts=Record<string,StartPlacement[]>;
export const loadCheckpoints=()=>load<CheckpointLayouts>(checkpointKey);
export const saveCheckpoints=(layouts:CheckpointLayouts)=>localStorage.setItem(checkpointKey,JSON.stringify(layouts));
export function applyCheckpoints(track:Track,placements?:StartPlacement[]){
  if(!defaultCheckpoints.has(track.id))defaultCheckpoints.set(track.id,structuredClone(track.checkpoints));
  track.checkpoints=placements?.length?placements.map(p=>placementGate(track,p)):structuredClone(defaultCheckpoints.get(track.id)!);
  track.localCheckpoints=!!placements?.length;
}

const load = <T>(key: string): T => {
  try { const value = JSON.parse(localStorage.getItem(key) ?? '{}'); return value && typeof value === 'object' ? value as T : {} as T; } catch { return {} as T; }
};

export function loadStartPlacements(): StartPlacements {
  return load<StartPlacements>(STORAGE_KEY);
}
export function saveStartPlacements(placements: StartPlacements) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(placements));
}
export function applyStartPlacement(track: Track, placement?: StartPlacement) {
  if (!placement) { delete track.spawn; return; }
  const forward = { x: Math.sin(placement.heading), y: 0, z: Math.cos(placement.heading) };
  track.spawn = { position: { ...placement.position }, forward, rotation: orientation(forward), width: track.start.width, segment: track.start.segment };
}
export function applySavedStartPlacements(tracks: Track[]) {
  const placements = loadStartPlacements();
  tracks.forEach(track => applyStartPlacement(track, placements[track.id]));
  return placements;
}
export function hasLocalStartPlacement(track: Track) { return !!(track.spawn||track.localCheckpoints||track.localFinish||track.localWidths); }

export function loadFinishPlacements(): FinishPlacements { return load<FinishPlacements>(FINISH_STORAGE_KEY); }
export function saveFinishPlacements(placements: FinishPlacements) { localStorage.setItem(FINISH_STORAGE_KEY, JSON.stringify(placements)); }
export function applyFinishPlacement(track: Track, placement?: StartPlacement) {
  track.localFinish=!!placement;
  const original = defaultFinishes.get(track.id) ?? structuredClone(track.finish);
  defaultFinishes.set(track.id, original);
  if (!placement) { track.finish = structuredClone(original); return; }
  const forward = { x: Math.sin(placement.heading), y: 0, z: Math.cos(placement.heading) };
  track.finish = placementGate(track,placement);
}
export function applySavedFinishPlacements(tracks: Track[]) {
  const placements = loadFinishPlacements(); tracks.forEach(track => applyFinishPlacement(track, placements[track.id])); return placements;
}

export function loadRoadWidthOverrides(): RoadWidthOverrides { return load<RoadWidthOverrides>(ROAD_WIDTH_STORAGE_KEY); }
export function saveRoadWidthOverrides(overrides: RoadWidthOverrides) { localStorage.setItem(ROAD_WIDTH_STORAGE_KEY, JSON.stringify(overrides)); }
export function applyRoadWidthOverrides(track: Track, overrides: Record<number, number> = {}) {
  track.localWidths=Object.keys(overrides).length>0;
  const defaults = defaultWidths.get(track.id) ?? track.segments.map(segment => segment.width);
  defaultWidths.set(track.id, defaults);
  track.segments.forEach((segment, index) => { segment.width = Math.max(3, Math.min(100, overrides[index] ?? defaults[index])); });
}
export function applySavedRoadWidthOverrides(tracks: Track[]) {
  const overrides = loadRoadWidthOverrides(); tracks.forEach(track => applyRoadWidthOverrides(track, overrides[track.id])); return overrides;
}

export function loadCockpitOffsets(): CockpitOffsets { return load<CockpitOffsets>(COCKPIT_OFFSET_STORAGE_KEY); }
export function saveCockpitOffsets(offsets: CockpitOffsets) { localStorage.setItem(COCKPIT_OFFSET_STORAGE_KEY, JSON.stringify(offsets)); }
