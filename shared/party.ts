import type { CarId } from './cars';
import type { Gate, Vec3, Quat } from './tracks';

/**
 * t is when the pose was taken, on the server's clock as the sender estimates it (both drivers share it, so each
 * can place the other car at the same moment); best is the sender's fastest completed lap in ms.
 */
export type PartyPose = { sequence: number; p: Vec3; q: Quat; lap: number; checkpoint: number; finished: boolean; t?: number; best?: number };
export type PartyRacer = PartyMember & { slot: number; ready: boolean; pose?: PartyPose; finishedAt?: number; disconnected?: boolean };
export type PartyRace = {
  id: string; createdAt: number; startAt: number | null; ended: boolean;
  grid: Gate[]; checkpoints: Gate[]; finish: Gate; racers: PartyRacer[];
};

export const PARTY_WEATHER = ['clear', 'rain', 'snow', 'fog'] as const;
export type PartyWeather = typeof PARTY_WEATHER[number];
export type PartySettings = { trackId: string; weather: PartyWeather; laps: number; maxPlayers: number };
export type PartyMember = { id: string; nickname: string; carId: CarId };
export type PartyLobby = {
  code: string;
  hostId: string;
  revision: number;
  settings: PartySettings;
  members: PartyMember[];
  race?: PartyRace;
};
export type PartyResponse = { lobby: PartyLobby | null };
export const DEFAULT_PARTY_SETTINGS: PartySettings = { trackId: 'bugatti', weather: 'clear', laps: 3, maxPlayers: 4 };
