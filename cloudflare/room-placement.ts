import { z } from 'zod';

const hintSchema = z.enum(['wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'apac-ne', 'apac-se', 'oc', 'afr', 'me']);
export function roomLocationHint(value?: string) {
  if (!value || value === 'auto') return undefined;
  const hint = hintSchema.safeParse(value);
  if (!hint.success) throw Object.assign(new Error('Invalid RACE_ROOM_LOCATION_HINT.'), { statusCode: 503 });
  return hint.data;
}
