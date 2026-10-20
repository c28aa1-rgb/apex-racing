import test from 'node:test';
import assert from 'node:assert/strict';
import { initPhysics, Input, PHYSICS_VERSION, Simulation, type Weather } from '../shared/physics';
import { runSchema, stepReplay, type Run } from '../shared/replay';
import { handlingTrack } from './handling-harness';

/** Brings a car to `speed` m/s on the open pad, then applies `input` for `ticks`; returns the sim afterwards. */
function drive(weather: Weather, speed: number, input: number, ticks: number, setup?: (sim: Simulation) => void) {
  const sim = new Simulation(handlingTrack(), 'porsche-911-gt3');
  sim.weather = weather;
  for (let i = 0; i < 60; i++) sim.step(0);
  sim.car.setLinvel({ x: 0, y: 0, z: speed }, true);
  setup?.(sim);
  for (let i = 0; i < ticks; i++) sim.step(input);
  return sim;
}

test('wet and snowy roads brake later and corner wider than dry', async () => {
  await initPhysics();
  const stop = (weather: Weather) => { const sim = drive(weather, 40, Input.Brake, 150); try { return sim.car.translation().z; } finally { sim.dispose(); } };
  const turn = (weather: Weather) => { const sim = drive(weather, 30, Input.Left, 120); try { return Math.abs(sim.car.translation().x); } finally { sim.dispose(); } };
  const dry = stop('clear'), fog = stop('fog'), rain = stop('rain'), snow = stop('snow');
  assert.ok(dry < fog && fog < rain && rain < snow, `stopping from 40 m/s: dry ${dry.toFixed(1)}, fog ${fog.toFixed(1)}, rain ${rain.toFixed(1)}, snow ${snow.toFixed(1)} m`);
  // Less grip turns the car less in the same time: it runs wider (less sideways travel).
  assert.ok(turn('clear') > turn('rain') && turn('rain') > turn('snow'), 'cornering grip falls with the weather');
});

test('a run records its weather and replays exactly in it', async () => {
  await initPhysics();
  const track = handlingTrack(), live = new Simulation(track, 'porsche-911-gt3'), inputs: number[] = [];
  live.weather = 'rain';
  try {
    for (let i = 0; i < 400; i++) { const input = Input.Throttle | (i > 200 && i < 260 ? Input.Left : 0); inputs.push(input); live.step(input); }
    const run: Run = { trackId: track.id, trackVersion: track.version, physicsVersion: PHYSICS_VERSION, carId: 'porsche-911-gt3', timeMs: live.timeMs, inputs, weather: 'rain' };
    assert.ok(runSchema.safeParse(run).success);
    for (const [weather, same] of [['rain', true], [undefined, false]] as const) {
      const replay = new Simulation(track, 'porsche-911-gt3');
      try {
        inputs.forEach(() => stepReplay(replay, { ...run, weather }));
        assert.equal(JSON.stringify(replay.car.translation()) === JSON.stringify(live.car.translation()), same, weather ?? 'clear');
      } finally { replay.dispose(); }
    }
  } finally { live.dispose(); }
});

test('running in the wake of a car ahead cuts drag; alone or alongside it does nothing', async () => {
  await initPhysics();
  // A lead car at 70 m/s, `gap` metres ahead and `across` metres to the side, moved every tick like a party car.
  const top = (gap?: number, across = 0) => {
    const sim = drive('clear', 70, Input.Throttle, 0, sim => { if (gap !== undefined) sim.setObstacle('lead', 'porsche-911-gt3', { p: { x: across, y: .8, z: sim.car.translation().z + gap }, q: { x: 0, y: 0, z: 0, w: 1 } }); });
    let deepest = 0;
    try {
      for (let i = 0; i < 240; i++) {
        const z = sim.car.translation().z;
        if (gap !== undefined) sim.setObstacle('lead', 'porsche-911-gt3', { p: { x: across, y: .8, z: z + gap }, q: { x: 0, y: 0, z: 0, w: 1 } });
        sim.step(Input.Throttle); deepest = Math.max(deepest, sim.slipstream);
      }
      return { speed: sim.car.linvel().z, deepest };
    } finally { sim.dispose(); }
  };
  const alone = top(), close = top(12), far = top(40), beside = top(12, 6);
  assert.equal(alone.deepest, 0);
  assert.ok(close.deepest > .25 && close.speed > alone.speed + .5, `12 m behind: drag cut ${close.deepest.toFixed(2)}, ${close.speed.toFixed(2)} vs ${alone.speed.toFixed(2)} m/s alone`);
  assert.ok(far.deepest > 0 && far.deepest < close.deepest, 'the wake weakens with distance');
  assert.equal(beside.deepest, 0, 'a car alongside leaves no wake');
});

test('runs in every weather share one leaderboard, and their replays keep the weather', async () => {
  const { Store } = await import('../server/store');
  const store = new Store(); await store.init(); await store.init();
  try {
    const track = handlingTrack(), base = { trackId: track.id, trackVersion: track.version, physicsVersion: PHYSICS_VERSION as Run['physicsVersion'], carId: 'porsche-911-gt3' as const };
    const dry = await store.createPlayer('Dry driver'), wet = await store.createPlayer('Wet driver');
    const dryRun: Run = { ...base, timeMs: 60, inputs: [1, 1, 1] }, wetRun: Run = { ...base, timeMs: 50, inputs: [1, 1, 1], weather: 'rain' };
    await store.save(dry.id, dryRun); await store.save(wet.id, wetRun);
    const board = await store.leaderboard(track.id, track.version);
    assert.deepEqual(board.map(row => row.playerId), [wet.id, dry.id], 'ranked by time whatever the weather');
    assert.deepEqual(await store.replay(board[0].id as string), wetRun);
    assert.deepEqual(await store.replay(board[1].id as string), dryRun, 'a clear run has no weather field');
  } finally { await store.close(); }
});
