import type { Track, Quat } from '../shared/tracks';

export function minimapLayout(track:Track) {
  const points=track.mapPath?.length?track.mapPath:[track.segments[0].start,...track.segments.map(segment=>segment.end)];
  const bounds=[...points,track.finish.position],xs=bounds.map(p=>p.x),zs=bounds.map(p=>p.z);
  const minX=Math.min(...xs),maxX=Math.max(...xs),minZ=Math.min(...zs),maxZ=Math.max(...zs);
  const scale=124/Math.max(1,maxX-minX,maxZ-minZ);
  // Native +Z is down on the map, so the marker turns the same way as the physical car.
  const project=(p:{x:number;z:number})=>({x:85+(p.x-(minX+maxX)/2)*scale,y:85+(p.z-(minZ+maxZ)/2)*scale});
  return {line:points.map(p=>{const c=project(p);return `${c.x},${c.y}`;}).join(' '),project,finish:project(track.finish.position)};
}
export const minimapHeading=(q:Quat)=>Math.atan2(2*(q.x*q.z+q.w*q.y),-(1-2*(q.x*q.x+q.y*q.y)))*180/Math.PI;
