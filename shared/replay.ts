import { z } from 'zod';
import { DT, initPhysics, MAX_TICKS, PHYSICS_VERSION, Simulation, type Frame } from './physics';
import { trackById } from './tracks';
import { CAR_IDS } from './cars';

export const runSchema = z.object({
  trackId: z.string().max(40), trackVersion: z.number().int(), physicsVersion: z.literal(PHYSICS_VERSION),
  carId: z.enum(CAR_IDS),
  timeMs: z.number().int().positive().max(Math.round(MAX_TICKS * DT * 1000)),
  inputs: z.array(z.number().int().min(0).max(511)).min(1).max(MAX_TICKS),
  manual:z.boolean().optional(),
  origin: z.object({ x: z.number().finite(), z: z.number().finite(), heading: z.number().min(-7).max(7) }).strict().optional(),
  steering: z.array(z.number().min(.7).max(2)).min(1).max(MAX_TICKS).optional(),
  drift: z.array(z.number().min(0).max(2)).min(1).max(MAX_TICKS).optional()
}).strict().refine(run=>!run.steering||run.steering.length===run.inputs.length,{message:'Steering samples must match the input count.'}).refine(run=>!run.drift||run.drift.length===run.inputs.length,{message:'Drift samples must match the input count.'});
export type Run = z.infer<typeof runSchema>;
export type ReplayResult = { timeMs: number; ticks: number; checkpoints: number; respawns: number; frames?: Frame[] };

/** Reproduce live tuner changes as well as keys, on both server and browser. */
export function stepReplay(sim: Simulation, run: Run) {
  sim.manual=run.manual??false;
  sim.steeringStrength=run.steering?.[sim.ticks]??1;
  sim.driftStrength=run.drift?.[sim.ticks]??1;
  sim.step(run.inputs[sim.ticks]??0);
}

export async function validateReplay(value: unknown, captureFrames = false): Promise<ReplayResult> {
  const run = runSchema.parse(value), track = trackById(run.trackId);
  if (!track || track.version !== run.trackVersion) throw new Error('Track version is no longer supported. Start a new run.');
  await initPhysics(track);
  if (run.origin) {
    // A custom start is only legal inside the Cone Attack start box.
    const zone = track.lot?.startZone;
    if (track.kind !== 'cones' || !zone || Math.abs(run.origin.x - zone.x) > zone.w / 2 || Math.abs(run.origin.z - zone.z) > zone.l / 2) throw new Error('The run does not start inside the start box.');
  }
  const sim = new Simulation(track, run.carId, run.origin);
  const frames: Frame[] = [];
  try {
    if (captureFrames) frames.push(sim.frame());
    for (let i = 0; i < run.inputs.length; i++) {
      stepReplay(sim,run);
      if (captureFrames) frames.push(sim.frame());
      if (sim.finished && i !== run.inputs.length - 1) throw new Error('Replay contains inputs after the finish.');
    }
    if (!sim.finished) throw new Error('Replay did not complete every checkpoint and finish.');
    if (sim.timeMs !== run.timeMs) throw new Error('Submitted time does not match the replay.');
    return { timeMs: sim.timeMs, ticks: sim.ticks, checkpoints: sim.checkpoint, respawns: sim.respawns, ...(captureFrames ? { frames } : {}) };
  } finally { sim.dispose(); }
}
