import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { TRACKS, trackById } from '../shared/tracks';
import { runSchema, type Run, type ReplayResult } from '../shared/replay';
import { PHYSICS_VERSION } from '../shared/physics';
import { Store } from './store';
import { registerParties } from './parties';

const nicknameSchema = z.object({ nickname: z.string().trim().min(2).max(18).regex(/^[\p{L}\p{N} _-]+$/u, 'Use letters, numbers, spaces, underscores or hyphens.') }).strict();
const pointSchema = z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() }).strict();
const placementSchema = z.object({ position: pointSchema, heading: z.number().finite() }).strict();
const mapPointSchema = z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() }).strict();
const cockpitOffsetSchema = z.object({ x: z.number().finite().min(-3).max(3), y: z.number().finite().min(-3).max(3), z: z.number().finite().min(-3).max(3), reference:z.literal('driver-seat').optional() }).strict();
const circuitConfigSchema = z.object({
  starts: z.record(z.string(), placementSchema), finishes: z.record(z.string(), placementSchema),
  roads: z.record(z.string(), z.record(z.string(), z.number().finite().min(3).max(100))),
  maps: z.record(z.string(), z.array(mapPointSchema).min(2).max(4000)),
  cockpits: z.record(z.string(), cockpitOffsetSchema),
  checkpoints:z.record(z.string(),z.array(placementSchema).min(1).max(200)).optional()
}).strict();
export async function createApp(store: Store, validate: (run: Run) => Promise<ReplayResult>, logger = false) {
  const app = Fastify({ logger, bodyLimit: 100000 });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: error.issues[0]?.message ?? 'Invalid request.' });
    const err = error as Error & { statusCode?: number };
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    app.log.error(error); return reply.code(500).send({ error: 'Leaderboard unavailable. Your best run stays on this device.' });
  });
  app.get('/api/health', async () => { await store.query('SELECT 1'); return { ok: true, physicsVersion: PHYSICS_VERSION }; });
  app.get('/api/tracks', async () => ({ tracks: TRACKS.map(({ id, version, name, medals }) => ({ id, version, name, medals })), physicsVersion: PHYSICS_VERSION }));
  app.get('/api/dev-circuit-config', async () => store.circuitConfig());
  // Recorded minimap routes grow with every circuit; the default 100 kB limit silently rejected new recordings.
  app.put('/api/dev-circuit-config', { bodyLimit: 4_000_000 }, async (request, reply) => {
    // Shared sessions (HOST=0.0.0.0) set this so visitors cannot overwrite the recorded circuits.
    if (process.env.DISABLE_DEV_API === '1') return reply.code(403).send({ error: 'The circuit editor is disabled on this server.' });
    return store.saveCircuitConfig(circuitConfigSchema.parse(request.body));
  });
  app.post('/api/players', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { nickname } = nicknameSchema.parse(request.body);
    return reply.code(201).send(await store.createPlayer(nickname));
  });
  const authenticate = async (authorization?: string) => {
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!/^[a-f0-9]{64}$/.test(token)) return undefined;
    return store.player(token);
  };
  app.put('/api/players/me', async (request, reply) => {
    const player = await authenticate(request.headers.authorization);
    if (!player) return reply.code(401).send({ error: 'Player session expired. Set your nickname again.' });
    const { nickname } = nicknameSchema.parse(request.body); await store.rename(player.id, nickname);
    return { id: player.id, nickname };
  });
  app.get('/api/leaderboards/:trackId', async (request, reply) => {
    const { trackId } = request.params as { trackId: string }, track = trackById(trackId);
    if (!track) return reply.code(404).send({ error: 'Track not found.' });
    reply.header('Cache-Control', 'no-store');
    return { entries: await store.leaderboard(trackId, track.version) };
  });
  // A maximum-length run now includes both key bits and steering samples.
  app.post('/api/runs', { bodyLimit: 512000, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const player = await authenticate(request.headers.authorization);
    if (!player) return reply.code(401).send({ error: 'Player session expired. Set your nickname again.' });
    const run = runSchema.parse(request.body);
    try {
      const result = await validate(run);
      const saved = await store.save(player.id, { ...run, timeMs: result.timeMs });
      return reply.code(201).send({ ...saved, timeMs: result.timeMs, entries: await store.leaderboard(run.trackId, run.trackVersion) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Replay could not be validated.';
      const busy = /busy|timed out|shutting down/.test(message);
      return reply.code(busy ? 503 : 422).send({ error: message });
    }
  });
  app.get('/api/replays/:id', async (request, reply) => {
    const id = z.uuid().parse((request.params as { id: string }).id);
    const replay = await store.replay(id);
    if (!replay) return reply.code(404).send({ error: 'Replay not found.' });
    return replay;
  });
  await registerParties(app, store);
  return app;
}
