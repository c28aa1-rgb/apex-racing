import { read } from './storage';
import {DEFAULT_BINDINGS,loadBindings} from './controls';
import {GRAPHICS_PRESETS,isPreset,sanitizeGraphics,type GraphicsOptions,type GraphicsQuality} from './graphics';
import {CAMERA_MODES,type CameraMode} from './camera-modes';
export type {GraphicsQuality} from './graphics';
export type WeatherPreset='clear'|'rain'|'snow'|'fog';
export const DEFAULT_SETTINGS={graphicsQuality:'balanced' as GraphicsQuality,graphics:{...GRAPHICS_PRESETS.balanced} as GraphicsOptions,weather:'clear' as WeatherPreset,volume:.55,engineVolume:.8,effectsVolume:.4,musicVolume:.5,sensitivity:1,pointerLock:true,reducedMotion:false,skidMarks:true,carDamage:true,showFps:false,advancedDriving:false,bindings:DEFAULT_BINDINGS,
  cameraMode:'chase' as CameraMode,cameraFov:58,cameraDistance:1,cameraShake:true,cameraRecenter:true};
export type Settings=typeof DEFAULT_SETTINGS;
export function loadSettings(): Settings {
  const stored=read<Partial<Settings>>('settings',{}),settings={...DEFAULT_SETTINGS};
  for(const key of ['volume','engineVolume','effectsVolume','musicVolume','sensitivity'] as const){const value=stored[key];if(typeof value==='number'&&Number.isFinite(value))settings[key]=Math.max(key==='sensitivity'?.25:0,Math.min(key==='sensitivity'?2.5:1,value));}
  for(const key of ['pointerLock','reducedMotion','skidMarks','carDamage','advancedDriving','showFps','cameraShake','cameraRecenter'] as const)if(typeof stored[key]==='boolean')settings[key]=stored[key]!;
  if(CAMERA_MODES.includes(stored.cameraMode as CameraMode))settings.cameraMode=stored.cameraMode!;
  if(typeof stored.cameraFov==='number'&&Number.isFinite(stored.cameraFov))settings.cameraFov=Math.max(45,Math.min(80,stored.cameraFov));
  if(typeof stored.cameraDistance==='number'&&Number.isFinite(stored.cameraDistance))settings.cameraDistance=Math.max(.6,Math.min(1.8,stored.cameraDistance));
  settings.bindings=loadBindings(stored.bindings);
  if(stored.weather&&['clear','rain','snow','fog'].includes(stored.weather))settings.weather=stored.weather;
  // A named preset always uses the current preset values; only Custom keeps its own stored numbers.
  if(isPreset(stored.graphicsQuality)){settings.graphicsQuality=stored.graphicsQuality;settings.graphics={...GRAPHICS_PRESETS[stored.graphicsQuality]};}
  else if(stored.graphicsQuality==='custom'){settings.graphicsQuality='custom';settings.graphics=sanitizeGraphics(stored.graphics,GRAPHICS_PRESETS.balanced);}
  return settings;
}
