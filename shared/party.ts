import type { CarId } from './cars';
import type { Gate, Vec3, Quat } from './tracks';

/**
 * t is when the pose was taken, on the server's clock as the sender estimates it (both drivers share it, so each
 * can place the other car at the same moment); best is the sender's fastest completed lap in ms.
 */
export type PartyPose = { sequence: number; p: Vec3; q: Quat; v?: Vec3; lap: number; checkpoint: number; finished: boolean; t?: number; best?: number;
  /** Endless Highway: distance along the road (p is then absolute, not the sender's shifted physics frame). */
  s?: number };
/** away: in the public city, off racing a street race on their own; hidden and not solid until they come back. */
export type PartyRacer = PartyMember & { slot: number; ready: boolean; pose?: PartyPose; finishedAt?: number; disconnected?: boolean; away?: boolean };
export type PartyRace = {
  id: string; createdAt: number; startAt: number | null; ended: boolean;
  grid: Gate[]; checkpoints: Gate[]; finish: Gate; racers: PartyRacer[];
};

export const PARTY_WEATHER = ['clear', 'rain', 'snow', 'fog'] as const;
export type PartyWeather = typeof PARTY_WEATHER[number];
/** A highway party's traffic, set by the host: cars per km each way and their average speed (as Cruise). */
export type PartyHighwayTraffic = { density: number; speedKph: number };
export type PartySettings = { trackId: string; weather: PartyWeather; laps: number; maxPlayers: number; traffic?: PartyHighwayTraffic };
export type PartyMember = { id: string; nickname: string; carId: CarId };
export type PartyLobby = {
  code: string;
  hostId: string;
  revision: number;
  settings: PartySettings;
  members: PartyMember[];
  race?: PartyRace;
  /** The public city: anyone driving into Racing City lands here. No host controls; it runs while anyone is in it. */
  public?: boolean;
};
/** removed: this player was just removed from their lobby by its host (said once, when their lobby disappears). */
export type PartyResponse = { lobby: PartyLobby | null; removed?: boolean };
export const DEFAULT_PARTY_SETTINGS: PartySettings = { trackId: 'bugatti', weather: 'clear', laps: 3, maxPlayers: 4 };
/** A city party: free roam together in Racing City (no laps or finish; friends can join while it runs). */
export const CITY_PARTY_TRACK = 'racing-city';
export const isCityParty = (settings: Pick<PartySettings, 'trackId'>) => settings.trackId === CITY_PARTY_TRACK;
/**
 * A highway party: Cruise on the Endless Highway together. Like a city party there are no laps or finish and friends
 * join while it runs; the road comes from the session's id (the same on every screen), and each screen runs its own
 * traffic from it with the host's settings.
 */
export const HIGHWAY_PARTY_TRACK = 'highway';
export const isHighwayParty = (settings: Pick<PartySettings, 'trackId'>) => settings.trackId === HIGHWAY_PARTY_TRACK;
/** Free roam together (the city or the highway): no laps, no finish, open to friends while it runs. */
export const isRoamParty = (settings: Pick<PartySettings, 'trackId'>) => isCityParty(settings) || isHighwayParty(settings);
/** The highway's seed for a party session: from its id, so every driver builds the same road. */
export function highwayPartySeed(raceId: string) {
  let h = 2166136261; for (let i = 0; i < raceId.length; i++) { h ^= raceId.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 2147483647;
}
/**
 * The public city's rooms, filled in order: everyone entering Racing City joins the first with a free place. Codes use
 * the lobby alphabet (no I, O, 0 or 1), so they also work typed into Join a lobby.
 */
export const PUBLIC_CITY_CODES = Array.from('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', c => `PUBLC${c}`);
export const isPublicCityCode = (code: string) => code.length === 6 && code.startsWith('PUBLC');
/** A city party's traffic update for one driver (see shared/city-party-traffic.ts and CityTraffic.follow). */
export type PartyTrafficPacket = { at: number; cars: number[][]; signals: number[]; handoff?: boolean; seed?: boolean };
