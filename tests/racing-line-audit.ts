// Racing-line gate. Drives one lap of each circuit's baked racing line (shared/racing-lines.ts) per car with the
// route driver (tests/smooth-route.ts), holding the line's own per-car target speeds (shared/racing-line.ts
// brakingEnvelope). If the colours promise a speed a car cannot carry, the driver runs wide, leaves the road or
// meets a wall here.
//
//   node --max-old-space-size=4096 --import tsx tests/racing-line-audit.ts [--track=id[,id]] [--cars=id,...]
//
// Per lap: time, whether every checkpoint and the finish were taken over their paint, wall contacts (chassis impulses against steep faces), share of ticks with two or more wheels
// off the asphalt, widest the car ran from the line, recoveries. Exit code 1 when a lap is not completed, a gate is
// missed, or any wall contact or recovery happens.
import { DT, Simulation, initPhysics } from '../shared/physics';
import { TRACKS, formatTime } from '../shared/tracks';
import { CARS, carById } from '../shared/cars';
import { RACING_LINES } from '../shared/racing-lines';
import { brakingEnvelope, racingLine } from '../shared/racing-line';
import { DEFAULT_CARS, RouteDriver, type Route } from './smooth-route';

const arg = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const tracks = TRACKS.filter(track => (arg('track')?.split(',') ?? Object.keys(RACING_LINES)).includes(track.id));
const carIds = arg('cars')?.split(',') ?? DEFAULT_CARS;
for (const id of carIds) if (!CARS.some(car => car.id === id)) throw new Error(`Unknown car ${id}`);

await initPhysics(tracks);
let failed = false;
console.log('track         car               lap        gold       walls  off-road  widest  recoveries');
for (const track of tracks) {
  const mpu = track.metersPerUnit, line = racingLine(RACING_LINES[track.id], mpu);
  const points = Array.from({ length: line.n }, (_, i) => ({ x: line.x[i], y: line.y[i], z: line.z[i] }));
  const s = [0];
  for (let i = 1; i < line.n; i++) s.push(s[i - 1] + line.ds[i - 1] / mpu);
  const route: Route = { trackId: track.id, source: 'trace', closed: true, mpu, points, s, length: line.length / mpu, halfWidth: points.map(() => 4 / mpu) };
  for (const carId of carIds) {
    const car = carById(carId), sim = new Simulation(track, car.id), driver = new RouteDriver(route, Array.from(brakingEnvelope(line, car)));
    sim.maxTicks = Infinity;
    driver.start(sim);
    const limit = Math.ceil((line.length / 15 + 60) / DT);
    let ticks = 0, walls = 0, offRoad = 0, widest = 0, wallTick = -100, lapTicks = 0, finished = false, after = 0;
    const where: string[] = [];
    // The lap is timed from the first tick at speed, so the standing start counts once like a real lap.
    // Past the line's own lap, keep going (up to 30 s) until the car takes the finish: every checkpoint in order,
    // then the finish, each crossed over its paint.
    for (; ticks < limit && !(driver.done && (finished || after > 1800)); ticks++) {
      sim.step(driver.input(sim));
      if (sim.finished) { finished = true; sim.finished = false; sim.checkpoint = 0; }
      if (driver.done) after++; else lapTicks++;
      if (sim.offRoad) offRoad++;
      widest = Math.max(widest, Math.abs(driver.lateral) * mpu);
      const chassis = sim.car.collider(0);
      let hit = false;
      sim.world.contactPairsWith(chassis, other => {
        if (other.parent()?.handle === sim.car.handle) return;
        sim.world.contactPair(chassis, other, manifold => {
          let impulse = 0; for (let i = 0; i < manifold.numContacts(); i++) impulse += manifold.contactImpulse(i);
          if (impulse / sim.car.mass() * mpu > .05 && Math.abs(manifold.normal().y) < .6) hit = true;
        });
      });
      // One contact episode per wall touch, not one per tick.
      if (hit) {
        if (ticks - wallTick > 30) { walls++; const p = sim.car.translation(); where.push(`${p.x.toFixed(0)},${p.z.toFixed(0)} at ${(sim.speed * mpu * 2.23694).toFixed(0)} mph`); }
        wallTick = ticks;
      }
    }
    sim.world.free();
    const ok = driver.done && finished && !walls && !driver.recoveries;
    failed ||= !ok;
    console.log(`${track.id.padEnd(13)} ${car.id.padEnd(17)} ${(driver.done ? formatTime(lapTicks * DT * 1000) : 'DNF').padEnd(10)} ${formatTime(track.medals[0]).padEnd(10)} ` +
      `${String(walls).padStart(5)}  ${(offRoad / ticks * 100).toFixed(1).padStart(7)}%  ${widest.toFixed(1).padStart(5)} m  ${String(driver.recoveries).padStart(10)}${finished ? '' : '   gates missed'}${ok ? '' : '   FAIL'}`);
    if (where.length && process.argv.includes('--where')) console.log(`    walls at ${where.slice(0, 8).join('; ')}`);
  }
}
process.exit(failed ? 1 : 0);
