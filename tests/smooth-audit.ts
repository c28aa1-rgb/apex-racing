// Smooth-track gate (physics side). Drives a full lap of each circuit (the whole saved drive trace once, or
// one loop of the authored route) per car with a racing driver (tests/smooth-route.ts) and checks that the
// surface the car physically rides is the surface the player sees, with no invisible walls or kicks.
//
//   node --max-old-space-size=4096 --import tsx tests/smooth-audit.ts [--track=id[,id]] [--cars=id,...]
//        [--seconds=N] [--out=work/smooth-audit/<name>.json] [--saved=work/smooth-audit/circuit-config.json|api|none]
//        [--centerlines=work/smooth-audit|none]   (derived <id>-centerline.json for circuits without a drive trace)
//
// Per tick (all lengths in metres = world units * track.metersPerUnit):
//   phantomWalls   chassis contact manifolds with impulse whose normal is non-upright (|n.y| < 0.6), or upright
//                  ones that sharply decelerate the car, on the drivable lane with no real barrier (steep face
//                  rising > 0.5 m above the road the wheels ride) within 1.5 m. Barrier / off-lane contacts are
//                  driver-caused and reported apart (driverWallContacts, with ticks within 1.5 m of the route line
//                  = the route itself runs into a wall); driverStuckAt lists where the driver had to recover.
//   stalls         one-tick speed loss > 3% above 5 m/s with no brake (losses while the car is in a real-barrier
//                  crash or off the lane are driverCrashStall, not counted); pitch/roll-rate spikes > 2 rad/s;
//                  respawns; airborne share; rough/bump/jolt exactly as tests/bump-audit.ts.
//   floorGap       per grounded wheel: physical wheel bottom (hard point + (suspension + radius) along the
//                  suspension, at its raycast) minus the visible floor under it (+ = floating, - = sunk). No visible
//                  floor within 1.15 m below a grounded tyre counts as outside the band and beyond +-5 cm.
//   chassisClearance  lowest of 15 points on the chassis cuboid's bottom face above the visible floor.
// Exit code 1 when any target is violated (or the driver did not complete the lap / reach speed).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DT, Input, PHYSICS_VERSION, Simulation, initPhysics, rotate } from '../shared/physics';
import { TRACKS, type Track, type Vec3 } from '../shared/tracks';
import { CARS, carById } from '../shared/cars';
import { applyCheckpoints, applyFinishPlacement, applyRoadWidthOverrides, applyStartPlacement } from '../src/dev-spawns';
import { DEFAULT_CARS, MPH, RouteDriver, VENUE_TRACKS, buildRoute, chassisBottom, heightAbove, parseCenterline, percentile, realBarrier, speedProfile, visibleFloor, wheelBottoms, type Route } from './smooth-route';

const arg = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const trackIds = arg('track')?.split(',').filter(Boolean) ?? VENUE_TRACKS;
const carIds = arg('cars')?.split(',').filter(Boolean) ?? DEFAULT_CARS;
const secondsLimit = arg('seconds') !== undefined ? Number(arg('seconds')) : undefined;
const outPath = arg('out') ?? 'work/smooth-audit/smooth-audit.json';
const savedSource = arg('saved') ?? 'work/smooth-audit/circuit-config.json';
// Derived asphalt centrelines (<dir>/<id>-centerline.json) for circuits without a saved drive trace; 'none' = authored segments.
const centerlineDir = arg('centerlines') ?? 'work/smooth-audit';
const centerlineFile = (id: string) => centerlineDir === 'none' ? undefined : [`${centerlineDir}/${id}-centerline.json`].find(f => existsSync(f));
for (const id of trackIds) if (!TRACKS.some(t => t.id === id)) throw new Error(`Unknown track ${id}`);
for (const id of carIds) if (!CARS.some(c => c.id === id)) throw new Error(`Unknown car ${id}`);

