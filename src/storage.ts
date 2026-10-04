import { MULTIPLAYER_BACKEND, API_URL, multiplayerUrl } from './multiplayer-config';
import { PHYSICS_VERSION } from '../shared/physics';
import { runSchema, type Run } from '../shared/replay';
import type { Track } from '../shared/tracks';
import { hasLocalStartPlacement } from './dev-spawns';
export type Player = { id: string; token: string; nickname: string };
export type Entry = { id: string; playerId: string; nickname: string; carId: string; timeMs: number; rank: number; manual?:boolean|null; verified?:boolean };
export function read<T>(key: string, fallback: T): T { try { return JSON.parse(localStorage.getItem(`apex:${key === 'player' && MULTIPLAYER_BACKEND === 'cloudflare' ? 'player:cloudflare' : key}`) ?? 'null') ?? fallback; } catch { return fallback; } }
export function write(key:string,value:unknown) { try { localStorage.setItem(`apex:${key === 'player' && MULTIPLAYER_BACKEND === 'cloudflare' ? 'player:cloudflare' : key}`,JSON.stringify(value));return true; }catch{return false;} }
/**
 * Personal bests and their ghosts belong to one layout: start, checkpoints,
 * finish, road widths and driven route. A run on a different layout would
 * not line up, so each custom layout keeps its own best on this device.
 */
export function layoutKey(track:Track) {
  if(!hasLocalStartPlacement(track))return '';
  const text=JSON.stringify([track.spawn??null,track.checkpoints,track.finish,track.segments.map(segment=>segment.width),track.mapPath??null]);
  let hash=0x811c9dc5;for(let index=0;index<text.length;index++){hash^=text.charCodeAt(index);hash=Math.imul(hash,0x01000193);}
  return (hash>>>0).toString(36);
}
const bestKey=(track:Track)=>{const layout=layoutKey(track);return layout?`best:${track.id}:${layout}`:`best:${track.id}`;};
export const saveBestRun=(track:Track,run:Run)=>write(bestKey(track),run);
export function bestRun(track:Track):Run|undefined {
  const result=runSchema.safeParse(read(bestKey(track),null));
  if(!result.success||result.data.trackVersion!==track.version||result.data.physicsVersion!==PHYSICS_VERSION)return undefined;
  return result.data;
}
export async function api<T>(path:string,body?:unknown,method?:string):Promise<T> {
  const player=read<Player|null>('player',null);
  const response=await fetch(MULTIPLAYER_BACKEND === 'cloudflare' && /^\/(players|runs|leaderboards|replays)(\/|$)/.test(path) ? multiplayerUrl(`/api${path}`) : `${API_URL}/api${path}`,{method:method??(body?'POST':'GET'),headers:{'Content-Type':'application/json',...(player?{Authorization:`Bearer ${player.token}`}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(25000)});
  const data=await response.json();if(!response.ok)throw new Error(data.error??'Leaderboard unavailable. Try again.');return data;
}
