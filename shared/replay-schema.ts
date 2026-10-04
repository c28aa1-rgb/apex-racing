import { z } from 'zod';
import { DT, MAX_TICKS, PHYSICS_VERSION } from './physics-version';
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
