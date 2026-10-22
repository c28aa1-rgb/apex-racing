import { memo, useEffect, useState } from 'react';
import { assetUrl } from '../shared/assets';

type CityRoads = { roads: { name: string; width: number; closed: boolean; points: [number, number][] }[] };
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
    <g clipPath="url(#city-map-clip)"><g transform={`translate(85 85) scale(${scale}) translate(${-x} ${-z})`}>{data && <Roads data={data} />}</g></g>
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
