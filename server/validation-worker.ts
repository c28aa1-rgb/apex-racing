import { parentPort } from 'node:worker_threads';
import { validateReplay } from '../shared/replay';
parentPort!.on('message', async run => {
  try { parentPort!.postMessage({ ok: true, result: await validateReplay(run) }); }
  catch (error) { parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : 'Invalid replay.' }); }
});
