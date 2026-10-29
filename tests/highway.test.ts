import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CAR } from '../shared/cars';
import { initPhysics, Simulation, Input, rotate } from '../shared/physics';
import { HIGHWAY } from '../shared/tracks';
import { CHUNK, HighwayRoad, laneCentre, SAMPLES, STEP } from '../shared/highway';
import { HighwayTraffic, survivalDensity, type HighwayConfig } from '../shared/highway-traffic';

before(() => initPhysics());

const cruise = (seed: number, density = 14, speedKph = 105): HighwayConfig => ({ seed, mode: 'cruise', traffic: { density, speedKph } });

test('the same seed builds the same road, and chunks join without a seam', () => {
  const a = new HighwayRoad(7), b = new HighwayRoad(7), other = new HighwayRoad(8);
  // Built in different orders (and backwards from s = 0) they still agree.
  for (const index of [3, -2, 0, 1, 2, -1]) a.chunk(index);
  for (let index = -2; index <= 3; index++) assert.deepEqual(b.chunk(index), a.chunk(index));
  assert.notDeepEqual(other.chunk(2).samples, a.chunk(2).samples);
  for (let index = -2; index < 3; index++) {
    const end = a.chunk(index).samples[SAMPLES - 1], start = a.chunk(index + 1).samples[0];
    assert.equal(end.x, start.x); assert.equal(end.z, start.z); assert.equal(end.y, start.y); assert.equal(end.heading, start.heading);
  }
});

test('bends are gentle, hills are gentle, and the road keeps its general direction', () => {
  const road = new HighwayRoad(1234);
  let maxCurvature = 0, maxGrade = 0, maxBank = 0;
  for (let s = -5000; s < 60000; s += STEP) {
    maxCurvature = Math.max(maxCurvature, Math.abs(road.heading(s + 1) - road.heading(s - 1)) / 2);
    maxGrade = Math.max(maxGrade, Math.abs(road.height(s + .5) - road.height(s - .5)));
    maxBank = Math.max(maxBank, Math.abs(road.bank(s)));
    assert.ok(Math.abs(road.heading(s)) < Math.PI / 3, 'never turns back on itself');
  }
  assert.ok(1 / maxCurvature > 780, `tightest radius ${Math.round(1 / maxCurvature)} m`);
  assert.ok(maxGrade < .036, `steepest grade ${(maxGrade * 100).toFixed(1)}%`);
  assert.ok(maxBank <= .035);
  // Positions integrate the heading: 50 km on, the road is still roughly 50 km away and its samples are 5 m apart.
  const far = road.chunk(250).samples;
  for (let k = 1; k < far.length; k++) assert.ok(Math.abs(Math.hypot(far[k].x - far[k - 1].x, far[k].z - far[k - 1].z) - STEP) < .01);
  assert.ok(Math.hypot(far[0].x, far[0].z) > 40000);
});

test('projection finds a point’s distance along the road and its lateral offset', () => {
  const road = new HighwayRoad(99);
  for (const [s, lat] of [[120, 7.15], [3333, -10.85], [-760, 0], [12000.5, 14.2]]) {
    const p = road.point(s, lat), at = road.project(p.x, p.z, s + 20);
    assert.ok(Math.abs(at.s - s) < .05, `s ${at.s} vs ${s}`);
    assert.ok(Math.abs(at.lat - lat) < .05, `lat ${at.lat} vs ${lat}`);
  }
});

test('traffic keeps a steady pool, never stacks two cars in a lane, and follows the density setting', () => {
  const road = new HighwayRoad(5), config = cruise(5, 20);
  const player = { s: 120, lat: laneCentre(1), x: 0, y: 0, z: 0, along: 30 };
  const traffic = new HighwayTraffic(road, config, player);
  const host = { setObstacle() {}, obstacleState: () => undefined };
  const counts: number[] = [];
  // The player drives 20 km at 30 m/s; traffic is placed and recycled around them.
  for (let tick = 0; tick < 20000 / 30 * 60; tick++) {
    player.s += 30 / 60;
    const p = road.point(player.s, player.lat); Object.assign(player, p);
    traffic.step(host, player, { x: 0, y: 0, z: 0 }, player.s - 120);
    if (tick % 600 === 0) {
      const active = traffic.cars.filter(car => car.active);
      counts.push(active.length);
      for (const car of active) for (const other of active) {
        if (car === other || car.lane !== other.lane || car.target !== car.lane || other.target !== other.lane) continue;
        assert.ok(Math.abs(car.s - other.s) > 4, `cars ${car.id} and ${other.id} overlap in lane ${car.lane}`);
      }
    }
  }
  const wanted = Math.round(20 * 1.88) * 2;
  for (const count of counts.slice(2)) assert.ok(Math.abs(count - wanted) <= 6, `${count} cars, ${wanted} wanted`);
  assert.ok(traffic.cars.length < wanted * 1.6, `pool stays bounded (${traffic.cars.length})`);
  // More traffic asked for mid-drive: it fills in.
  traffic.settings = { density: 34, speedKph: 105 };
  for (let tick = 0; tick < 1200; tick++) { player.s += .5; Object.assign(player, road.point(player.s, player.lat)); traffic.step(host, player, { x: 0, y: 0, z: 0 }, 0); }
  assert.ok(traffic.cars.filter(car => car.active).length > wanted * 1.4);
  assert.equal(survivalDensity(0) < survivalDensity(10000), true);
  assert.equal(survivalDensity(25000), survivalDensity(60000));
});

