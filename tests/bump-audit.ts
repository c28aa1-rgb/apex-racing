// Ride-smoothness audit. Drives each circuit's saved racing line with a simple
// pure-pursuit driver and measures how much the chassis is shaken by the
// surface (not by steering or hills):
//   rough   RMS of pitch+roll rate, deg/s (body rattle)
//   bump    RMS of high-passed vertical acceleration, m/s^2 (road texture felt)
//   jolt    mean suspension travel change per tick, mm
//   skin    share of ticks with all four tyres on the smooth support surface
// Run with the API up (saved layouts): node --import tsx tests/bump-audit.ts [--track=spa] [--seconds=40]
import { DT, Input, Simulation, initPhysics, rotate } from '../shared/physics';
import { driveTrack } from './driver';
import { TRACKS, type Track, type Vec3 } from '../shared/tracks';
import { applyFinishPlacement, applyRoadWidthOverrides, applyStartPlacement } from '../src/dev-spawns';

const only = process.argv.find(a => a.startsWith('--track='))?.slice(8);
const seconds = Number(process.argv.find(a => a.startsWith('--seconds='))?.slice(10) ?? 40);
await initPhysics();
if (process.argv.includes('--saved')) try {
  const config = await (await fetch('http://127.0.0.1:3001/api/dev-circuit-config')).json();
  for (const track of TRACKS) { applyStartPlacement(track, config.starts?.[track.id]); applyFinishPlacement(track, config.finishes?.[track.id]); applyRoadWidthOverrides(track, config.roads?.[track.id]); track.mapPath = config.maps?.[track.id] ?? track.mapPath; }
} catch { console.warn('API not reachable: auditing built-in layouts'); }

export type BumpResult = { track: string; rough: number; bump: number; jolt: number; skin: number; mph: number; airborne: number };
export const traces: Record<string, number[][]> = {};
export async function audit(trackId: string, ticks = seconds * 60): Promise<BumpResult> {
  const trace: number[][] = traces[trackId] = [];
  const track = TRACKS.find(t => t.id === trackId)!;
  await initPhysics(track);
  let roughSum = 0, bumpSum = 0, joltSum = 0, skin = 0, speedSum = 0, air = 0, n = 0, ema = 0, lastVy = 0, i = 0;
  const mpu = track.metersPerUnit;
  const sample = (sim: Simulation) => {
    if (++i < 180 || i > ticks + 180) return; // ignore the launch
    const w = sim.car.angvel(), q2 = sim.car.rotation(), right = rotate(q2, { x: 1, y: 0, z: 0 }), front = rotate(q2, { x: 0, y: 0, z: 1 });
    const pitch = w.x * right.x + w.y * right.y + w.z * right.z, roll = w.x * front.x + w.y * front.y + w.z * front.z;
    roughSum += (pitch * pitch + roll * roll) * (180 / Math.PI) ** 2;
    const vy = sim.car.linvel().y * mpu, ay = (vy - lastVy) / DT; lastVy = vy;
    ema += (ay - ema) * (1 - Math.exp(-DT / .3)); bumpSum += (ay - ema) ** 2;
    joltSum += sim.suspensionJolt * 1000;
    if ([0, 1, 2, 3].every(k => sim.wheelUsesSmoothSupport(k))) skin++;
    if (!sim.grounded) air++;
    speedSum += sim.speed * mpu; n++;
    trace.push([i, sim.car.translation().y * mpu, vy, ay, pitch, roll, sim.suspensionJolt * 1000, sim.speed * mpu]);
  };
  if (track.mapPath?.length) {
    // Saved drive trace: pure pursuit around it at road speeds.
    const route = track.mapPath, L = route.length, at = (k: number) => route[((k % L) + L) % L], sim = new Simulation(track);
    // Start on the line itself, already rolling (the saved grid can face a pit wall).
    let target = Math.floor(L * .1);
    { const a = route[target], b = route[target + 1], heading = Math.atan2(b.x - a.x, b.z - a.z), ground = sim.roadHeightAt({ ...a, y: a.y + 2 }) ?? a.y;
      sim.car.setTranslation({ x: a.x, y: ground + 1.0, z: a.z }, true); sim.car.setRotation({ x: 0, y: Math.sin(heading / 2), z: 0, w: Math.cos(heading / 2) }, true);
      sim.car.setLinvel({ x: Math.sin(heading) * 15 / mpu, y: 0, z: Math.cos(heading) * 15 / mpu }, true); }
    try {
      for (let t = 0; t < ticks + 180; t++) {
        const p = sim.car.translation(), forward = rotate(sim.car.rotation(), { x: 0, y: 0, z: 1 });
        let best = Infinity, next = target; for (let k = target; k < target + 40; k++) { const d = Math.hypot(at(k).x - p.x, at(k).z - p.z); if (d < best) { best = d; next = k; } } target = next % L;
        const look = Math.max(10, sim.speed * mpu * .9) / mpu; let aim = target; while (aim < target + L && Math.hypot(at(aim).x - p.x, at(aim).z - p.z) < look) aim++;
        let error = Math.atan2(at(aim).x - p.x, at(aim).z - p.z) - Math.atan2(forward.x, forward.z); while (error > Math.PI) error -= Math.PI * 2; while (error < -Math.PI) error += Math.PI * 2;
        const targetSpeed = (Math.abs(error) > .25 ? 16 : Math.abs(error) > .1 ? 26 : 36) / mpu;
        let input = sim.speed < targetSpeed ? Input.Throttle : sim.speed > targetSpeed * 1.12 ? Input.Brake : 0;
        if (error > .03) input |= Input.Left; else if (error < -.03) input |= Input.Right;
        sim.step(input); sample(sim);
      }
    } finally { sim.dispose(); }
  } else {
    // No saved trace: the shared lap driver (follows the authored course, recovers from walls).
    driveTrack(track, undefined, undefined, sample);
  }
  return { track: trackId, rough: Math.sqrt(roughSum / n), bump: Math.sqrt(bumpSum / n), jolt: joltSum / n, skin: skin / n, mph: speedSum / n * 2.23694, airborne: air / n };
}
if (process.argv[1]?.endsWith("bump-audit.ts")) {
  const rows: BumpResult[] = [];
  for (const track of TRACKS.filter(t => !only || t.id === only)) { const r = await audit(track.id); rows.push(r); console.log(`${r.track.padEnd(13)} rough ${r.rough.toFixed(2).padStart(6)} deg/s  bump ${r.bump.toFixed(2).padStart(6)} m/s2  jolt ${r.jolt.toFixed(2).padStart(5)} mm  skin ${(r.skin * 100).toFixed(0).padStart(3)}%  air ${(r.airborne * 100).toFixed(1)}%  ${r.mph.toFixed(0)} mph`); }
  const mean = (k: keyof BumpResult) => rows.reduce((s, r) => s + (r[k] as number), 0) / rows.length;
  console.log(`MEAN          rough ${mean('rough').toFixed(2)}  bump ${mean('bump').toFixed(2)}  jolt ${mean('jolt').toFixed(2)}  skin ${(mean('skin') * 100).toFixed(0)}%`);
}
