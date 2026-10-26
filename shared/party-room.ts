import { z } from 'zod';
import { CAR_IDS, type CarId } from './cars';
import { CITY, trackById, placementGate, type Vec3 } from './tracks';
import { CITY_PARTY_TRACK, DEFAULT_PARTY_SETTINGS, PARTY_WEATHER, isCityParty, type PartyLobby, type PartyMember, type PartySettings, type PartyPose, type PartyTrafficPacket } from './party';
import { PARTY_GRIDS } from './party-grids';
import { PartyTraffic, MAX_SEED, type TrafficKnock } from './city-party-traffic';

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const PARTY_PRESENCE_MS = 120_000;
export const settingsSchema = z.object({
  trackId: z.string().refine(id => id === CITY_PARTY_TRACK || Boolean(trackById(id) && !trackById(id)!.lot && !trackById(id)!.street), 'Choose an available circuit.'),
  weather: z.enum(PARTY_WEATHER),
  laps: z.number().int().min(1).max(99),
  maxPlayers: z.number().int().min(2).max(8),
}).strict();
export const carSchema = z.object({ carId: z.enum(CAR_IDS) }).strict();
export const createSchema = carSchema.extend({ settings: settingsSchema.partial().optional() });
const vector = z.object({ x: z.number().finite().min(-100000).max(100000), y: z.number().finite().min(-100000).max(100000), z: z.number().finite().min(-100000).max(100000) }).strict();
const poseSchema = z.object({ sequence: z.number().int().nonnegative(), t: z.number().finite().nonnegative().optional(), p: vector, q: vector.extend({ w: z.number().finite().min(-1).max(1) }).refine(q => Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1) < .02), v: vector.refine(v => Math.hypot(v.x, v.y, v.z) <= 1000, 'Invalid velocity.').optional(), lap: z.number().int().min(1).max(99), checkpoint: z.number().int().min(0).max(1000), finished: z.boolean(), best: z.number().int().positive().max(3_600_000).optional() }).strict();
const record = z.array(z.number().int().min(-10_000_000).max(10_000_000)).min(7).max(14);
const knockSchema = z.object({ id: z.number().int().nonnegative(), p: z.object({ x: z.number().finite(), z: z.number().finite() }).strict(),
  q: z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite(), w: z.number().finite() }).strict(),
  v: z.object({ x: z.number().finite().min(-200).max(200), z: z.number().finite().min(-200).max(200) }).strict(), w: z.object({ y: z.number().finite().min(-50).max(50) }).strict() }).strict();
/** City party: cars the driver knocked, and (when the server asked) the driver's own traffic to start from. */
const trafficSchema = z.object({ knocks: z.array(knockSchema).max(8).optional(), seed: z.array(record).max(MAX_SEED).optional() }).strict();
export const updateSchema = z.object({ raceId: z.string().uuid(), ready: z.boolean(), pose: poseSchema.optional(), traffic: trafficSchema.optional() }).strict();
/** Where a city party's drivers start: two columns on the acceleration strip by the city's spawn, 10 m apart. */
const CITY_GRID = Array.from({ length: 8 }, (_, i) => ({ position: { x: -703.5 + (i % 2) * 7, y: 0, z: -285 + Math.floor(i / 2) * 11 }, heading: 0 }));
/** A city party runs this long at most; races end after an hour. */
const CITY_PARTY_MS = 6 * 3_600_000;
type Placement = { position: Vec3; heading: number };
type CircuitConfig = { starts?: Record<string, Placement>; finishes?: Record<string, Placement>; checkpoints?: Record<string, Placement[]> };
export const kickSchema = z.object({ id: z.string().min(1).max(64) }).strict();
export const joinSchema = carSchema.extend({ code: z.string().trim().toUpperCase().regex(/^[A-HJ-NP-Z2-9]{6}$/, 'Enter the six-character lobby code.') });
type Identity = Pick<PartyMember, 'id' | 'nickname'>;
/**
 * A lobby as the server keeps it: when each member was last heard from, a city party's traffic while it runs, and
 * kicked: drivers the host removed, who may not rejoin this lobby. Server-side only, never in a snapshot.
 */