export const TARGETS = {
  phantomWalls: 0, stalls: 0, respawns: 0, spikes: 0,
  floorGapBandCm: [-1, 3] as const, floorGapInBandShare: .99, floorGapHardCm: 5, floorGapHardMaxS: .25,
  chassisClearanceMinCm: 0,
  stallLoss: .03, stallMinSpeed: 5, spikeRate: 2, daytonaBankMph: 150,
};

type Config = { starts?: Record<string, never>; finishes?: Record<string, never>; roads?: Record<string, Record<number, number>>; maps?: Record<string, Vec3[]>; checkpoints?: Record<string, never[]> };
async function loadSaved(): Promise<string> {
  if (savedSource === 'none') return 'built-in';
  const config: Config = savedSource === 'api' ? await (await fetch('http://127.0.0.1:3001/api/dev-circuit-config')).json() : JSON.parse(readFileSync(savedSource, 'utf8'));
  // Same application as src/main.ts boot (starts, finishes, road widths, drive traces, checkpoint gates).
  for (const track of TRACKS) {
    applyStartPlacement(track, config.starts?.[track.id]); applyFinishPlacement(track, config.finishes?.[track.id]);
    applyRoadWidthOverrides(track, config.roads?.[track.id]); track.mapPath = config.maps?.[track.id];
    if (config.checkpoints) applyCheckpoints(track, config.checkpoints[track.id]);
  }
  return savedSource;
}

export type Offender = { track: string; car: string; tick: number; x: number; y: number; z: number; distanceM: number; lateralM: number; metric: string; value: number; unit: string; severity: number; speedMph: number; durationTicks: number; detail?: Record<string, unknown> };

/** Groups consecutive ticks of one metric (gaps up to 3 ticks) into an episode and keeps its worst tick. */
class Episodes {
  list: Offender[] = []; private open = new Map<string, { last: number; worst: Offender; first: number }>();
  add(key: string, tick: number, event: Offender) {
    const current = this.open.get(key);
    if (current && tick - current.last <= 3) { current.last = tick; if (event.severity > current.worst.severity) current.worst = event; current.worst.durationTicks = tick - current.first + 1; return; }
    if (current) this.flush(key);
    this.open.set(key, { last: tick, worst: { ...event, durationTicks: 1 }, first: tick });
  }
  flush(key?: string) {
    for (const [k, v] of this.open) if (key === undefined || k === key) { this.list.push(v.worst); this.open.delete(k); }
  }
  count(metric: string) { return this.list.filter(e => e.metric === metric).length; }
}

const round = (n: number, d = 2) => Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : n;

/**
 * Top `limit` offenders sorted by severity, with every metric represented: each metric first gets an equal
 * share of the slots (its own worst episodes), the rest go to the globally worst. Otherwise thousands of
 * floor-gap episodes would hide the few stalls, chassis or phantom-wall episodes from the list.
 */
export function worst(list: Offender[], limit: number): Offender[] {
  const bySeverity = (a: Offender, b: Offender) => b.severity - a.severity || a.tick - b.tick;
  const groups = new Map<string, Offender[]>();
  for (const o of list) { const g = groups.get(o.metric) ?? []; g.push(o); groups.set(o.metric, g); }
  const share = Math.max(1, Math.floor(limit / Math.max(1, groups.size))), chosen = new Set<Offender>();
  for (const g of groups.values()) g.sort(bySeverity).slice(0, share).forEach(o => chosen.add(o));
  for (const o of [...list].sort(bySeverity)) { if (chosen.size >= limit) break; chosen.add(o); }
  return [...chosen].sort(bySeverity).slice(0, limit);
}

