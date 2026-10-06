import { CAR_IDS, CARS, type CarId } from '../shared/cars';
import { medalFor, type Track } from '../shared/tracks';
import { read, write } from './storage';

/** xp is the spendable REP balance; owned lists cars bought with it. */
export type Career = { xp: number; finishes: number; medals: Record<string, number>; owned: CarId[] };
/** REP price of each car. Price 0 cars are starters every player owns. */
export const UNLOCK_XP: Record<CarId, number> = {
  'porsche-911-gt3': 0, 'celica-gt4': 0, 'skyline-r34': 0, 'nascar-camry': 300,
  'ferrari-488-gt3': 500, 'mclaren-720s-gt3': 600, 'mazda-787b': 900,
  'porsche-963': 1300, 'peugeot-9x8': 1500, 'bugatti-bolide': 2200, 'red-bull-rb19': 3000,
};
/** Each car's livery colour drives its unlock burst, stripe and glow. */
export const CAR_ACCENT: Record<CarId, string> = {
  'red-bull-rb19': '#ff2b45', 'nascar-camry': '#ffcf2e', 'ferrari-488-gt3': '#ff3a1f', 'mclaren-720s-gt3': '#ff8a1c',
  'bugatti-bolide': '#3d8bff', 'peugeot-9x8': '#c8ff3a', 'celica-gt4': '#ff4a4a', 'porsche-911-gt3': '#ffd84a',
  'porsche-963': '#f2f2f2', 'mazda-787b': '#2fe08a', 'skyline-r34': '#4aa8ff',
};
export const unlocked = (career: Career, id: CarId) => UNLOCK_XP[id] === 0 || career.owned.includes(id);
export const affordable = (career: Career, id: CarId) => !unlocked(career, id) && career.xp >= UNLOCK_XP[id];
/** All REP ever earned: the current balance plus what was spent on cars. */
export const lifetimeRep = (career: Career) => career.xp + career.owned.reduce((sum, id) => sum + UNLOCK_XP[id], 0);
/** Lifetime REP at which a driver without a name is nudged to choose one. */
export const NAME_NUDGE_REP = 200;
export function loadCareer(): Career {
  const value=read<Partial<Career>>('career:v1',{xp:0,finishes:0,medals:{},owned:[]});
  const medals=Object.fromEntries(Object.entries(value.medals&&typeof value.medals==='object'?value.medals:{}).filter(([,medal])=>Number.isInteger(medal)&&medal>=0&&medal<=3));
  const owned=Array.isArray(value.owned)?CAR_IDS.filter(id=>value.owned!.includes(id)):[];
  return {xp:Number.isFinite(value.xp)?Math.max(0,value.xp!):0,finishes:Number.isFinite(value.finishes)?Math.max(0,value.finishes!):0,medals,owned};
}
/** Spends REP on a car. Returns undefined when the car is already owned or too expensive. */
export function buyCar(career:Career,id:CarId):Career|undefined {
  if(!affordable(career,id))return undefined;
  return {...career,xp:career.xp-UNLOCK_XP[id],owned:[...career.owned,id]};
}
export function awardFinish(career:Career,track:Track,time:number,manual=false) {
  const medal=['Finished','Bronze','Silver','Gold'].indexOf(medalFor(track,time));
  const previous=career.medals[track.id]??-1;
  const breakdown={finish:100,firstCircuit:previous<0?100:0,medal:Math.max(0,medal-Math.max(0,previous))*50,manual:manual?100:0};
  const earned=Object.values(breakdown).reduce((a,b)=>a+b,0);
  const next={...career,xp:career.xp+earned,finishes:career.finishes+1,medals:{...career.medals,[track.id]:Math.max(previous,medal)}};
  // Cars this finish made affordable; buying them is the player's choice in the garage.
  return {career:next,earned,breakdown,newCars:CARS.filter(c=>!affordable(career,c.id)&&affordable(next,c.id)).map(c=>c.id)};
}
export const saveCareer=(career:Career)=>write('career:v1',career);
