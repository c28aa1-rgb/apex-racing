const env = import.meta.env ?? {};
export const MULTIPLAYER_BACKEND = env.VITE_MULTIPLAYER_BACKEND ?? 'node';
if (!['node', 'cloudflare'].includes(MULTIPLAYER_BACKEND)) throw new Error('VITE_MULTIPLAYER_BACKEND must be node or cloudflare.');
export const MULTIPLAYER_URL = (env.VITE_MULTIPLAYER_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
export const API_URL = (env.VITE_API_URL ?? '').replace(/\/$/, '');
export function multiplayerUrl(path: string) {
  const url = new URL(path, `${MULTIPLAYER_URL}/`);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Multiplayer URL must use http:// or https://.');
  if (typeof location !== 'undefined' && location.protocol === 'https:' && url.protocol !== 'https:') throw new Error('Production multiplayer requires https:// and wss://.');
  return url;
}
