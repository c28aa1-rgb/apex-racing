import { resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import staticFiles from '@fastify/static';
import { Store } from './store';
import { createApp } from './app';
import { ValidationQueue } from './validator';

const dbPath = resolve(process.env.DATA_DIR ?? 'work/leaderboard-db');
if (!process.env.DATABASE_URL) mkdirSync(dbPath, { recursive: true });
const store = new Store(process.env.DATABASE_URL, dbPath);
await store.init();
const validator = new ValidationQueue();
const app = await createApp(store, run => validator.validate(run), true);
const dist = resolve('dist');
if (existsSync(dist)) {
  // design/compress-dist.ts writes .gz copies of the large runtime files during npm run build.
  await app.register(staticFiles, { root: dist, prefix: '/', preCompressed: true });
  app.get('/dev',(_request,reply)=>reply.sendFile('index.html'));
}
app.addHook('onClose', async () => { await validator.close(); await store.close(); });
await app.listen({ port: Number(process.env.PORT ?? 3001), host: process.env.HOST ?? '127.0.0.1' });
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await app.close(); process.exit(0); });
