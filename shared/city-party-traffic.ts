import * as THREE from 'three';
import { CITY_ROADS, CITY_SIGNAL_POLES } from './city.data';
import { TrafficSim, type SimKind } from './city-traffic-sim';
import { RACE_TRAFFIC_KINDS } from './race-traffic';

/**
 * A city party's traffic, run by the party server while two or more drivers are in the city together, so they all
 * meet the same cars. Each driver's pose (sent to the room anyway) makes them a driver the traffic reacts to; each
 * driver gets the cars near them and the signal states, about ten times a second; a knock a driver's game reports is
 * applied here for everyone. With one driver left the server hands the traffic back to that driver's game.
 *
 * Kinds are in the order of RACE_TRAFFIC_KINDS on both sides; the game maps them to its models by name.
 */
export const PARTY_TRAFFIC_KINDS: SimKind[] = RACE_TRAFFIC_KINDS.map(kind => ({
  name: kind.id, weight: kind.weight, front: kind.front, rear: kind.rear, halfWidth: kind.widthM / 2, wheelbase: 2.7, radius: .33,
  body: { widthM: kind.widthM, heightM: kind.heightM, lengthM: kind.lengthM, massKg: kind.massKg },
}));
/** How far around each driver cars are sent (m), how often (ms), and how long a driver may go silent (ms). */
export const TRAFFIC_RANGE = 320, TRAFFIC_PACKET_MS = 95, TRAFFIC_QUIET_MS = 4000;
/** How far around a driver traffic counts as in view (cars appear and leave only beyond it). */
const IN_VIEW = 380;

export type TrafficKnock = { id: number; p: { x: number; z: number }; q: { x: number; y: number; z: number; w: number }; v: { x: number; z: number }; w: { y: number } };
type Seat = { position: THREE.Vector3; velocity: THREE.Vector3; at: number; sentAt: number };

export class PartyTraffic {
  readonly sim = new TrafficSim(CITY_ROADS, CITY_SIGNAL_POLES, PARTY_TRAFFIC_KINDS);
  private seats = new Map<string, Seat>();
  private last = 0;
  private populated = false;

  constructor(private now = Date.now) {
    this.sim.seen = at => [...this.seats.values()].some(seat => seat.position.distanceTo(at) < IN_VIEW);
  }
  /** A driver's latest pose (position, velocity), on arrival. */
  drive(id: string, p: { x: number; y: number; z: number }, v?: { x: number; y: number; z: number }) {
    const seat = this.seats.get(id) ?? { position: new THREE.Vector3(), velocity: new THREE.Vector3(), at: 0, sentAt: 0 };
    seat.position.set(p.x, p.y, p.z); seat.velocity.set(v?.x ?? 0, v?.y ?? 0, v?.z ?? 0); seat.at = this.now();
    this.seats.set(id, seat);
  }
  leave(id: string) { this.seats.delete(id); }
  /** Drivers heard from recently. */
  get active() { const now = this.now(); return [...this.seats.values()].filter(seat => now - seat.at < TRAFFIC_QUIET_MS).length; }
  /**
   * Starts from a driver's own traffic around them (so their screen does not change when the server takes over),
   * then fills the rest of the city out of everyone's view.
   */
  start(seed: number[][] = []) {
    if (this.populated) return;
    this.populated = true;
    for (const record of seed.slice(0, MAX_SEED)) this.sim.apply(record);
    this.sim.populate(this.drivers());
  }
  get started() { return this.populated; }
  /** Moves the traffic on to now (called on a timer, 20 times a second). */
  step() {
    const now = this.now(), dt = this.last ? (now - this.last) / 1000 : 0; this.last = now;
    if (!this.populated) return;
    // Long gaps (a server hiccup, nobody driving) are not caught up all at once.
    this.sim.step(Math.min(dt, .1), this.drivers());
  }
  knock(event: TrafficKnock) {
    const car = this.sim.byId(event.id);
    if (car && [...this.seats.values()].some(seat => seat.position.distanceTo(car.position) < 30)) this.sim.applyKnock(car, event);
  }
  /** The update for one driver, if one is due: cars within range of them and the signals; undefined if not due. */
  packet(id: string, force = false) {
    const seat = this.seats.get(id), now = this.now();
    if (!seat || !this.populated || (!force && now - seat.sentAt < TRAFFIC_PACKET_MS)) return undefined;
    seat.sentAt = now;
    const cars = this.sim.cars.filter(car => car.position.distanceTo(seat.position) < TRAFFIC_RANGE).map(car => this.sim.record(car));
    return { at: now, cars, signals: this.sim.signalRecord() };
  }
  /** The last update to the driver left alone: everything near them, and the end of following the server. */
  handoff(id: string) { const packet = this.packet(id, true); return packet ? { ...packet, handoff: true } : undefined; }
  private drivers() { return [...this.seats.values()].map(seat => ({ position: seat.position, velocity: seat.velocity })); }
}
/** Most cars a driver's game may hand the server to start from. */
export const MAX_SEED = 80;
