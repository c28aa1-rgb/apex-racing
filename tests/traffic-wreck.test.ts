import { test } from 'node:test';
import { Vector3 } from 'three';
import assert from 'node:assert/strict';
import { CITY_ROADS, CITY_SIGNAL_POLES } from '../shared/city.data';
import { TrafficSim } from '../shared/city-traffic-sim';
import { PARTY_TRAFFIC_KINDS } from '../shared/city-party-traffic';
import { HighwayRoad, laneCentre, RAIL } from '../shared/highway';
import { HighwayTraffic } from '../shared/highway-traffic';

test('a knocked city car slides on the road surface and stays near its lane, on slopes and bridges too', () => {
  const sim = new TrafficSim(CITY_ROADS, CITY_SIGNAL_POLES, [...PARTY_TRAFFIC_KINDS]);
  // The driver far away: nothing near them is spared, and the populate fills the whole city.
  const driver = { position: new Vector3(0, 0, 0), velocity: new Vector3() };
  sim.populate([driver]);
  // The steepest-climbing cars: sample each lane's slope where a car sits.
  const cars = sim.cars.map(car => { const ahead = car.position.clone(); sim.sample(car.lane, Math.min(car.s + 10, car.lane.length), 0, ahead); return { car, slope: Math.abs(ahead.y - car.position.y) / 10 }; })
    .sort((a, b) => b.slope - a.slope).slice(0, 12);
  assert.ok(cars[0].slope > .02, `found sloped road (${cars[0].slope.toFixed(3)})`);
  for (const { car } of cars) {
    const q = { x: 0, y: Math.sin(car.yaw / 2), z: 0, w: Math.cos(car.yaw / 2) };
    // A big shove sideways and along: the slide must not carry it off into the air.
    sim.applyKnock(car, { p: { x: car.position.x, z: car.position.z }, q, v: { x: Math.cos(car.yaw) * 14 + Math.sin(car.yaw) * 12, z: -Math.sin(car.yaw) * 14 + Math.cos(car.yaw) * 12 }, w: { y: 1.5 } });
  }
  for (let i = 0; i < 240; i++) sim.step(1 / 60, [driver]);
  for (const { car } of cars) {
    if (!car.wreck) continue;
    const near = sim.nearest(car.lane, car.position), onLane = car.position.clone();
    sim.sample(car.lane, Math.min(near.s, car.lane.length), 0, onLane);
    assert.ok(Math.abs(car.position.y - onLane.y) < .05, `car ${car.id} sits ${(car.position.y - onLane.y).toFixed(2)} m off the road`);
    assert.ok(near.distance <= car.kind.halfWidth + 3.25, `car ${car.id} slid ${near.distance.toFixed(1)} m from its lane`);
  }
});

test('a knocked highway car stays between the median and the guardrail', () => {
  const road = new HighwayRoad(2), player = { s: 120, lat: laneCentre(1), x: 0, y: 0, z: 0, along: 0 };
  const traffic = new HighwayTraffic(road, { seed: 2, mode: 'cruise', traffic: { density: 14, speedKph: 105 } }, player);
  const near = traffic.cars.filter(car => car.active).slice(0, 10);
  // Shove each one hard towards the guardrail (or the median) by faking its stand-in's state after a hit.
  for (const [k, car] of near.entries()) {
    const out = k % 2 ? 1 : -1, rx = -Math.cos(car.yaw) * out, rz = Math.sin(car.yaw) * out;
    Object.assign(player, { x: car.x, y: car.y, z: car.z });
    const host = { setObstacle() {}, obstacleState: () => ({ p: { x: car.x, y: car.y, z: car.z }, q: { x: 0, y: Math.sin(car.yaw / 2), z: 0, w: Math.cos(car.yaw / 2) }, v: { x: rx * 25, y: 0, z: rz * 25 }, w: { x: 0, y: 1, z: 0 } }) };
    car.solid = true;
    traffic.step(host, { ...player, s: car.s, lat: car.lat }, { x: 0, y: 0, z: 0 }, 0);
  }
  const host = { setObstacle() {}, obstacleState: () => undefined };
  for (let i = 0; i < 300; i++) traffic.step(host, { ...player, s: 120, x: 1e6, z: 1e6 }, { x: 0, y: 0, z: 0 }, 0);
  for (const car of near) {
    if (!car.wreck) continue;
    const at = road.project(car.x, car.z, car.s, 30), sample = road.at(at.s);
    assert.ok(Math.abs(at.lat) < RAIL && Math.abs(at.lat) > .3, `car ${car.id} slid to lat ${at.lat.toFixed(2)}`);
    assert.ok(Math.abs(car.y - (sample.y + sample.bank * at.lat)) < .05, `car ${car.id} is off the road surface`);
  }
});
