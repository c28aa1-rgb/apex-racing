/** Every renderer knob the player can tune. A preset is just a named bundle of these. */
export interface GraphicsOptions {
  /** Render resolution as a multiple of CSS pixels, capped by the display's pixel ratio. */
  renderScale: number;
  /** Lower the resolution automatically when the frame rate falls short of targetFps. */
  adaptive: boolean;
  targetFps: 30 | 45 | 60;
  /** Shadow map size in pixels; 0 turns shadows off. */
  shadows: 0 | 512 | 1024 | 2048;
  bloom: boolean;
  /** Post-process edge smoothing (SMAA). */
  smoothing: boolean;
  anisotropy: 1 | 2 | 4 | 8 | 16;
  /** Metres at which clear-weather fog is complete; scenery beyond it is not drawn. */
  drawDistance: number;
  /** Metres beyond which far scenery uses simplified meshes; 0 keeps full detail everywhere. */
  lodDistance: number;
  /** Rain and snow particle amount, 0.1 to 1. */
  weatherDensity: number;
  /** Maximum rendered frames per second; 0 is unlimited. */
  fpsCap: 0 | 30 | 60 | 120;
}
export type GraphicsPreset = 'lowest' | 'performance' | 'balanced' | 'high' | 'cinematic';
export type GraphicsQuality = GraphicsPreset | 'custom';
export const GRAPHICS_PRESETS: Record<GraphicsPreset, GraphicsOptions> = {
  lowest: { renderScale: .6, adaptive: true, targetFps: 30, shadows: 0, bloom: false, smoothing: false, anisotropy: 1, drawDistance: 1400, lodDistance: 250, weatherDensity: .3, fpsCap: 0 },
  performance: { renderScale: .85, adaptive: true, targetFps: 60, shadows: 0, bloom: false, smoothing: false, anisotropy: 1, drawDistance: 1800, lodDistance: 350, weatherDensity: .5, fpsCap: 0 },
  balanced: { renderScale: 1, adaptive: true, targetFps: 60, shadows: 1024, bloom: false, smoothing: false, anisotropy: 2, drawDistance: 2600, lodDistance: 500, weatherDensity: .6, fpsCap: 0 },
  high: { renderScale: 1.25, adaptive: true, targetFps: 60, shadows: 2048, bloom: false, smoothing: true, anisotropy: 8, drawDistance: 3600, lodDistance: 800, weatherDensity: .8, fpsCap: 0 },
  cinematic: { renderScale: 1.25, adaptive: false, targetFps: 60, shadows: 2048, bloom: true, smoothing: true, anisotropy: 8, drawDistance: 5000, lodDistance: 0, weatherDensity: 1, fpsCap: 0 },
};
export const PRESET_LABELS: Record<GraphicsQuality, string> = { lowest: 'Lowest', performance: 'Fast', balanced: 'Normal', high: 'High', cinematic: 'Cinematic', custom: 'Custom' };
export const PRESET_HELP: Record<GraphicsPreset, string> = {
  lowest: 'For old laptops and integrated graphics. Low resolution, short view, no shadows.',
  performance: 'Smooth on most machines. No shadows, shorter view distance.',
  balanced: 'Default. Soft car shadows, medium view distance, resolution adapts to keep speed up.',
  high: 'Sharper image, longer view, edge smoothing. Needs a decent GPU.',
  cinematic: 'Everything on: bloom, full detail, long view. Expect lower frame rates.',
};
export const isPreset = (value: unknown): value is GraphicsPreset => typeof value === 'string' && value in GRAPHICS_PRESETS;
const pick = <T extends number>(value: unknown, allowed: readonly T[], fallback: T): T => allowed.includes(value as T) ? value as T : fallback;
const range = (value: unknown, min: number, max: number, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
/** Validates stored options field by field, falling back to `base` for anything missing or out of range. */
export function sanitizeGraphics(stored: Partial<GraphicsOptions> | undefined, base: GraphicsOptions): GraphicsOptions {
  const s = stored ?? {};
  return {
    renderScale: range(s.renderScale, .4, 2, base.renderScale),
    adaptive: typeof s.adaptive === 'boolean' ? s.adaptive : base.adaptive,
    targetFps: pick(s.targetFps, [30, 45, 60] as const, base.targetFps),
    shadows: pick(s.shadows, [0, 512, 1024, 2048] as const, base.shadows),
    bloom: typeof s.bloom === 'boolean' ? s.bloom : base.bloom,
    smoothing: typeof s.smoothing === 'boolean' ? s.smoothing : base.smoothing,
    anisotropy: pick(s.anisotropy, [1, 2, 4, 8, 16] as const, base.anisotropy),
    drawDistance: range(s.drawDistance, 800, 8000, base.drawDistance),
    lodDistance: s.lodDistance === 0 ? 0 : range(s.lodDistance, 150, 2000, base.lodDistance),
    weatherDensity: range(s.weatherDensity, .1, 1, base.weatherDensity),
    fpsCap: pick(s.fpsCap, [0, 30, 60, 120] as const, base.fpsCap),
  };
}
