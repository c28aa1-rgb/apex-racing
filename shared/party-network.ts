export const PARTY_POSE_HZ = 30;
export const PARTY_POSE_INTERVAL_MS = 1000 / PARTY_POSE_HZ;
export const PARTY_MAX_IN_FLIGHT = 6;
export const PARTY_MESSAGES_PER_SECOND = 40;
export const PARTY_BROADCAST_MS = 10;
/** City party: poses go out this often while no other driver is near, and at the full rate when one is. */
export const PARTY_ROAM_POSE_HZ = 15;
/** Another driver this close (m), or this close in time at the speed you are closing (s), means full-rate poses. */
export const PARTY_CLOSE_M = 45, PARTY_CLOSE_S = 2.5;
/** The party server moves city traffic on this often (ms). */
export const PARTY_TRAFFIC_TICK_MS = 50;
/** Largest message a driver may send (a city party's first traffic update carries the cars around them). */
export const PARTY_MESSAGE_BYTES = 6144;