function auditRun(track: Track, carId: string) {
  const mpu = track.metersPerUnit, car = carById(carId), sim = new Simulation(track, car.id);
  sim.maxTicks = Infinity;
  try {
    const file = track.mapPath?.length ? undefined : centerlineFile(track.id), centerline = file ? parseCenterline(JSON.parse(readFileSync(file, 'utf8'))) : undefined;
    const route: Route = buildRoute(track, centerline), profile = speedProfile(route, car.id), driver = new RouteDriver(route, profile);
    const start = driver.start(sim);
    const lapM = driver.lapLength * mpu;
    const limit = secondsLimit !== undefined ? Math.round(secondsLimit / DT) : Math.ceil((lapM / 18 + 120) / DT);
    const episodes = new Episodes(), mass = sim.car.mass();
    const gaps: number[] = [], clearances: number[] = [];
    let ticks = 0, laneTicks = 0, air = 0, skin = 0, skinKnown = typeof (sim as unknown as { wheelUsesSmoothSupport?: unknown }).wheelUsesSmoothSupport === 'function';
    let roughSum = 0, bumpSum = 0, joltSum = 0, ema = 0, lastVy = sim.car.linvel().y * mpu, speedSum = 0, maxMph = 0, maxBankMph = 0;
    let wheelTicks = 0, inBand = 0, noFloor = 0, chassisMin = Infinity, chassisNegTicks = 0;
    let offRoadOnLineTicks = 0, crashStallTicks = 0, floorContactTicks = 0, driverWallTicks = 0, offLaneContactTicks = 0, phantomTicks = 0, stallTicks = 0, spikeTicks = 0, maxSpike = 0, maxStall = 0, maxPhantomDv = 0;
    let respawns = 0, lastRespawns = sim.respawns, settleUntil = 0, lapFinished = false, recoverTicks = 0, lastRecoveries = 0, wallOnLineTicks = 0;
    const stuckAt: { tick: number; x: number; y: number; z: number; distanceM: number; lateralM: number }[] = [];
    let lastBarrier: { tick: number; x: number; z: number } | undefined;
    const sustained = [0, 0, 0, 0], sustainedEpisodes: number[] = [];
    let sustainedTicks = 0;
    const closeSustained = (i: number) => { if (sustained[i] > 0) { sustainedEpisodes.push(sustained[i]); if (sustained[i] * DT > TARGETS.floorGapHardMaxS) sustainedTicks += sustained[i]; } sustained[i] = 0; };
    let floorCheck = 0, floorMismatch = 0;
    const visibleGroundAt = (sim as unknown as { visibleGroundAt?: (p: Vec3) => number | undefined }).visibleGroundAt?.bind(sim);

    for (let tick = 0; tick < limit && !driver.done; tick++) {
      const before = { speed: sim.speed * mpu, q: { ...sim.car.rotation() } };
      const input = driver.input(sim);
      sim.step(input);
      if (sim.finished) { sim.finished = false; sim.checkpoint = 0; lapFinished = true; } // keep driving past the line
      ticks++;
      const p = sim.car.translation(), q = sim.car.rotation(), v = sim.car.linvel(), w = sim.car.angvel();
      const right = rotate(q, { x: 1, y: 0, z: 0 }), front = rotate(q, { x: 0, y: 0, z: 1 });
      const speed = sim.speed * mpu, onLane = Math.abs(driver.lateral) <= driver.halfWidth;
      const base = { track: track.id, car: car.id, tick, x: round(p.x), y: round(p.y), z: round(p.z), distanceM: round(driver.progress * mpu, 1), lateralM: round(driver.lateral * mpu), speedMph: round(speed * MPH, 1), durationTicks: 1 };
      if (driver.recovering) recoverTicks++;
      if (driver.recoveries !== lastRecoveries) {
        lastRecoveries = driver.recoveries;
        if (stuckAt.length < 20) stuckAt.push({ tick, x: round(p.x), y: round(p.y), z: round(p.z), distanceM: round(driver.progress * mpu, 1), lateralM: round(driver.lateral * mpu) });
        episodes.add('stuck', tick, { ...base, metric: 'driverStuck', value: driver.recoveries, unit: 'recoveries', severity: 5 });
      }
      if (sim.respawns !== lastRespawns) {
        respawns += sim.respawns - lastRespawns; lastRespawns = sim.respawns; settleUntil = tick + 30; driver.locate(sim.car.translation(), true);
        episodes.add('respawn', tick, { ...base, metric: 'respawn', value: sim.respawns, unit: 'count', severity: 50 });
      }
      const settling = tick < settleUntil;
      if (onLane) laneTicks++;
      // The car on a non-road surface (grass/gravel per the collision mesh) while it is on the route line: the
      // drive trace / centreline crosses run-off, or asphalt is classified as run-off. Not a smoothness target.
      if (!settling && sim.offRoad && Math.abs(driver.lateral) * mpu < 2) {
        offRoadOnLineTicks++;
        episodes.add('offRoadLine', tick, { ...base, metric: 'offRoadOnRouteLine', value: Math.max(...sim.wheelSurface), unit: 'max wheel surface (1 grass, 2 gravel)', severity: .5, detail: { wheelSurface: [...sim.wheelSurface] } });
      }
      // Ride metrics, identical to tests/bump-audit.ts.
      const pitch = w.x * right.x + w.y * right.y + w.z * right.z, roll = w.x * front.x + w.y * front.y + w.z * front.z;
      roughSum += (pitch * pitch + roll * roll) * (180 / Math.PI) ** 2;
      const vy = v.y * mpu, ay = (vy - lastVy) / DT; lastVy = vy;
      ema += (ay - ema) * (1 - Math.exp(-DT / .3)); bumpSum += (ay - ema) ** 2;
      joltSum += sim.suspensionJolt * 1000;
      if (skinKnown && [0, 1, 2, 3].every(k => (sim as unknown as { wheelUsesSmoothSupport: (i: number) => boolean }).wheelUsesSmoothSupport(k))) skin++;
      if (!sim.grounded) air++;
      speedSum += speed; maxMph = Math.max(maxMph, speed * MPH);
      const normals = [0, 1, 2, 3].filter(i => sim.vehicle.wheelIsInContact(i)).map(i => sim.vehicle.wheelContactNormal(i)).filter((n): n is NonNullable<typeof n> => !!n);
      if (normals.length >= 3 && normals.reduce((s, n) => s + n.y, 0) / normals.length < Math.cos(15 * Math.PI / 180)) maxBankMph = Math.max(maxBankMph, speed * MPH);

      // Stalls: sudden speed loss without the brake.
      const braking = !!(input & Input.Brake) || sim.brake > .01 || sim.reverse > .01;
      const loss = before.speed > TARGETS.stallMinSpeed ? (before.speed - speed) / before.speed : 0;
      const stalled = !settling && !braking && !driver.recovering && loss > TARGETS.stallLoss; // classified after the contacts
      // Pitch/roll spikes.
      const rate = Math.max(Math.abs(pitch), Math.abs(roll));
      if (!settling && rate > TARGETS.spikeRate) {
        spikeTicks++; maxSpike = Math.max(maxSpike, rate);
        episodes.add('spike', tick, { ...base, metric: 'pitchRollSpike', value: round(rate), unit: 'rad/s', severity: rate / TARGETS.spikeRate, detail: { pitch: round(pitch), roll: round(roll), onLane } });
      }

      // Chassis contacts.
      const chassis = sim.car.collider(0);
      type Hit = { n: Vec3; dv: number; impulse: number; point: Vec3; upright: boolean; along: number };
      const hits: Hit[] = [];
      sim.world.contactPairsWith(chassis, other => {
        if (other.parent()?.handle === sim.car.handle) return;
        sim.world.contactPair(chassis, other, manifold => {
          const k = manifold.numContacts(); if (!k) return;
          let impulse = 0; for (let i = 0; i < k; i++) impulse += manifold.contactImpulse(i);
          const dv = impulse / mass * mpu; if (dv < .02) return; // resting or speculative contact carries no impulse
          const n = manifold.normal(), point = manifold.numSolverContacts() ? manifold.solverContactPoint(0) : p;
          const horizontal = Math.hypot(v.x, v.z) || 1, nh = Math.hypot(n.x, n.z) || 1;
          hits.push({ n: { x: n.x, y: n.y, z: n.z }, dv, impulse, point: { x: point.x, y: point.y, z: point.z }, upright: Math.abs(n.y) >= .6, along: Math.abs((n.x * v.x + n.z * v.z) / horizontal) * (nh > 1e-6 ? 1 : 0) });
        });
      });
      const candidates = hits.filter(hit => !(hit.upright && !(!braking && (loss > .015 || hit.dv * hit.along >= .2))));
      floorContactTicks += hits.length - candidates.length; // body resting on / brushing the floor
      const barriers = onLane ? candidates.map(hit => realBarrier(sim, hit.n, 1.5, hit.point)) : [];
      // A real barrier hit in this tick, or within the last 0.5 s and 3 m (the car still tangled in the same crash),
      // makes every other contact of the moment part of that crash, not a phantom.
      const barrierNow = barriers.find(b => b);
      if (barrierNow) lastBarrier = { tick, x: p.x, z: p.z };
      const inCrash = !!lastBarrier && tick - lastBarrier.tick <= 30 && Math.hypot(p.x - lastBarrier.x, p.z - lastBarrier.z) * mpu < 3;
      candidates.forEach((hit, k) => {
        const event = { ...base, x: round(hit.point.x), y: round(hit.point.y), z: round(hit.point.z), value: round(hit.dv, 3), unit: 'm/s (contact impulse / mass)', detail: { normal: [round(hit.n.x), round(hit.n.y), round(hit.n.z)], impulse: round(hit.impulse, 1), lossPct: round(loss * 100), onLane, recovering: driver.recovering } };
        if (!onLane) { offLaneContactTicks++; episodes.add('offLaneContact', tick, { ...event, metric: 'driverOffLaneContact', severity: hit.dv }); return; }
        const barrier = barriers[k];
        if (barrier || inCrash) {
          // A real barrier touched while the car is within 1.5 m of the route line means the ROUTE (drive trace /
          // centreline) runs into a wall, or the wall stands in the lane: reported apart from ordinary driver contacts.
          if (Math.abs(driver.lateral) * mpu < 1.5) wallOnLineTicks++;
          driverWallTicks++;
          episodes.add('driverWall', tick, { ...event, metric: 'driverWallContact', severity: hit.dv, detail: { ...event.detail, barrierM: barrier ? round(barrier.distanceM) : null, crashTicksAgo: barrier ? 0 : tick - lastBarrier!.tick } });
          return;
        }
        phantomTicks++; maxPhantomDv = Math.max(maxPhantomDv, hit.dv);
        episodes.add('phantom', tick, { ...event, metric: 'phantomWall', severity: 20 + hit.dv * 10 });
      });
      // Stall: the speed loss of a driver crash (real barrier now or moments ago, or off the lane) is the driver's.
      if (stalled) {
        const driverCaused = inCrash || !onLane;
        if (driverCaused) crashStallTicks++; else { stallTicks++; maxStall = Math.max(maxStall, loss); }
        episodes.add(driverCaused ? 'crashStall' : 'stall', tick, { ...base, metric: driverCaused ? 'driverCrashStall' : 'stall', value: round(loss * 100), unit: '% speed lost in one tick', severity: (driverCaused ? .5 : 1) + loss / TARGETS.stallLoss, detail: { onLane, fromMph: round(before.speed * MPH, 1) } });
      }

      // Floor gap per grounded wheel (lane only), at the pose the suspension rays were cast from.
      if (!settling && onLane) {
        const bottoms = wheelBottoms(sim, before.q);
        bottoms.forEach((wheel, i) => {
          if (!wheel?.grounded) { closeSustained(i); return; }
          wheelTicks++;
          const floor = visibleFloor(sim, wheel.point);
          if (visibleGroundAt && floorCheck < 400) { floorCheck++; const reference = visibleGroundAt(wheel.point); if ((reference === undefined) !== (floor === undefined) || (reference !== undefined && floor && Math.abs(reference - floor.y) > 1e-4)) floorMismatch++; }
          // No visible floor within 1.15 m under a grounded tyre: it rides on something the player cannot see (or over
          // a hole). Counted outside the band and as beyond +-5 cm for the sustained rule.
          if (!floor) { noFloor++; sustained[i]++; episodes.add(`nofloor${i}`, tick, { ...base, metric: 'floorGapNoFloor', value: i, unit: 'wheel index', severity: 2 }); return; }
          const gap = heightAbove(wheel.point, floor) * mpu * 100;
          gaps.push(gap);
          if (gap >= TARGETS.floorGapBandCm[0] && gap <= TARGETS.floorGapBandCm[1]) inBand++;
          else episodes.add(`gap${i}`, tick, { ...base, metric: 'floorGap', value: round(gap), unit: 'cm', severity: gap < 0 ? -gap / -TARGETS.floorGapBandCm[0] : gap / TARGETS.floorGapBandCm[1], detail: { wheel: i } });
          if (Math.abs(gap) > TARGETS.floorGapHardCm) sustained[i]++; else closeSustained(i);
        });
        // Chassis bottom vs visible floor.
        let lowest = Infinity;
        for (const point of chassisBottom(sim)) { const floor = visibleFloor(sim, point); if (floor) lowest = Math.min(lowest, heightAbove(point, floor) * mpu * 100); }
        if (Number.isFinite(lowest)) {
          clearances.push(lowest); chassisMin = Math.min(chassisMin, lowest);
          if (lowest < TARGETS.chassisClearanceMinCm) { chassisNegTicks++; episodes.add('chassis', tick, { ...base, metric: 'chassisClearance', value: round(lowest), unit: 'cm', severity: 1 - lowest }); }
        }
      } else for (let i = 0; i < 4; i++) closeSustained(i);
    }
    for (let i = 0; i < 4; i++) closeSustained(i);
    episodes.flush();
    gaps.sort((a, b) => a - b); clearances.sort((a, b) => a - b);
    const longest = sustainedEpisodes.length ? Math.max(...sustainedEpisodes) * DT : 0;
    const gapSamples = gaps.length + noFloor;
    const summary = {
      track: track.id, car: car.id, route: route.source, routeFile: route.source === 'centerline' ? file : undefined, routePoints: route.points.length, routeLengthM: round(route.length * mpu, 1),
      start: start.teleported ? 'placed on route' : 'saved grid', lapM: round(lapM, 1), drivenM: round(driver.progress * mpu, 1),
      lapComplete: driver.done, partial: secondsLimit !== undefined && !driver.done, lapFinishedGate: lapFinished,
      ticks, seconds: round(ticks * DT, 1), avgMph: round(speedSum / Math.max(1, ticks) * MPH, 1), maxMph: round(maxMph, 1), maxBankMph: round(maxBankMph, 1),
      laneShare: round(laneTicks / Math.max(1, ticks), 4), driverRecoveries: driver.recoveries, recoverTicks,
      phantomWalls: { episodes: episodes.count('phantomWall'), ticks: phantomTicks, maxDvMs: round(maxPhantomDv, 3) },
      driverWallContacts: { episodes: episodes.count('driverWallContact'), ticks: driverWallTicks, ticksWithin1_5mOfRouteLine: wallOnLineTicks },
      driverStuckAt: stuckAt,
      offLaneContacts: { episodes: episodes.count('driverOffLaneContact'), ticks: offLaneContactTicks },
      chassisFloorContactTicks: floorContactTicks,
      offRoadOnRouteLine: { episodes: episodes.count('offRoadOnRouteLine'), ticks: offRoadOnLineTicks, spans: episodes.list.filter(e => e.metric === 'offRoadOnRouteLine').slice(0, 20).map(e => ({ tick: e.tick, distanceM: e.distanceM, x: e.x, z: e.z, ticks: e.durationTicks, surface: e.value })) },
      stalls: { episodes: episodes.count('stall'), ticks: stallTicks, worstLossPct: round(maxStall * 100), driverCrashEpisodes: episodes.count('driverCrashStall'), driverCrashTicks: crashStallTicks },
      spikes: { episodes: episodes.count('pitchRollSpike'), ticks: spikeTicks, maxRadS: round(maxSpike) },
      respawns, airborneShare: round(air / Math.max(1, ticks), 4),
      rough: round(Math.sqrt(roughSum / Math.max(1, ticks))), bump: round(Math.sqrt(bumpSum / Math.max(1, ticks))), jolt: round(joltSum / Math.max(1, ticks), 3),
      skinShare: skinKnown ? round(skin / Math.max(1, ticks), 4) : null,
      floorGap: {
        wheelTicks, samples: gaps.length, noFloor, p1: round(percentile(gaps, 1)), p50: round(percentile(gaps, 50)), p99: round(percentile(gaps, 99)),
        min: round(gaps[0] ?? NaN), max: round(gaps.at(-1) ?? NaN),
        inBandShare: round(inBand / Math.max(1, gapSamples), 4), outsideBandShare: round(1 - inBand / Math.max(1, gapSamples), 4),
        outside5cmSustainedShare: round(sustainedTicks / Math.max(1, gapSamples), 4), sustainedEpisodesOver025s: sustainedEpisodes.filter(n => n * DT > TARGETS.floorGapHardMaxS).length, longestOutside5cmS: round(longest, 3),
      },
      chassisClearance: { samples: clearances.length, minCm: round(chassisMin), p1: round(percentile(clearances, 1)), p50: round(percentile(clearances, 50)), negativeShare: round(chassisNegTicks / Math.max(1, clearances.length), 4) },
      visibleFloorCheck: visibleGroundAt ? { compared: floorCheck, mismatches: floorMismatch } : 'Simulation.visibleGroundAt absent',
      violations: [] as string[], warnings: [] as string[],
    };
    // Driver / route quality (not smoothness targets, but they limit what the lap measured).
    const w = summary.warnings;
    if (summary.driverWallContacts.episodes) w.push(`driver touched real barriers ${summary.driverWallContacts.episodes}x (${summary.driverWallContacts.ticksWithin1_5mOfRouteLine} ticks within 1.5 m of the route line)`);
    if (stuckAt.length) w.push(`driver stuck/recovered ${driver.recoveries}x, first at ${stuckAt[0].distanceM} m (${stuckAt[0].x}, ${stuckAt[0].z})`);
    if (offRoadOnLineTicks) w.push(`on grass/gravel within 2 m of the route line for ${(offRoadOnLineTicks * DT).toFixed(1)} s, first at ${summary.offRoadOnRouteLine.spans[0]?.distanceM} m`);
    if (summary.offLaneContacts.episodes) w.push(`contacts off the lane ${summary.offLaneContacts.episodes}x`);
    const v = summary.violations;
    if (summary.phantomWalls.episodes > TARGETS.phantomWalls) v.push(`phantomWalls ${summary.phantomWalls.episodes}`);
    if (summary.stalls.episodes > TARGETS.stalls) v.push(`stalls ${summary.stalls.episodes}`);
    if (respawns > TARGETS.respawns) v.push(`respawns ${respawns}`);
    if (summary.spikes.episodes > TARGETS.spikes) v.push(`pitch/roll spikes ${summary.spikes.episodes}`);
    if (summary.floorGap.inBandShare < TARGETS.floorGapInBandShare) v.push(`floorGap in [-1,+3] cm ${(summary.floorGap.inBandShare * 100).toFixed(1)}% < 99%`);
    if (summary.floorGap.longestOutside5cmS > TARGETS.floorGapHardMaxS) v.push(`floorGap beyond +-5 cm for ${summary.floorGap.longestOutside5cmS.toFixed(2)} s`);
    if (summary.chassisClearance.minCm < TARGETS.chassisClearanceMinCm) v.push(`chassisClearance ${summary.chassisClearance.minCm} cm`);
    if (!driver.done && secondsLimit === undefined) v.push(`driver: lap incomplete (${summary.drivenM}/${summary.lapM} m)`);
    if (track.id === 'daytona' && (secondsLimit === undefined || driver.done)) {
      const need = Math.min(TARGETS.daytonaBankMph, car.physics.topSpeedKph / 1.609344 * .9);
      if (summary.maxBankMph < need) v.push(`driver: banking ${summary.maxBankMph} mph < ${need.toFixed(0)} mph`);
    }
    return { summary, offenders: episodes.list };
  } finally { sim.dispose(); }
}

