import * as THREE from 'three';
import type { Simulation } from '../shared/physics';
import type { Track, Vec3 } from '../shared/tracks';
import { brakingEnvelope, LINE_TUNING, nearestStation, predictZones, racingLine, Zone, type RacingLine } from '../shared/racing-line';
import { WEATHER_GRIP } from '../shared/physics';

export type RacingLineMode = 'off' | 'braking' | 'full';
export const RACING_LINE_MODES: readonly RacingLineMode[] = ['off', 'braking', 'full'];

/** Metres of line drawn behind and ahead of the car, the fade at the far end, and the ribbon's lift off the road. */
const BEHIND = 12, AHEAD = 260, FADE = 70, LIFT = .04;
const COLORS: Record<number, [number, number, number]> = {
  [Zone.Accelerate]: [.16, .86, .38],
  [Zone.Lift]: [1, .76, .1],
  [Zone.Brake]: [1, .16, .12],
};
const OPACITY = .78;

// The baked lines are about 200 kB of numbers, so they load with the first circuit rather than at boot.
let bakedLines: Promise<typeof import('../shared/racing-lines')> | undefined;

/**
 * The driving line painted on the circuit. One ribbon covers the whole lap; each frame only the stretch around
 * the car gets colour, from what the car must do there at its current speed (shared/racing-line.ts), so it turns
 * red earlier when the car arrives too fast. Purely visual: nothing here touches the simulation.
 */
export class RacingLineGuide {
  readonly mesh: THREE.Mesh;
  private geometry = new THREE.BufferGeometry();
  private colors = new Float32Array(0);
  private colorAttribute?: THREE.BufferAttribute;
  private line?: RacingLine;
  private trackId = '';
  private envelope?: Float32Array;
  private envelopeCar = '';
  private zones = new Uint8Array(0);
  private station = -1;
  /** Stations coloured last frame (start index and count), cleared before the next window is drawn. */
  private drawn: [number, number] = [0, 0];

  get path(): Vec3[] | undefined {
    const line = this.line;
    return line && Array.from({ length: line.n }, (_, i) => ({ x: line.x[i], y: line.y[i], z: line.z[i] }));
  }

  constructor() {
    this.mesh = new THREE.Mesh(this.geometry, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    }));
    this.mesh.name = 'Racing line'; this.mesh.frustumCulled = false; this.mesh.renderOrder = 2; this.mesh.visible = false;
  }

  /** Builds the ribbon for a circuit with a baked line; anything else (the car park, the cone course) has none. */
  async setTrack(track: Track | undefined) {
    this.trackId = track?.id ?? ''; this.line = undefined; this.envelope = undefined; this.station = -1; this.mesh.visible = false;
    if (!track) return;
    const { RACING_LINES } = await (bakedLines ??= import('../shared/racing-lines'));
    const baked = RACING_LINES[track.id];
    if (!baked || this.trackId !== track.id) return;
    const line = racingLine(baked, track.metersPerUnit), n = line.n, half = .45 / track.metersPerUnit;
    const positions = new Float32Array(n * 6);
    for (let i = 0; i < n; i++) {
      const a = (i + n - 1) % n, b = (i + 1) % n, fx = line.x[b] - line.x[a], fz = line.z[b] - line.z[a], l = Math.hypot(fx, fz) || 1;
      const sx = fz / l * half, sz = -fx / l * half;
      positions.set([line.x[i] - sx, line.yl[i] + LIFT, line.z[i] - sz, line.x[i] + sx, line.yr[i] + LIFT, line.z[i] + sz], i * 6);
    }
    const index = new Uint32Array(n * 6);
    for (let i = 0; i < n; i++) { const a = i * 2, b = ((i + 1) % n) * 2; index.set([a, b, a + 1, a + 1, b, b + 1], i * 6); }
    this.geometry.dispose();
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.colors = new Float32Array(n * 8);
    this.colorAttribute = new THREE.BufferAttribute(this.colors, 4).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('color', this.colorAttribute);
    this.geometry.setIndex(new THREE.BufferAttribute(index, 1));
    this.mesh.geometry = this.geometry;
    this.zones = new Uint8Array(n); this.drawn = [0, 0];
    this.line = line;
  }

  update(sim: Simulation, mode: RacingLineMode, show: boolean) {
    const line = this.line;
    if (!line || mode === 'off' || !show || sim.track.id !== this.trackId) { this.mesh.visible = false; this.station = -1; return; }
    // Wet or icy roads mean lower corner speeds and earlier braking.
    const key = `${sim.carSpec.id}:${sim.weather}`, grip = WEATHER_GRIP[sim.weather];
    if (!this.envelope || this.envelopeCar !== key) { this.envelope = brakingEnvelope(line, sim.carSpec, { grip: LINE_TUNING.grip * grip, brake: LINE_TUNING.brake * grip }); this.envelopeCar = key; }
    const { n, mpu } = line, p = sim.car.translation(), spacing = line.length / n;
    this.station = nearestStation(line, p.x, p.z, this.station);
    const behind = Math.ceil(BEHIND / spacing), ahead = Math.ceil(AHEAD / spacing), fade = FADE / spacing;
    predictZones(line, this.envelope, sim.carSpec, this.station, Math.max(0, sim.forwardSpeed) * mpu, ahead, this.zones);
    // Clear last frame's window, then colour this one.
    const [from, count] = this.drawn;
    for (let k = 0; k < count; k++) { const i = (from + k) % n; this.colors[i * 8 + 3] = this.colors[i * 8 + 7] = 0; }
    const start = (this.station - behind + n) % n, total = behind + ahead;
    for (let k = 0; k < total; k++) {
      const i = (start + k) % n, zone = k < behind ? this.zones[this.station] : this.zones[i];
      const color = COLORS[zone] ?? COLORS[Zone.Accelerate];
      // Fades in under the car and out towards the far end.
      let alpha = OPACITY * Math.min(1, k / behind, (total - k) / fade);
      if (mode === 'braking' && zone !== Zone.Brake) alpha = 0;
      this.colors.set([color[0], color[1], color[2], alpha, color[0], color[1], color[2], alpha], i * 8);
    }
    this.drawn = [start, total];
    this.colorAttribute!.needsUpdate = true;
    this.mesh.visible = true;
  }
}
