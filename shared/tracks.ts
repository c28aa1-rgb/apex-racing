import { CONE_COURSE, CONE_GATES, TRAINING_LOT, type LotLayout } from './lot';
import { BARCELONA_ROUTE, BUGATTI_ROUTE, DAYTONA_ROUTE, HUNGARORING_ROUTE, INDIANAPOLIS_LAYOUT, INDIANAPOLIS_ROUTE, MARINA_ROUTE, SPA_ROUTE } from './track-routes';

export type Vec3 = { x: number; y: number; z: number };
export type Quat = Vec3 & { w: number };
export type Surface = 'road' | 'boost';
export type Segment = { id: string; next: string | null; start: Vec3; end: Vec3; width: number; surface: Surface; rails: boolean };
export type Gate = { position: Vec3; forward: Vec3; rotation: Quat; width: number; segment: number };
export type Track = {
  id: string; version: number; name: string; subtitle: string; difficulty: string;
  description: string; accent: string; medals: [number, number, number];
  model?: string; runtimeModel?: string; collision?: string; segments: Segment[]; checkpoints: Gate[]; start: Gate; spawn?: Gate; finish: Gate;
  /** Real metres represented by one native model unit. */
  metersPerUnit: number; length: number;
  /** Optional smoothed developer drive trace used by UI maps and circuit cards. */
  mapPath?: Vec3[];
  localCheckpoints?:boolean;localFinish?:boolean;localWidths?:boolean;
  /** 'lot' is untimed free roam; 'cones' is the timed course inside the same lot. Circuits omit it. */
  kind?: 'lot' | 'cones';
  /** Flat, walled car park built from shared layout data instead of a venue model. */
  lot?: LotLayout;
  /** Kept out of menus, party and the public track list; still accepted by the leaderboard. */
  hidden?: boolean;
};
const round = (n: number) => Math.round(n * 1e6) / 1e6 || 0;
export const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
export function direction(a: Vec3, b: Vec3): Vec3 {
  const d = v(b.x - a.x, b.y - a.y, b.z - a.z);
  const l = Math.hypot(d.x, d.y, d.z);
  return v(round(d.x / l), round(d.y / l), round(d.z / l));
}
// Rounded initial transforms are shared by rendering and simulation.
export function orientation(forward: Vec3): Quat {
  const yaw = Math.atan2(forward.x, forward.z), pitch = -Math.asin(forward.y);
  const sy = Math.sin(yaw / 2), cy = Math.cos(yaw / 2), sx = Math.sin(pitch / 2), cx = Math.cos(pitch / 2);
  return { x: round(cy * sx), y: round(sy * cx), z: round(-sy * sx), w: round(cy * cx) };
}
export function gateOn(segment: Segment, index: number, t: number): Gate {
  const a = segment.start, b = segment.end;
  const forward = direction(a, b);
  return { position: v(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t), forward,
    rotation: orientation(forward), width: segment.width, segment: index };
}
/** A local editor may override only the vehicle spawn without changing lap gates. */
export const spawnGate = (track: Track): Gate => track.spawn ?? track.start;
export function placementGate(track: Track, placement: { position: Vec3; heading: number }): Gate {
  let segment=0,distance=Infinity;
  track.segments.forEach((s,i)=>{const dx=s.end.x-s.start.x,dz=s.end.z-s.start.z,t=Math.max(0,Math.min(1,((placement.position.x-s.start.x)*dx+(placement.position.z-s.start.z)*dz)/(dx*dx+dz*dz||1))),d=Math.hypot(placement.position.x-s.start.x-t*dx,placement.position.z-s.start.z-t*dz);if(d<distance){distance=d;segment=i;}});
  const forward={x:Math.sin(placement.heading),y:0,z:Math.cos(placement.heading)};
  return {position:{...placement.position},forward,rotation:orientation(forward),segment,width:track.segments[segment].width};
}
/** Replaces the generated start, finish and timing gates with recorded placements. */
function withLayout(track: Track, layout: { start: { position: Vec3; heading: number }; finish: { position: Vec3; heading: number }; checkpoints: { position: Vec3; heading: number }[] }): Track {
  return { ...track, start: placementGate(track, layout.start), finish: placementGate(track, layout.finish), checkpoints: layout.checkpoints.map(p => placementGate(track, p)) };
}
function course(id: string, name: string, subtitle: string, difficulty: string, description: string,
  accent: string, model: string, points: number[][], checkpoints: number[], boosts: number[], medals: [number, number, number],
  officialLength: number, width = 18): Track {
  const segments = points.slice(0, -1).map((p, i) => ({ id: `${id}-${i}`, next: i < points.length - 2 ? `${id}-${i + 1}` : null,
    start: v(...p as [number, number, number]), end: v(...points[i + 1] as [number, number, number]),
    width, surface: boosts.includes(i) ? 'boost' as const : 'road' as const, rails: true }));
  const nativeLength = segments.reduce((sum, s) => sum + Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y, s.end.z - s.start.z), 0);
  return { id, version: 7, name, subtitle, difficulty, description, accent, model, runtimeModel:model.replace('.glb','.clean.glb'), collision: `collision/${model.replace(/\.glb$/,'')}.bin`, medals, segments,
    checkpoints: checkpoints.map(i => gateOn(segments[i], i, 0.6)),
    start: gateOn(segments[0], 0, 0.1), finish: gateOn(segments.at(-1)!, segments.length - 1, 0.83),
    metersPerUnit: officialLength / nativeLength, length: officialLength };
}
export const TRACKS: Track[] = [
  course('bugatti','Bugatti Circuit','Le Mans, France','Intermediate','The complete supplied Bugatti layout, with its real elevation, pit straight, permanent kerbs and circuit furniture.','#ff784c','bugatti.glb',BUGATTI_ROUTE,[6,13,20,27],[],[85000,105000,130000],4185,16),
  course('spa','Spa-Francorchamps','Ardennes, Belgium','Expert','A full lap of Spa on the supplied 2022 venue: long straights, major elevation change and fast committed corners.','#59d8d0','spa.glb',SPA_ROUTE,[10,20,30,40,50],[],[120000,145000,175000],7004,16),
  course('hungaroring','Hungaroring','Mogyoród, Hungary','Technical','A full 2020-layout lap where rhythm and mechanical grip matter more than a huge top speed.','#f5c56b','hungaroring.glb',HUNGARORING_ROUTE,[9,18,27,36,45],[],[92000,115000,142000],4381,15),
  course('barcelona','Barcelona-Catalunya','Montmeló, Spain','Technical','The supplied 2023 Grand Prix layout, including the restored fast final sector and long pit straight.','#5ca9ff','barcelona.glb',BARCELONA_ROUTE,[11,22,33,44,55],[],[94000,116000,142000],4657,15),
  { ...withLayout(course('indianapolis','Indianapolis Road Course','Speedway, USA','Technical','The infield road course through the supplied Indianapolis Motor Speedway venue: the pit straight, tight infield complexes and the run back past the grandstands.','#ffd45c','indianapolis.glb',INDIANAPOLIS_ROUTE,[],[],[85000,105000,130000],3925,14),INDIANAPOLIS_LAYOUT), version: 9 },
  { ...course('daytona','Daytona International Speedway','Daytona Beach, USA','High speed','The supplied 2007 superspeedway layout: flat-out straights, steep banking and the signature tri-oval run to the line.','#4fc3ff','daytona.glb',DAYTONA_ROUTE,[5,11,17,23],[],[70000,88000,110000],4023,22), version: 9 },
  course('marina-bay','Marina Bay','Singapore','Street','A full night-city street circuit traced through the supplied venue roads, walls and bridge sections.','#de79ff','marina-bay.glb',MARINA_ROUTE,[10,20,30,40,50],[],[112000,140000,172000],5063,14)
];
const placed = (x: number, z: number, heading: number, width: number, segment = 0): Gate => {
  const forward = v(round(Math.sin(heading)), 0, round(Math.cos(heading)));
  return { position: v(x, 0, z), forward, rotation: orientation(forward), width, segment };
};
function lotSegments(id: string, points: [number, number][], width: number): Segment[] {
  return points.slice(0, -1).map((p, i) => ({ id: `${id}-${i}`, next: i < points.length - 2 ? `${id}-${i + 1}` : null,
    start: v(p[0], 0, p[1]), end: v(points[i + 1][0], 0, points[i + 1][1]), width, surface: 'road' as const, rails: false }));
}
const lot = TRAINING_LOT, cone = CONE_COURSE;
/** Free roam. No gates are ever scored here; the finish exists only to satisfy the Track shape. */
export const TRAINING_GROUNDS: Track = {
  id: 'training', version: 1, name: 'Training Grounds', subtitle: 'Open car park', difficulty: 'Free roam',
  description: 'A flat, walled car park for drifting, donuts and getting to know a car. No clock, no limits. Every car is welcome.',
  accent: '#f2b33d', medals: [0, 0, 0], kind: 'lot', lot,
  segments: lotSegments('training', [[lot.spawn.x, lot.spawn.z], [lot.spawn.x, 100]], 60), checkpoints: [],
  start: placed(lot.spawn.x, lot.spawn.z, 0, 20), finish: placed(lot.spawn.x, 100, 0, 20),
  metersPerUnit: 1, length: 1000,
};
/** The hidden time attack. Started only by driving into its box inside the Training Grounds. */
export const CONE_TRACK: Track = {
  id: 'cones', version: 3, name: 'Cone Attack', subtitle: 'Training Grounds', difficulty: 'Secret',
  description: 'A lap of the whole lot: two slaloms, a hairpin and seven narrow cone gates. Every cone you touch, and every time you leave the course, costs a second.',
  accent: '#ff7a1a', medals: [62000, 72000, 86000], kind: 'cones', lot, hidden: true,
  segments: lotSegments('cones', [[cone.laneA, -112], [cone.laneA, 62], [76, 80], [cone.divider, 85], [89, 80], [cone.laneB, 62], [cone.laneB, -100], [88, -104], [50, -104], [-50, -104], [-55, -98], [-55, 95], [-50, 101], [25, 101], [cone.finish.x, 95], [cone.finish.x, cone.finish.z], [cone.finish.x, -40]], 20),
  checkpoints: [
    placed(cone.laneA, -5, 0, 22), placed(cone.divider, 71.5, Math.PI / 2, 29),
    ...CONE_GATES.slice(0, 3).map(g => placed(g.x, g.z, g.heading, 5)),
    placed(50, -104, -Math.PI / 2, 12), ...CONE_GATES.slice(3, 5).map(g => placed(g.x, g.z, g.heading, 5)),
    placed(-55, -20, 0, 22), ...CONE_GATES.slice(5).map(g => placed(g.x, g.z, g.heading, 5)),
  ],
  start: placed(lot.startZone.x, lot.startZone.z, 0, lot.startZone.w), finish: placed(cone.finish.x, cone.finish.z, Math.PI, 20),
  metersPerUnit: 1, length: 900,
};
/** Every track the simulation and leaderboard accept, including hidden ones. */
export const ALL_TRACKS: Track[] = [...TRACKS, TRAINING_GROUNDS, CONE_TRACK];
export const trackById = (id: string) => ALL_TRACKS.find(t => t.id === id);
export const ranked = (track: Track) => track.kind !== 'lot';
export function medalFor(track: Track, ms: number): string {
  return ms <= track.medals[0] ? 'Gold' : ms <= track.medals[1] ? 'Silver' : ms <= track.medals[2] ? 'Bronze' : 'Finished';
}
export function formatTime(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  const n = Math.max(0, Math.round(ms));
  return `${Math.floor(n / 60000).toString().padStart(2, '0')}:${Math.floor(n / 1000 % 60).toString().padStart(2, '0')}.${(n % 1000).toString().padStart(3, '0')}`;
}