const isMain = process.argv[1]?.endsWith('smooth-audit.ts');
if (isMain) {
  const savedLabel = await loadSaved();
  await initPhysics();
  const runs: ReturnType<typeof auditRun>['summary'][] = [], worstOffenders: Record<string, Offender[]> = {};
  const header = 'track         car              lap%  avg/max/bank mph   phant drvW stall spike resp air%  gap p1/p50/p99 cm   inBand  >5cm s  chassis cm  rough bump jolt  result';
  console.log(header);
  for (const id of trackIds) {
    const track = TRACKS.find(t => t.id === id)!;
    await initPhysics(track);
    const offenders: Offender[] = [];
    for (const carId of carIds) {
      const started = Date.now();
      const { summary: s, offenders: list } = auditRun(track, carId);
      runs.push(s); offenders.push(...list);
      const f = s.floorGap;
      console.log(`${s.track.padEnd(13)} ${s.car.padEnd(16)} ${(s.drivenM / s.lapM * 100).toFixed(0).padStart(4)}  ${`${s.avgMph.toFixed(0)}/${s.maxMph.toFixed(0)}/${s.maxBankMph.toFixed(0)}`.padEnd(17)} ${String(s.phantomWalls.episodes).padStart(5)} ${String(s.driverWallContacts.episodes).padStart(4)} ${String(s.stalls.episodes).padStart(5)} ${String(s.spikes.episodes).padStart(5)} ${String(s.respawns).padStart(4)} ${(s.airborneShare * 100).toFixed(1).padStart(4)}  ${`${f.p1.toFixed(1)}/${f.p50.toFixed(1)}/${f.p99.toFixed(1)}`.padEnd(18)} ${(f.inBandShare * 100).toFixed(1).padStart(6)}% ${f.longestOutside5cmS.toFixed(2).padStart(6)}  ${s.chassisClearance.minCm.toFixed(1).padStart(10)}  ${s.rough.toFixed(1).padStart(5)} ${s.bump.toFixed(2).padStart(4)} ${s.jolt.toFixed(2).padStart(4)}  ${s.violations.length ? 'FAIL' : 'pass'}  (${((Date.now() - started) / 1000).toFixed(0)} s)`);
      for (const violation of s.violations) console.log(`    - ${violation}`);
      for (const warning of s.warnings) console.log(`    ~ ${warning}`);
    }
    worstOffenders[id] = worst(offenders, 50);
  }
  const failed = runs.filter(r => r.violations.length);
  const report = {
    generated: new Date().toISOString(), physicsVersion: PHYSICS_VERSION, saved: savedLabel, units: 'lengths in metres = world units * track.metersPerUnit; gaps/clearances in cm; speeds mph',
    cli: process.argv.slice(2), targets: TARGETS, pass: failed.length === 0, runs, worstOffenders,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 1));
  console.log(`${failed.length ? 'FAIL' : 'PASS'}: ${runs.length - failed.length}/${runs.length} runs within targets. Report: ${outPath}`);
  process.exitCode = failed.length ? 1 : 0;
}
