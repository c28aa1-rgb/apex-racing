import { memo, useEffect, useState } from 'react';
import { Moon, Sun, Sunrise, Sunset } from 'lucide-react';
import { assetUrl } from '../shared/assets';
import { CITY_RACES, type Track } from '../shared/tracks';
import { SUNRISE, SUNSET, clockLabel } from './city-time';

type CityTime = { hour: number; cycle: boolean };
/** Quick times: the sun just up, high noon, the sun going down behind the city, and the city at night. */
const PRESETS = [{ name: 'Dawn', hour: 6.75, icon: Sunrise }, { name: 'Noon', hour: 13, icon: Sun }, { name: 'Sunset', hour: 19.6, icon: Sunset }, { name: 'Night', hour: 22, icon: Moon }];
/**
 * The city's time of day: a 24-hour slider (its track coloured like the sky through the day), quick times, and the
 * switch that lets the clock run. While the slider is held the map fades away so the city shows its new light.
 */
function TimeOfDay({ time, onChange, onPreview }: { time: CityTime; onChange: (patch: Partial<CityTime>) => void; onPreview: (on: boolean) => void }) {
  const up = time.hour >= SUNRISE && time.hour < SUNSET, Icon = up ? Sun : Moon;
  return <section className="city-time" aria-label="Time of day" onClick={event => event.stopPropagation()}>
    <div className="city-time-clock"><Icon size={18} aria-hidden="true" /><span>Time of day</span><strong aria-live="polite">{clockLabel(time.hour)}</strong></div>
    <input className="city-time-slider" type="range" min={0} max={24} step={1 / 12} value={time.hour} aria-label="Time of day" aria-valuetext={clockLabel(time.hour)}
      onChange={event => onChange({ hour: Number(event.target.value) % 24 })}
      onPointerDown={() => onPreview(true)} onPointerUp={() => onPreview(false)} onPointerCancel={() => onPreview(false)} onBlur={() => onPreview(false)} />
    <div className="city-time-presets">{PRESETS.map(({ name, hour, icon: PresetIcon }) =>
      <button key={name} type="button" onClick={() => onChange({ hour })} aria-pressed={Math.abs(time.hour - hour) < .01}><PresetIcon size={15} aria-hidden="true" />{name}</button>)}</div>
    <label className="city-time-cycle"><input type="checkbox" checked={time.cycle} onChange={event => onChange({ cycle: event.target.checked })} /><span aria-hidden="true" />Clock runs<small>a day in 24 min</small></label>
  </section>;
}

type CityRoads = { roads: { name: string; district: string; width: number; closed: boolean; points: [number, number][] }[]; buildings: [number, number][][] };
/** Metres shown across the map: the city is ~3 km wide, so the map follows the car instead of fitting it all. */
const SPAN = 700;
let roads: Promise<CityRoads> | undefined;
const loadRoads = () => roads ??= fetch(assetUrl('models/tracks/racing-city.map.json')).then(response => {
  if (!response.ok) throw new Error(`City map failed: ${response.status}`);
  return response.json() as Promise<CityRoads>;
});

