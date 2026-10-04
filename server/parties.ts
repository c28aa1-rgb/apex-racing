import type { FastifyInstance } from 'fastify';
import type { Store } from './store';
import type { PartyMember } from '../shared/party';
import { Parties, settingsSchema, carSchema, createSchema, joinSchema, updateSchema } from '../shared/party-room';
export { Parties, PARTY_PRESENCE_MS } from '../shared/party-room';
type Identity = Pick<PartyMember, 'id' | 'nickname'>;
type CircuitConfig = Parameters<Parties['start']>[1];

export async function registerParties(app: FastifyInstance, store: Store, parties = new Parties()) {
  const cleanup = setInterval(() => parties.sweep(), 30_000); cleanup.unref();
  app.addHook('onClose', async () => { clearInterval(cleanup); });
  await app.register(async routes => {
    routes.addHook('preHandler', async (request, reply) => {
      const token = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
      const player = /^[a-f0-9]{64}$/.test(token) ? await store.player(token) : undefined;
      if (!player) return reply.code(401).send({ error: 'Player session expired. Set your nickname again.' });
      // Store the verified identity on the request, never trust IDs in a payload.
      request.partyPlayer = player;
      reply.header('Cache-Control', 'no-store');
    });
    routes.decorateRequest('partyPlayer', null);
    const config = { rateLimit: { max: 90, timeWindow: '1 minute', keyGenerator: (request: { headers: { authorization?: string }; ip: string }) => request.headers.authorization ?? request.ip } };
    routes.get('/api/parties/current', { config }, async request => ({ lobby: parties.current(request.partyPlayer!) }));
    routes.post('/api/parties', { config }, async (request, reply) => {
      const { carId, settings } = createSchema.parse(request.body);
      return reply.code(201).send({ lobby: parties.create(request.partyPlayer!, carId, settings) });
    });
    routes.post('/api/parties/join', { config }, async request => {
      const { code, carId } = joinSchema.parse(request.body);
      return { lobby: parties.join(request.partyPlayer!, code, carId) };
    });
    routes.patch('/api/parties/me', { config }, async request => ({ lobby: parties.car(request.partyPlayer!, carSchema.parse(request.body).carId) }));
    routes.patch('/api/parties/settings', { config }, async request => ({ lobby: parties.settings(request.partyPlayer!, settingsSchema.partial().parse(request.body)) }));
    routes.delete('/api/parties/me', { config }, async request => { parties.leave(request.partyPlayer!); return { lobby: null }; });
    routes.post('/api/parties/start', { config }, async request => ({ lobby: parties.start(request.partyPlayer!, await store.circuitConfig() as CircuitConfig) }));
    routes.post('/api/parties/reopen', { config }, async request => ({ lobby: parties.reopen(request.partyPlayer!) }));
    routes.post('/api/parties/race', { config: { rateLimit: { ...config.rateLimit, max: 1500 } }, bodyLimit: 2048 }, async request => {
      const update = updateSchema.parse(request.body);
      return parties.update(request.partyPlayer!, update.raceId, update.ready, update.pose);
    });
  });
}

declare module 'fastify' {
  interface FastifyRequest { partyPlayer: Identity | null }
}
