import { memo, useEffect, useState } from 'react';
import { assetUrl } from '../shared/assets';

type CityRoads = { roads: { name: string; district: string; width: number; closed: boolean; points: [number, number][] }[]; buildings: [number, number][][] };
/** Metres shown across the map: the city is ~3 km wide, so the map follows the car instead of fitting it all. */
const SPAN = 700;
let roads: Promise<CityRoads> | undefined;
const loadRoads = () => roads ??= fetch(assetUrl('models/tracks/racing-city.map.json')).then(response => {
  if (!response.ok) throw new Error(`City map failed: ${response.status}`);
  return response.json() as Promise<CityRoads>;
});

/** City map: road centerlines from the export, north-up (x right, z down) like the other minimaps, centred on the car. */
export function CityMap({ car }: { car?: { x: number; z: number } }) {
  const [data, setData] = useState<CityRoads>();
  useEffect(() => { let live = true; loadRoads().then(value => { if (live) setData(value); }, error => console.warn(error)); return () => { live = false; }; }, []);
  const x = car?.x ?? 0, z = car?.z ?? 0, scale = 150 / SPAN;
  return <svg className="minimap lot-map" viewBox="0 0 170 170" role="img" aria-label="City map">
    <defs><clipPath id="city-map-clip"><rect x="10" y="10" width="150" height="150" rx="2" /></clipPath></defs>
    <rect x="10" y="10" width="150" height="150" rx="2" fill="rgba(19,43,59,.55)" stroke="rgba(168,218,220,.45)" strokeWidth="1.5" />
    <g clipPath="url(#city-map-clip)"><g transform={`translate(85 85) scale(${scale}) translate(${-x} ${-z})`}>{data && <><Blocks data={data} /><Roads data={data} /></>}</g></g>
    {car && <circle cx="85" cy="85" r="5" fill="#ff784c" stroke="#fff" strokeWidth="2" />}
  </svg>;
}
const Roads = memo(function Roads({ data }: { data: CityRoads }) {
  return <>{data.roads.map(road => {
    const points = road.points.map(([px, pz]) => `${px},${pz}`).join(' ');
    return road.closed
      ? <polygon key={road.name} points={points} fill="none" stroke="#a8dadc" strokeOpacity=".75" strokeWidth={road.width} strokeLinejoin="round" />
      : <polyline key={road.name} points={points} fill="none" stroke="#a8dadc" strokeOpacity=".75" strokeWidth={road.width} strokeLinejoin="round" strokeLinecap="round" />;
  })}</>;
});
const Blocks = memo(function Blocks({ data }: { data: CityRoads }) {
  return <>{data.buildings.map((outline, i) => <polygon key={i} points={outline.map(([px, pz]) => `${px},${pz}`).join(' ')} fill="rgba(241,250,238,.24)" />)}</>;
});
/**
 * District labels: on the district's own road nearest the middle of its roads. A ring road's middle lies inside the
 * ring, often on top of another district, so the label is pulled back onto the district's road.
 */
function districts(data: CityRoads) {
  const points = new Map<string, [number, number][]>();
  for (const road of data.roads) points.set(road.district, [...(points.get(road.district) ?? []), ...road.points]);
  return [...points].map(([name, list]) => {
    const cx = list.reduce((sum, p) => sum + p[0], 0) / list.length, cz = list.reduce((sum, p) => sum + p[1], 0) / list.length;
    const [x, z] = list.reduce((best, p) => Math.hypot(p[0] - cx, p[1] - cz) < Math.hypot(best[0] - cx, best[1] - cz) ? p : best);
    return { name, x, z: z - 34 };
  });
}

/** Whole-city map (M): every road and block, district names, and where the car is and which way it faces. */
export function CityFullMap({ car, heading, onClose }: { car: { x: number; z: number }; heading: number; onClose: () => void }) {
  const [data, setData] = useState<CityRoads>();
  useEffect(() => { let live = true; loadRoads().then(value => { if (live) setData(value); }, error => console.warn(error)); return () => { live = false; }; }, []);
  if (!data) return <div className="city-full-map" role="dialog" aria-label="City map"><p className="city-full-map-loading">Loading map…</p></div>;
  const xs = data.roads.flatMap(road => road.points.map(p => p[0])), zs = data.roads.flatMap(road => road.points.map(p => p[1]));
  const pad = 60, minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad, minZ = Math.min(...zs) - pad, maxZ = Math.max(...zs) + pad;
  const degrees = heading * 180 / Math.PI;
  return <div className="city-full-map" role="dialog" aria-label="City map" onClick={onClose}>
    <svg viewBox={`${minX} ${minZ} ${maxX - minX} ${maxZ - minZ}`} preserveAspectRatio="xMidYMid meet" onClick={event => event.stopPropagation()}>
      <Blocks data={data} />
      {data.roads.map(road => {
        const points = road.points.map(([px, pz]) => `${px},${pz}`).join(' ');
        const common = { fill: 'none', strokeLinejoin: 'round' as const, strokeLinecap: 'round' as const };
        return <g key={road.name}>
          {road.closed ? <polygon points={points} {...common} stroke="#0c1a24" strokeWidth={road.width + 8} /> : <polyline points={points} {...common} stroke="#0c1a24" strokeWidth={road.width + 8} />}
          {road.closed ? <polygon points={points} {...common} stroke="#a8dadc" strokeWidth={road.width} /> : <polyline points={points} {...common} stroke="#a8dadc" strokeWidth={road.width} />}
        </g>;
      })}
      {districts(data).map(label => <text key={label.name} x={label.x} y={label.z} className="city-full-map-district">{label.name}</text>)}
      {/* The arrow points along the car's heading: +z is down the map, so a heading of 0 points down. */}
      <g transform={`translate(${car.x} ${car.z}) rotate(${-degrees})`}>
        <circle r="56" fill="#ff784c2e" /><path d="M0 40 L26 -24 L0 -8 L-26 -24 Z" fill="#ff784c" stroke="#fff" strokeWidth="6" strokeLinejoin="round" />
      </g>
    </svg>
    <p className="city-full-map-hint">Racing City · <kbd>M</kbd> or <kbd>Esc</kbd> to close</p>
  </div>;
}