/** A street race on the map: its route, and the next gate to drive through. */
function RaceRoute({ race, next, width }: { race: Track; next?: { x: number; z: number }; width: number }) {
  const points = race.street!.route.map(p => `${p[0]},${p[2]}`).join(' '), common = { fill: 'none', strokeLinejoin: 'round' as const, strokeLinecap: 'round' as const };
  return <>
    {race.street!.closed ? <polygon points={points} {...common} stroke={race.accent} strokeWidth={width} strokeOpacity=".9" /> : <polyline points={points} {...common} stroke={race.accent} strokeWidth={width} strokeOpacity=".9" />}
    {next && <circle cx={next.x} cy={next.z} r={width * 1.6} fill="#fff" stroke={race.accent} strokeWidth={width * .6} />}
  </>;
}
type Marker = { x: number; z: number; name: string; index: number };
const COLOURS = ['#61e7e0', '#ffd166', '#c792ea', '#7bd88f', '#ff6b9a', '#82aaff', '#f78c6c'];
/** The other drivers in a party: a dot each in their colour, named on the whole-city map. */
function Drivers({ others, size, labels = false }: { others: Marker[]; size: number; labels?: boolean }) {
  return <>{others.map(other => <g key={other.name + other.index} transform={`translate(${other.x} ${other.z})`}><title>{other.name}</title>
    <circle r={size} fill={COLOURS[other.index % COLOURS.length]} stroke="#070d1a" strokeWidth={size * .45} />
    {labels && <text y={-size * 1.7} className="city-full-map-driver" fill={COLOURS[other.index % COLOURS.length]}>{other.name}</text>}
  </g>)}</>;
}
/** Free roam: where each street race starts. */
function RaceStarts({ size, labels = false }: { size: number; labels?: boolean }) {
  return <>{CITY_RACES.map(race => { const zone = race.street!.zone; return <g key={race.id} transform={`translate(${zone.x} ${zone.z})`}>
    <circle r={size} fill="#ff7a1a" stroke="#fff" strokeWidth={size * .3} /><path d={`M${-size * .35} ${size * .45} V${-size * .5} L${size * .5} ${-size * .2} L${-size * .35} ${size * .1}`} fill="#fff" />
    {labels && <text y={-size * 1.6} className="city-full-map-race">{race.name}</text>}
  </g>; })}</>;
}
/** City map: road centerlines from the export, north-up (x right, z down) like the other minimaps, centred on the car. */
export function CityMap({ car, race, next, others = [] }: { car?: { x: number; z: number }; race?: Track; next?: { x: number; z: number }; others?: Marker[] }) {
  const [data, setData] = useState<CityRoads>();
  useEffect(() => { let live = true; loadRoads().then(value => { if (live) setData(value); }, error => console.warn(error)); return () => { live = false; }; }, []);
  const x = car?.x ?? 0, z = car?.z ?? 0, scale = 150 / SPAN;
  return <svg className="minimap lot-map" viewBox="0 0 170 170" role="img" aria-label="City map">
    <defs><clipPath id="city-map-clip"><rect x="10" y="10" width="150" height="150" rx="2" /></clipPath></defs>
    <rect x="10" y="10" width="150" height="150" rx="2" fill="rgba(19,43,59,.55)" stroke="rgba(168,218,220,.45)" strokeWidth="1.5" />
    <g clipPath="url(#city-map-clip)"><g transform={`translate(85 85) scale(${scale}) translate(${-x} ${-z})`}>{data && <><Blocks data={data} /><Roads data={data} /></>}{race ? <RaceRoute race={race} next={next} width={9} /> : <RaceStarts size={14} />}<Drivers others={others} size={16} /></g></g>
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
export function CityFullMap({ car, heading, onClose, race, next, others = [], time, onTime }: { car: { x: number; z: number }; heading: number; onClose: () => void; race?: Track; next?: { x: number; z: number }; others?: Marker[];
  time?: CityTime; onTime?: (patch: Partial<CityTime>) => void }) {
  const [data, setData] = useState<CityRoads>(), [previewing, setPreviewing] = useState(false);
  useEffect(() => { let live = true; loadRoads().then(value => { if (live) setData(value); }, error => console.warn(error)); return () => { live = false; }; }, []);
  if (!data) return <div className="city-full-map" role="dialog" aria-label="City map"><p className="city-full-map-loading">Loading map…</p></div>;
  const xs = data.roads.flatMap(road => road.points.map(p => p[0])), zs = data.roads.flatMap(road => road.points.map(p => p[1]));
  const pad = 60, minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad, minZ = Math.min(...zs) - pad, maxZ = Math.max(...zs) + pad;
  const degrees = heading * 180 / Math.PI;
  return <div className={`city-full-map${previewing ? ' is-previewing' : ''}`} role="dialog" aria-label="City map" onClick={onClose}>
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
      {race ? <RaceRoute race={race} next={next} width={12} /> : <RaceStarts size={26} labels />}
      <Drivers others={others} size={22} labels />
      {/* The arrow points along the car's heading: +z is down the map, so a heading of 0 points down. */}
      <g transform={`translate(${car.x} ${car.z}) rotate(${-degrees})`}>
        <circle r="56" fill="#ff784c2e" /><path d="M0 40 L26 -24 L0 -8 L-26 -24 Z" fill="#ff784c" stroke="#fff" strokeWidth="6" strokeLinejoin="round" />
      </g>
    </svg>
    {time && onTime && <TimeOfDay time={time} onChange={onTime} onPreview={setPreviewing} />}
    <p className="city-full-map-hint">{race ? `${race.name} · ` : 'Racing City · orange flags start street races · '}<kbd>M</kbd> or <kbd>Esc</kbd> to close</p>
  </div>;
}
