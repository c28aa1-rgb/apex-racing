import * as THREE from 'three';

/**
 * Racing City's time of day: where the sun is at an hour (0-24) and how the city is lit then. A summer day: sunrise
 * at 6:00, noon sun 62° up at 13:00, sunset at 20:00, the sun 38° below the horizon at 1:00. The sun rises in the
 * east (+x), passes south (+z) and sets in the west.
 */
export const SUNRISE = 6, SUNSET = 20;
/** The hour the city opens at, as it was before time of day: late evening, lamps on. */
export const DEFAULT_CITY_HOUR = 22;
/** One game hour per real minute when the clock runs: a whole day in 24 minutes. */
export const CITY_HOURS_PER_SECOND = 1 / 60;

const smooth = (edge0: number, edge1: number, x: number) => { const t = THREE.MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1); return t * t * (3 - 2 * t); };
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** Colour keyframes by sun elevation (degrees): night blue, twilight, the orange of the sun on the horizon, day haze. */
const HORIZON: [number, number][] = [[-14, 0x070d1a], [-6, 0x1a2338], [-1, 0x5b5070], [2, 0xd9926a], [9, 0xe6c3a2], [22, 0xc4e1eb]];
const SUN: [number, number][] = [[0, 0xff7a3d], [6, 0xffa766], [20, 0xffe2bd], [40, 0xfff2dc]];
function ramp(keys: [number, number][], at: number, out: THREE.Color) {
  if (at <= keys[0][0]) return out.setHex(keys[0][1]);
  for (let i = 1; i < keys.length; i++) if (at <= keys[i][0]) return out.setHex(keys[i - 1][1]).lerp(new THREE.Color(keys[i][1]), (at - keys[i - 1][0]) / (keys[i][0] - keys[i - 1][0]));
  return out.setHex(keys[keys.length - 1][1]);
}

export type CityLight = {
  /** Sun elevation (degrees; negative below the horizon) and the direction towards it. */
  elevation: number; sun: THREE.Vector3;
  /** 0 at night to 1 in daylight. */
  day: number;
  /** Street lamps and lit windows, 0 off to 1 fully on. */
  lamps: number;
  /** The direct light: towards the sun by day, a dim blue moon at night. */
  light: { direction: THREE.Vector3; color: THREE.Color; intensity: number };
  /** Sky and fog colour (with the weather's own at full day), sky ambient, reflections and exposure. */
  horizon: THREE.Color; ambient: number; environment: number; exposure: number;
  /** The sky light's colour: warm while the sun is low, blue at night. */
  skyTint: THREE.Color;
  /** Whether the sky dome shows (the sun's own sky from just below the horizon up). */
  sky: boolean;
};

/** How the city is lit at this hour, for this weather's daytime sky colour, sun and ambient strength. */
export function cityLight(hour: number, weather: { color: number; sun: number; ambient: number }, clear: boolean): CityLight {
  const h = ((hour % 24) + 24) % 24;
  const dayFraction = (h - SUNRISE) / (SUNSET - SUNRISE), nightFraction = (((h - SUNSET) % 24) + 24) % 24 / (24 - SUNSET + SUNRISE);
  const elevation = h >= SUNRISE && h <= SUNSET ? 62 * Math.sin(Math.PI * dayFraction) : -38 * Math.sin(Math.PI * nightFraction);
  // Across the sky from east to west by day; round under the north by night.
  const around = h >= SUNRISE && h <= SUNSET ? Math.PI * dayFraction : Math.PI * (1 + nightFraction);
  const up = THREE.MathUtils.degToRad(elevation), sun = new THREE.Vector3(Math.cos(around) * Math.cos(up), Math.sin(up), Math.sin(around) * Math.cos(up) * .55 + .25 * Math.cos(up)).normalize();
  const day = smooth(-5, 10, elevation), lamps = 1 - smooth(-1, 7, elevation);
  const horizon = ramp(HORIZON, elevation, new THREE.Color());
  // By full day the weather's own sky colour takes over; under cloud (rain, snow, fog) it does from soon after dawn.
  horizon.lerp(new THREE.Color(weather.color), clear ? smooth(12, 30, elevation) : smooth(-4, 10, elevation) * .85);
  // The moon: high in the sky opposite the sun, dim and blue.
  const moon = new THREE.Vector3(-sun.x, Math.max(.55, -sun.y), -sun.z).normalize();
  const sunColor = ramp(SUN, elevation, new THREE.Color());
  return {
    elevation, sun, day, lamps, horizon,
    light: {
      direction: day > .02 ? sun : moon,
      color: day > .02 ? sunColor : new THREE.Color(0x8ea6ff),
      // Low sun stays strong (long golden light across the streets); it fades in the last degrees before it sets.
      intensity: day > .02 ? weather.sun * smooth(-1, 7, elevation) + .22 * (1 - day) : .22,
    },
    // The sky's own light falls away well before sunset, so the low sun's warm light carries the scene.
    ambient: mix(.14, weather.ambient, smooth(-5, 28, elevation)),
    skyTint: new THREE.Color(0x6f86c9).lerp(new THREE.Color(0xffb784), smooth(-6, 1, elevation)).lerp(new THREE.Color(0xe3efff), smooth(4, 26, elevation)),
    environment: mix(.05, .45, day),
    exposure: mix(1.15, 1.05, day),
    sky: clear && elevation > -7,
  };
}

/** "21:30" for an hour of the day. */
export function clockLabel(hour: number) {
  const h = ((hour % 24) + 24) % 24, minutes = Math.round(h * 60) % 1440;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