type LiveLobby = PartyLobby & { seen: Map<string, number>; traffic?: PartyTraffic; seedFrom?: string; seedAsked?: number; kicked?: string[] };
/** Drivers in a city party heard from this recently (ms) count as there: two or more run the server's traffic. */
const PRESENT_MS = 4000;
const fail = (statusCode: number, message: string): never => { throw Object.assign(new Error(message), { statusCode }); };

/** Parties are transient, server-owned sessions. Tokens never enter a public snapshot. */
export class Parties {
  private rooms = new Map<string, LiveLobby>();
  private membership = new Map<string, string>();
  constructor(private now = Date.now, private random = Math.random) {}
  /** Drivers removed by a host who have not yet been told (see takeRemovedNotice). */
  private removedNotices = new Set<string>();
  exportState() { return [...this.rooms.values()].map(room => ({ ...this.snapshot(room), seen: [...room.seen], kicked: room.kicked ?? [] })); }
  restoreState(state: ReturnType<Parties['exportState']>) {
    this.rooms.clear(); this.membership.clear();
    for (const saved of state) {
      this.rooms.set(saved.code, { ...structuredClone(saved), seen: new Map(saved.seen) });
      for (const member of saved.members) this.membership.set(member.id, saved.code);
    }
  }

  sweep() {
    for (const room of this.rooms.values()) {
      for (const [id, seen] of room.seen) if (this.now() - seen > PARTY_PRESENCE_MS) this.remove(room, id);
      const race = room.race;
      if (race && !race.ended) {
        for (const racer of race.racers) if (!racer.disconnected && this.now() - (room.seen.get(racer.id) ?? 0) > 20_000 && race.startAt) { racer.disconnected = true; room.revision++; }
        if ((!race.startAt && this.now() - race.createdAt > 180_000) || (race.startAt && (this.now() - race.startAt > (isCityParty(room.settings) ? CITY_PARTY_MS : 3_600_000) || race.racers.every(r => r.finishedAt || r.disconnected)))) { race.ended = true; room.revision++; }
      }
    }
  }
  /** Moves every city party's traffic on (the backends call this every PARTY_TRAFFIC_TICK_MS). */
  tick() {
    for (const room of this.rooms.values()) {
      if (!room.traffic) continue;
      if (!room.race || room.race.ended) { room.traffic = undefined; continue; }
      // Asked a driver for their traffic to start from and heard nothing back: start without it.
      if (!room.traffic.started && this.now() - (room.seedAsked ?? 0) > 1500) room.traffic.start();
      room.traffic.step();
    }
  }
  /** Whether any city party's traffic is running (a backend keeps its timer going only then). */
  get trafficRunning() { return [...this.rooms.values()].some(room => !!room.traffic); }
  private snapshot(room: LiveLobby): PartyLobby {
    return structuredClone({ code: room.code, hostId: room.hostId, revision: room.revision, settings: room.settings, members: room.members, ...(room.race ? { race: room.race } : {}) });
  }
  private room(id: string) {
    const code = this.membership.get(id);
    return code ? this.rooms.get(code) : undefined;
  }
  private touch(room: LiveLobby, player: Identity) {
    room.seen.set(player.id, this.now());
    const member = room.members.find(member => member.id === player.id)!;
    if (member.nickname !== player.nickname) { member.nickname = player.nickname; room.revision++; }
  }
  private remove(room: LiveLobby, id: string) {
    const racer = room.race?.racers.find(r => r.id === id); if (racer) racer.disconnected = true;
    room.traffic?.leave(id);
    room.members = room.members.filter(member => member.id !== id);
    room.seen.delete(id); this.membership.delete(id); room.revision++;
    if (!room.members.length) this.rooms.delete(room.code);
    else if (room.hostId === id) room.hostId = room.members[0].id;
  }
  current(player: Identity) {
    this.sweep();
    const room = this.room(player.id);
    if (!room) return null;
    this.touch(room, player);
    return this.snapshot(room);
  }
  create(player: Identity, carId: CarId, settings: Partial<PartySettings> = {}, roomCode?: string) {
    this.sweep();
    const current = this.room(player.id);
    if (current) return this.snapshot(current);
    if (this.rooms.size >= 1000) return fail(503, 'All lobbies are busy. Try again shortly.');
    if (roomCode && this.rooms.has(roomCode)) return fail(409, 'Lobby code collision. Try again.');
    let code: string;
    do { code = roomCode ?? Array.from({ length: 6 }, () => alphabet[crypto.getRandomValues(new Uint8Array(1))[0] % alphabet.length]).join(''); } while (this.rooms.has(code));
    const room: LiveLobby = { code, hostId: player.id, revision: 1, settings: { ...DEFAULT_PARTY_SETTINGS, ...settings }, members: [{ ...player, carId }], seen: new Map([[player.id, this.now()]]) };
    this.rooms.set(code, room); this.membership.set(player.id, code);
    return this.snapshot(room);
  }
  join(player: Identity, code: string, carId: CarId) {
    this.sweep();
    const room = this.rooms.get(code);
    if (!room) return fail(404, 'Lobby not found. Check the code with your host.');
    const current = this.room(player.id);
    if (current && current !== room) return fail(409, 'Leave your current lobby before joining another.');
    if (current === room) { this.touch(room, player); return this.snapshot(room); }
    if (room.kicked?.includes(player.id)) return fail(403, 'The host removed you from this lobby.');
    const joining = room.race && isCityParty(room.settings) && !room.race.ended;
    if (room.race && !joining) return fail(409, 'Race in progress. Wait for the host to reopen the lobby.');
    if (room.members.length >= room.settings.maxPlayers) return fail(409, 'This lobby is full. Ask the host to open another place.');
    room.members.push({ ...player, carId }); room.seen.set(player.id, this.now()); room.revision++;
    // A city party carries on while friends join: they start on a free place of the grid.
    if (joining) {
      const taken = new Set(room.race!.racers.filter(r => !r.disconnected).map(r => r.slot)), slot = [...Array(8).keys()].find(i => !taken.has(i)) ?? room.race!.racers.length % 8;
      room.race!.racers.push({ ...player, carId, slot, ready: false });
    }
    this.membership.set(player.id, code);
    return this.snapshot(room);
  }
  car(player: Identity, carId: CarId) {
    this.sweep();
    const room = this.room(player.id);
    if (!room) return fail(404, 'Your lobby has closed. Create or join a lobby.');
    if (room.race) return fail(409, 'Cars are locked during a race.');
    this.touch(room, player);
    const member = room.members.find(member => member.id === player.id)!;
    if (member.carId !== carId) { member.carId = carId; room.revision++; }
    return this.snapshot(room);
  }
  settings(player: Identity, patch: Partial<PartySettings>) {
    this.sweep();
    const room = this.room(player.id);
    if (!room) return fail(404, 'Your lobby has closed. Create or join a lobby.');
    if (room.hostId !== player.id) return fail(403, 'Only the host can change race settings.');
    if (room.race) return fail(409, 'Settings are locked during a race.');
    if (patch.maxPlayers !== undefined && patch.maxPlayers < room.members.length) return fail(409, 'Player limit cannot be lower than the current lineup.');
    this.touch(room, player);
    room.settings = { ...room.settings, ...patch }; room.revision++;
    return this.snapshot(room);
  }
  /** The host removes another driver between races; they are told once and may not rejoin this lobby. */
  kick(player: Identity, targetId: string) {
    this.sweep();
    const room = this.room(player.id);
    if (!room) return fail(404, 'Your lobby has closed. Create or join a lobby.');
    if (room.hostId !== player.id) return fail(403, 'Only the host can remove drivers.');
    if (targetId === player.id) return fail(400, 'Leave the lobby instead of removing yourself.');
    if (room.race) return fail(409, 'Drivers can be removed between races.');
    if (!room.members.some(member => member.id === targetId)) return fail(404, 'That driver has already left.');
    this.touch(room, player); this.remove(room, targetId);
    room.kicked = [...(room.kicked ?? []), targetId]; this.removedNotices.add(targetId);
    return this.snapshot(room);
  }
  /** True once for a driver whose host has just removed them, so their screen can say why their lobby went away. */
  takeRemovedNotice(id: string) { return this.removedNotices.delete(id) && !this.room(id); }
  leave(player: Identity) {
    const room = this.room(player.id);
    if (room) this.remove(room, player.id);
  }
  start(player: Identity, config: CircuitConfig) {
    const room = this.room(player.id);
    if (!room) return fail(404, 'Your lobby has closed.');
    if (room.hostId !== player.id) return fail(403, 'Only the host can start the race.');
    if (room.race) return this.snapshot(room);
    if (isCityParty(room.settings)) {
      const order = room.members.map((_, i) => i);
      room.race = { id: crypto.randomUUID(), createdAt: this.now(), startAt: null, ended: false, grid: CITY_GRID.map(p => placementGate(CITY, p)), checkpoints: [], finish: structuredClone(CITY.finish),
        racers: room.members.map((member, i) => ({ ...member, slot: order[i], ready: false })) };
      this.touch(room, player); room.revision++;
      return this.snapshot(room);
    }
    const track = trackById(room.settings.trackId)!, layout = PARTY_GRIDS[track.id as keyof typeof PARTY_GRIDS];
    const saved = config.starts?.[track.id];
    if (saved && (Math.hypot(saved.position.x - layout.anchor.position.x, saved.position.y - layout.anchor.position.y, saved.position.z - layout.anchor.position.z) > .1 || Math.abs(saved.heading - layout.anchor.heading) > .01)) return fail(409, 'This start position changed. Revalidate the eight grid slots before racing.');
    const order = room.members.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(this.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    room.race = { id: crypto.randomUUID(), createdAt: this.now(), startAt: null, ended: false,
      grid: layout.slots.map(p => placementGate(track, p)),
      checkpoints: config.checkpoints?.[track.id]?.length ? config.checkpoints[track.id].map(p => placementGate(track, p)) : structuredClone(track.checkpoints),
      finish: config.finishes?.[track.id] ? placementGate(track, config.finishes[track.id]) : structuredClone(track.finish),
      // Grid order is drawn at random each race, so the host (who joined first) does not always start on pole.
      racers: room.members.map((member, i) => ({ ...member, slot: order[i], ready: false })),
    };
    this.touch(room, player); room.revision++;
    return this.snapshot(room);
  }
  update(player: Identity, raceId: string, ready: boolean, pose?: PartyPose, traffic?: { knocks?: TrafficKnock[]; seed?: number[][] }) {
    this.sweep();
    const room = this.room(player.id), race = room?.race, city = !!room && isCityParty(room.settings);
    if (!room || !race || race.id !== raceId) return fail(409, 'Race session ended. Return to the lobby.');
    const racer = race.racers.find(r => r.id === player.id);
    // A driver who dropped out of a city party (a lost connection) simply comes back.
    if (racer?.disconnected && city && !race.ended) { racer.disconnected = false; racer.ready = false; room.revision++; }
    if (!racer || racer.disconnected) return fail(409, 'You are no longer in this race.');
    this.touch(room, player);
    if (ready && !racer.ready) { racer.ready = true; room.revision++; }
    // A city party has no lights: driving starts as soon as everyone has loaded.
    if (!race.ended && !race.startAt && race.racers.every(r => r.ready || r.disconnected)) { race.startAt = this.now() + (city ? 300 : 6500); room.revision++; }
    // ponytail: casual client-authoritative driving; never eligible for verified leaderboards.
    // After finishing, a driver keeps sending positions for a few seconds so others see the car roll on and fade out.
    const rolling = racer.finishedAt !== undefined && this.now() - racer.finishedAt < 8000 && !!pose?.finished;
    if (!race.ended && race.startAt && this.now() >= race.startAt && pose && (!racer.finishedAt || rolling) && pose.sequence > (racer.pose?.sequence ?? -1)) {
      if (pose.lap > room.settings.laps || pose.checkpoint > race.checkpoints.length || pose.lap < (racer.pose?.lap ?? 1) || pose.lap > (racer.pose?.lap ?? 1) + 1 || (pose.finished && pose.lap !== room.settings.laps)) return fail(400, 'Invalid race progress.');
      racer.pose = structuredClone(pose);
      if (pose.finished && racer.finishedAt === undefined) { racer.finishedAt = this.now(); room.revision++; }
    }
    if (race.racers.every(r => r.finishedAt || r.disconnected)) { race.ended = true; room.revision++; }
    const packet = city && !race.ended ? this.cityTraffic(room, player.id, ready ? pose : undefined, traffic) : undefined;
    return { race: structuredClone(race), serverNow: this.now(), ...(packet ? { traffic: packet } : {}) };
  }
  /**
   * A city party's traffic, as one driver's update reaches the server: run by the server while two or more drivers are
   * in the city, first from the traffic around the driver who was there (asked for once: `seed`), handed back to the
   * last driver left (`handoff`). Returns this driver's packet, when one is due.
   */
  private cityTraffic(room: LiveLobby, id: string, pose?: PartyPose, traffic?: { knocks?: TrafficKnock[]; seed?: number[][] }): PartyTrafficPacket | undefined {
    // Drivers still loading count too (placed at their grid place until they drive), so they arrive to the server's
    // traffic instead of seeing their own swapped for it.
    const race = room.race!, now = this.now(), present = race.racers.filter(r => !r.disconnected && now - (room.seen.get(r.id) ?? 0) < PRESENT_MS);
    const at = (r: typeof present[number]) => r.pose && now - (r.pose.t ?? now) < PRESENT_MS ? r.pose : { p: race.grid[r.slot]?.position ?? race.grid[0].position, v: undefined };
    if (!room.traffic && present.length >= 2) {
      room.traffic = new PartyTraffic(this.now);
      for (const r of present) room.traffic.drive(r.id, at(r).p, at(r).v);
      // The driver who has been here longest keeps their traffic: ask them for it.
      room.seedFrom = present.find(r => r.id !== id)?.id ?? id; room.seedAsked = now;
    }
    const running = room.traffic;
    if (!running) return undefined;
    const me = present.find(r => r.id === id);
    if (pose) running.drive(id, pose.p, pose.v); else if (me && !me.pose) running.drive(id, at(me).p);
    if (traffic?.seed && !running.started && id === room.seedFrom) running.start(traffic.seed);
    for (const knock of traffic?.knocks ?? []) running.knock(knock);
    if (!running.started) return id === room.seedFrom ? { at: now, cars: [], signals: [], seed: true } : undefined;
    if (present.length < 2) {
      // Down to one driver: they carry on with the traffic around them, run by their own game again.
      if (present.some(r => r.id === id) || present.length === 0) { room.traffic = undefined; return running.handoff(id); }
    }
    return running.packet(id);
  }
  reopen(player: Identity) {
    const room = this.room(player.id);
    if (!room) return fail(404, 'Your lobby has closed.');
    if (room.hostId !== player.id) return fail(403, 'Only the host can reopen the lobby.');
    delete room.race; room.revision++; this.touch(room, player);
    return this.snapshot(room);
  }
}
