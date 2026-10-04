import { memo } from 'react';
import type { Track } from '../shared/tracks';

/** Training Grounds map: the car park from above, same axes as the circuit minimap (x right, z down). */
export function LotMap({ track, car }: { track: Track; car?: { x: number; z: number } }) {
  const lot = track.lot!, scale = 150 / (lot.half * 2), at = (x: number, z: number) => ({ x: 10 + (x + lot.half) * scale, y: 10 + (z + lot.half) * scale });
  const c = car && at(car.x, car.z);
  return <svg className="minimap lot-map" viewBox="0 0 170 170" role="img" aria-label={`${track.name} map`}>
    <LotBase track={track} />
    {c && <circle cx={c.x} cy={c.y} r="5" fill="#ff784c" stroke="#fff" strokeWidth="2" />}
  </svg>;
}
const LotBase = memo(function LotBase({ track }: { track: Track }) {
  const lot = track.lot!, scale = 150 / (lot.half * 2), at = (x: number, z: number) => ({ x: 10 + (x + lot.half) * scale, y: 10 + (z + lot.half) * scale });
  const pad = at(lot.pad.x, lot.pad.z), zone = at(lot.startZone.x, lot.startZone.z);
  const route = track.kind === 'cones' ? [track.segments[0].start, ...track.segments.map(s => s.end)].map(p => at(p.x, p.z)) : [];
  return <>
    <rect x="10" y="10" width="150" height="150" rx="2" fill="rgba(19,43,59,.55)" stroke="rgba(168,218,220,.45)" strokeWidth="1.5" />
    {lot.boxes.filter(b => b.kind === 'parked' || b.kind === 'container' || b.kind === 'kiosk').map((b, i) => { const p = at(b.x, b.z); return <rect key={i} x={p.x - b.w * scale / 2} y={p.y - b.l * scale / 2} width={b.w * scale} height={b.l * scale} fill="rgba(241,250,238,.22)" />; })}
    <circle cx={pad.x} cy={pad.y} r={lot.pad.radius * scale} fill="none" stroke="rgba(241,250,238,.5)" strokeWidth="1.2" />
    {route.length > 0 && <polyline points={route.map(p => `${p.x},${p.y}`).join(' ')} fill="none" stroke="#ff6a13" strokeWidth="2.5" strokeLinejoin="round" opacity=".9" />}
    {track.kind !== 'cones' && lot.cones.filter(cone => cone.free).map((cone, i) => { const p = at(cone.x, cone.z); return <circle key={i} cx={p.x} cy={p.y} r=".9" fill="#ff6a13" opacity=".7" />; })}
    <rect className="lot-map-zone" x={zone.x - 3.5} y={zone.y - 3} width="7" height="6" fill="none" stroke="#ff6a13" strokeWidth="1.6" />
  </>;
});
