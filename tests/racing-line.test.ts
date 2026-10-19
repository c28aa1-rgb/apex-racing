import test from 'node:test';
import assert from 'node:assert/strict';
import { TRACKS } from '../shared/tracks';
import { carById } from '../shared/cars';
import { RACING_LINES } from '../shared/racing-lines';
import { LINE_TUNING, Zone, acceleration, brakingEnvelope, nearestStation, predictZones, racingLine } from '../shared/racing-line';

const rb19 = carById('red-bull-rb19'), celica = carById('celica-gt4');
const lineFor = (id: string) => racingLine(RACING_LINES[id], TRACKS.find(track => track.id === id)!.metersPerUnit);

test('every circuit has a closed, continuous racing line with road heights', () => {
  for (const track of TRACKS) {
    const baked = RACING_LINES[track.id];
    assert.ok(baked, `${track.id} has a baked line`);
    const line = racingLine(baked, track.metersPerUnit), spacing = baked.step * track.metersPerUnit;
    assert.ok(line.n > 500, `${track.id} has ${line.n} stations`);
    for (let i = 0; i < line.n; i++) {
      assert.ok([line.x[i], line.z[i], line.yl[i], line.yr[i]].every(Number.isFinite), `${track.id} station ${i} is finite`);
      // Closed: the last station leads back to the first like any other.
      assert.ok(line.ds[i] > spacing * .5 && line.ds[i] < spacing * 1.5, `${track.id} station ${i} is ${line.ds[i].toFixed(1)} m from the next`);
      assert.ok(Math.abs(line.yl[i] - line.yr[i]) < 1, `${track.id} station ${i} ribbon lies on the road`);
    }
    assert.ok(Math.abs(line.length / track.length - 1) < .25, `${track.id} line is ${(line.length / 1000).toFixed(2)} km`);
  }
});

test('the braking envelope never asks for more braking than the car has', () => {
  const line = lineFor('spa');
  for (const car of [rb19, celica]) {
    const envelope = brakingEnvelope(line, car), top = car.physics.topSpeedKph / 3.6;
    for (let i = 0; i < line.n; i++) {
      const next = envelope[(i + 1) % line.n];
      assert.ok(envelope[i] <= top + 1e-3 && envelope[i] >= 8 - 1e-3);
      // Reachable: slowing from this station's speed to the next one's takes at most full braking (plus aero drag).
      const decel = (envelope[i] ** 2 - next ** 2) / (2 * line.ds[i]);
      assert.ok(decel <= LINE_TUNING.brake * 1.5 * 27.78 ** 2 / (2 * car.physics.brakeDistance) + car.physics.drag * envelope[i] ** 2 / (car.physics.massKg * line.mpu) + .2,
        `${car.id} station ${i} asks for ${decel.toFixed(1)} m/s²`);
    }
  }
});

test('a faster-braking, higher-grip car brakes later and carries more speed through the same corner', () => {
  const line = lineFor('hungaroring'), fast = brakingEnvelope(line, rb19), slow = brakingEnvelope(line, celica);
  // The tightest corner on the lap.
  let apex = 0;
  for (let i = 0; i < line.n; i++) if (line.curvature[i] > line.curvature[apex]) apex = i;
  assert.ok(fast[apex] > slow[apex], `apex ${fast[apex].toFixed(1)} vs ${slow[apex].toFixed(1)} m/s`);
  // Arriving at the same speed 300 m before the apex, each car's first braking station.
  const before = Math.round(300 / (line.length / line.n)), start = (apex - before + line.n) % line.n, speed = 45;
  const firstBrake = (car: typeof rb19, envelope: Float32Array) => {
    const zones = new Uint8Array(line.n);
    predictZones(line, envelope, car, start, speed, before, zones);
    for (let k = 0; k < before; k++) if (zones[(start + k) % line.n] === Zone.Brake) return k;
    return before;
  };
  assert.ok(firstBrake(rb19, fast) > firstBrake(celica, slow), 'the RB19 starts braking closer to the corner');
});

test('the colours follow the car: too fast is red at once, from a standstill it is green', () => {
  const line = lineFor('barcelona'), envelope = brakingEnvelope(line, celica), zones = new Uint8Array(line.n);
  let slowest = 0;
  for (let i = 0; i < line.n; i++) if (envelope[i] < envelope[slowest]) slowest = i;
  predictZones(line, envelope, celica, slowest, envelope[slowest] + 25, 10, zones);
  assert.equal(zones[slowest], Zone.Brake);
  predictZones(line, envelope, celica, slowest, 0, 10, zones);
  assert.equal(zones[slowest], Zone.Accelerate);
  // Full throttle gains speed at low speed and stops gaining at the top.
  assert.ok(acceleration(celica, 10, line.mpu) > 3);
  assert.ok(acceleration(celica, celica.physics.topSpeedKph / 3.6 * 1.05, line.mpu) < .5);
});

test('the nearest station follows the car and finds it again after a recovery', () => {
  const line = lineFor('daytona'), i = 400, j = 40;
  assert.equal(nearestStation(line, line.x[i] + .3, line.z[i] - .2, i - 3), i);
  assert.equal(nearestStation(line, line.x[j], line.z[j], i), j);
});