/** Holds a lane at full throttle (or `speed` m/s), steering by its lateral and heading error. */
function laneBot(sim: Simulation, lane = 1, speed = Infinity) {
  const h = sim.highway!, q = sim.car.rotation(), front = rotate(q, { x: 0, y: 0, z: 1 });
  const error = h.lat - laneCentre(lane), off = Math.atan2(Math.sin(Math.atan2(front.x, front.z) - h.road.heading(h.s)), Math.cos(Math.atan2(front.x, front.z) - h.road.heading(h.s)));
  const command = error * .12 - off * 2.2;
  return (sim.forwardSpeed < speed ? Input.Throttle : 0) | (command > .03 ? Input.Left : command < -.03 ? Input.Right : 0);
}

test('a car drives 30 km down the highway: chunks stream, the origin shifts, nothing respawns', () => {
  const sim = new Simulation(HIGHWAY, DEFAULT_CAR.id, undefined, cruise(42, 0));
  try {
    sim.maxTicks = Infinity;
    let shifts = 0, version = 0, lastAbsolute = { x: 0, z: 0 }, worstJump = 0;
    for (let tick = 0; tick < 60 * 60 * 12 && sim.highway!.distance < 30000; tick++) {
      sim.step(laneBot(sim, 1, 58));
      const p = sim.car.translation(), o = sim.highway!.origin, absolute = { x: p.x + o.x, z: p.z + o.z };
      if (tick) worstJump = Math.max(worstJump, Math.hypot(absolute.x - lastAbsolute.x, absolute.z - lastAbsolute.z));
      lastAbsolute = absolute;
      if (sim.highway!.originVersion !== version) { version = sim.highway!.originVersion; shifts++; }
      assert.ok(Math.abs(p.x) < 3300 && Math.abs(p.z) < 3300, 'the physics world stays near its origin');
    }
    assert.ok(sim.highway!.distance >= 30000, `got ${Math.round(sim.highway!.distance)} m`);
    assert.equal(sim.respawns, 0);
    assert.ok(shifts >= 8, `${shifts} origin shifts`);
    assert.ok(worstJump < 1.2, `the car never jumps in absolute space (${worstJump.toFixed(3)} m in a tick)`);
    assert.ok(Math.abs(sim.highway!.lat - laneCentre(1)) < 1.2, `still in its lane (${sim.highway!.lat.toFixed(2)})`);
  } finally { sim.dispose(); }
});

test('the same seed and inputs give the same run, traffic and all', () => {
  const run = () => {
    const sim = new Simulation(HIGHWAY, DEFAULT_CAR.id, undefined, { seed: 77, mode: 'survival', traffic: { density: 0, speedKph: 0 } });
    try {
      sim.maxTicks = Infinity;
      for (let tick = 0; tick < 60 * 40; tick++) sim.step(laneBot(sim, tick < 900 ? 1 : 2, 45));
      const p = sim.car.translation();
      return { p: { ...p }, distance: sim.highway!.distance, cars: sim.highway!.traffic.cars.map(car => [car.s, car.lat, car.v]), hits: sim.hitCount };
    } finally { sim.dispose(); }
  };
  assert.deepEqual(run(), run());
});

/** A survival run on an empty road, with one car placed relative to the player. */
function survivalWith(setup: (sim: Simulation) => void, drive: (sim: Simulation, tick: number) => number, ticks: number) {
  const sim = new Simulation(HIGHWAY, DEFAULT_CAR.id, undefined, { seed: 3, mode: 'survival', traffic: { density: 0, speedKph: 0 } });
  sim.maxTicks = Infinity;
  // No generated traffic: only the test's own obstacle.
  sim.highway!.traffic.settings = { density: 0, speedKph: 0 };
  Object.defineProperty(sim.highway!.traffic, 'settings', { get: () => ({ density: 0, speedKph: 0 }), set() {} });
  for (const car of sim.highway!.traffic.cars) car.active = false;
  setup(sim);
  for (let tick = 0; tick < ticks && sim.highway!.crashedAt === undefined; tick++) sim.step(drive(sim, tick));
  return sim;
}

