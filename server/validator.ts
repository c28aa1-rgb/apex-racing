import { Worker } from 'node:worker_threads';
import type { Run, ReplayResult } from '../shared/replay';

type Job = { run: Run; resolve: (value: ReplayResult) => void; reject: (e: Error) => void };
export class ValidationQueue {
  private worker?: Worker; private queue: Job[] = []; private active?: Job;
  private timer?: ReturnType<typeof setTimeout>; private closed = false;
  constructor(private workerUrl = new URL('./validation-worker.mjs', import.meta.url)) {}
  validate(run: Run): Promise<ReplayResult> {
    if (this.closed || this.queue.length >= 6) return Promise.reject(new Error('Validation is busy. Try again shortly.'));
    return new Promise((resolve, reject) => { this.queue.push({ run, resolve, reject }); this.pump(); });
  }
  private pump() {
    if (this.closed || this.active || !this.queue.length) return;
    if (!this.worker) {
      this.worker = new Worker(this.workerUrl);
      this.worker.on('message', message => {
        clearTimeout(this.timer);
        const job = this.active; this.active = undefined;
        if (message.ok) job?.resolve(message.result); else job?.reject(new Error(message.error));
        this.pump();
      });
      this.worker.on('error', error => this.fail(error));
    }
    this.active = this.queue.shift();
    this.timer = setTimeout(() => this.fail(new Error('Replay validation timed out. Try again.')), 20000);
    this.worker.postMessage(this.active!.run);
  }
  private fail(error: Error) {
    clearTimeout(this.timer);
    this.active?.reject(error); this.active = undefined;
    const old = this.worker; this.worker = undefined;
    old?.removeAllListeners(); void old?.terminate(); this.pump();
  }
  async close() {
    this.closed = true; clearTimeout(this.timer);
    this.active?.reject(new Error('Server shutting down.'));
    this.queue.forEach(job => job.reject(new Error('Server shutting down.')));
    this.queue = []; await this.worker?.terminate();
  }
}
