import { CARS, type CarId } from '../shared/cars';
import { medalFor, type Track } from '../shared/tracks';
import { read, write } from './storage';

export type Career = { xp: number; finishes: number; medals: Record<string, number> };
export const UNLOCK_XP: Record<CarId, number> = {
  'porsche-911-gt3': 0, 'celica-gt4': 0, 'skyline-r34': 0, 'nascar-camry': 0,
  'ferrari-488-gt3': 0, 'mclaren-720s-gt3': 0, 'mazda-787b': 0,
  'peugeot-9x8': 0, 'porsche-963': 0, 'bugatti-bolide': 0, 'red-bull-rb19': 0,
};
export const unlocked = (career: Career, id: CarId) => career.xp >= UNLOCK_XP[id];
export function loadCareer(): Career {
  const value=read<Career>('career:v1',{xp:0,finishes:0,medals:{}});
  const medals=Object.fromEntries(Object.entries(value.medals&&typeof value.medals==='object'?value.medals:{}).filter(([,medal])=>Number.isInteger(medal)&&medal>=0&&medal<=3));
  return {xp:Number.isFinite(value.xp)?Math.max(0,value.xp):0,finishes:Number.isFinite(value.finishes)?Math.max(0,value.finishes):0,medals};
}
export function awardFinish(career:Career,track:Track,time:number,manual=false) {
  const medal=['Finished','Bronze','Silver','Gold'].indexOf(medalFor(track,time));
  const previous=career.medals[track.id]??-1;
  const breakdown={finish:100,firstCircuit:previous<0?100:0,medal:Math.max(0,medal-Math.max(0,previous))*50,manual:manual?100:0};
  const earned=Object.values(breakdown).reduce((a,b)=>a+b,0);
  const next={xp:career.xp+earned,finishes:career.finishes+1,medals:{...career.medals,[track.id]:Math.max(previous,medal)}};
  return {career:next,earned,breakdown,newCars:CARS.filter(c=>!unlocked(career,c.id)&&unlocked(next,c.id)).map(c=>c.id)};
}
export const saveCareer=(career:Career)=>write('career:v1',career);