test('a skim along the rail is not a crash; running into a car at speed is', () => {
  // Brushing the guardrail at a shallow angle at speed.
  const skim = survivalWith(() => {}, (sim, tick) => tick < 420 ? laneBot(sim, 2, 32) : (Input.Throttle | (tick < 470 ? Input.Right : 0) | (sim.highway!.lat > 14.2 && tick >= 470 ? Input.Left : 0)), 900);
  try {
    assert.ok(skim.hitCount > 0, 'the rail was touched');
    assert.equal(skim.highway!.crashedAt, undefined, `a skim ended the run (${skim.highway!.crashReason})`);
  } finally { skim.dispose(); }
  // A parked van dead ahead in the lane.
  const crash = survivalWith(sim => {
    const h = sim.highway!, pose = h.road.lanePose(h.s + 260, 1), o = h.origin;
    sim.setObstacle('parked', { widthM: 2, heightM: 1.4, lengthM: 5.4, massKg: 2400 }, { p: { x: pose.x - o.x, y: pose.y + .7 - o.y, z: pose.z - o.z }, q: { x: 0, y: Math.sin(pose.heading / 2), z: 0, w: Math.cos(pose.heading / 2) } });
  }, sim => laneBot(sim, 1), 900);
  try {
    assert.ok(crash.highway!.crashedAt !== undefined, 'a rear-end at speed ends the run');
    assert.equal(crash.highway!.crashReason, 'impact');
  } finally { crash.dispose(); }
});

test('chunk colliders come and go with the car', () => {
  const sim = new Simulation(HIGHWAY, DEFAULT_CAR.id, undefined, cruise(9, 0));
  try {
    sim.maxTicks = Infinity;
    const bodies = () => { let n = 0; sim.world.forEachRigidBody(body => { if (body.isFixed()) n++; }); return n; };
    const start = bodies();
    for (let tick = 0; tick < 60 * 60; tick++) sim.step(laneBot(sim, 1, 50));
    assert.ok(sim.highway!.distance > CHUNK * 10);
    assert.equal(bodies(), start, 'as many chunks loaded as at the start');
  } finally { sim.dispose(); }
});

test('rush hour spreads across all three lanes instead of piling into the fast lane', () => {
  const road = new HighwayRoad(11), player = { s: 120, lat: laneCentre(1), x: 0, y: 0, z: 0, along: 40 };
  const traffic = new HighwayTraffic(road, cruise(11, 38), player);
  const host = { setObstacle() {}, obstacleState: () => undefined }, lanes = [0, 0, 0];
  for (let tick = 0; tick < 60 * 150; tick++) {
    player.s += 40 / 60; Object.assign(player, road.point(player.s, player.lat));
    traffic.step(host, player, { x: 0, y: 0, z: 0 }, 0);
    if (tick > 60 * 30 && tick % 60 === 0) for (const car of traffic.cars) if (car.active && car.lane < 3 && Math.abs(car.s - player.s - 500) < 500) lanes[car.lane]++;
  }
  const total = lanes.reduce((a, b) => a + b, 0);
  for (const [lane, n] of lanes.entries()) assert.ok(n / total > .22 && n / total < .45, `lane ${lane} holds ${Math.round(100 * n / total)}% of the traffic`);
});

test('survival only counts distance driven in the lanes, not on the shoulder', () => {
  const run = (lat: number) => {
    const sim = new Simulation(HIGHWAY, DEFAULT_CAR.id, undefined, { seed: 4, mode: 'survival', traffic: { density: 0, speedKph: 0 } });
    try {
      sim.maxTicks = Infinity;
      Object.defineProperty(sim.highway!.traffic, 'settings', { get: () => ({ density: 0, speedKph: 0 }), set() {} });
      for (const car of sim.highway!.traffic.cars) car.active = false;
      for (let tick = 0; tick < 60 * 25; tick++) {
        const h = sim.highway!, q = sim.car.rotation(), front = rotate(q, { x: 0, y: 0, z: 1 });
        const off = Math.atan2(Math.sin(Math.atan2(front.x, front.z) - h.road.heading(h.s)), Math.cos(Math.atan2(front.x, front.z) - h.road.heading(h.s)));
        const c = (h.lat - lat) * .12 - off * 2.2;
        sim.step((sim.forwardSpeed < 30 ? Input.Throttle : 0) | (c > .03 ? Input.Left : c < -.03 ? Input.Right : 0));
      }
      return sim.highway!.distance;
    } finally { sim.dispose(); }
  };
  assert.ok(run(laneCentre(2)) > 400, 'in a lane the distance counts');
  assert.ok(run(14.4) < 60, 'on the shoulder it barely counts (only the pull-over from the start lane)');
});

test('survival ends a run that crawls along below 40 mph, but not one at a normal speed', () => {
  const drive = (speed: number, seconds: number) => survivalWith(() => {}, sim => laneBot(sim, 1, speed), seconds * 60);
  const crawl = drive(14, 40);
  try {
    assert.equal(crawl.highway!.crashReason, 'slow');
    // Never up to 45 mph, so the rule arms after its 15 s grace; then 5 s below 40 mph.
    assert.ok(Math.abs(crawl.highway!.crashedAt! - 20 * 60) <= 2, `ended at tick ${crawl.highway!.crashedAt}`);
  } finally { crawl.dispose(); }
  const cruise = drive(25, 40);
  try { assert.equal(cruise.highway!.crashedAt, undefined, `a 56 mph run ended (${cruise.highway!.crashReason})`); } finally { cruise.dispose(); }
});
