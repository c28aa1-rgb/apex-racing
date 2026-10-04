import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { LotLayout } from '../shared/lot';
import { CONE_TRACK } from '../shared/tracks';
import type { Simulation } from '../shared/physics';

/**
 * Renders the Training Grounds car park from the shared layout. Everything
 * static is merged or instanced by material, so the whole lot is a few dozen
 * draw calls. Cones are one instanced mesh, animated from the simulation's
 * cone-hit record: knocked cones tumble away, free-roam cones pop back up.
 */
type Bias = (material: THREE.Material, factor: number, units: number) => void;
const PAINT_Y = .02;
const ORANGE = '#ff6a13', PAINT = '#f2efe6', YELLOW = '#f1c232';

function canvasTexture(width: number, height: number, draw: (context: CanvasRenderingContext2D) => void, repeat = false) {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  draw(canvas.getContext('2d')!);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 8;
  if (repeat) texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  return texture;
}
/** Seeded so every visit draws the identical lot. */
function seeded(seed: number) { return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }; }

/** Flat quads and rings on the asphalt, collected and merged per paint colour. */
class Paint {
  private positions: number[] = [];
  stripe(ax: number, az: number, bx: number, bz: number, width: number) {
    const dx = bx - ax, dz = bz - az, length = Math.hypot(dx, dz) || 1, nx = -dz / length * width / 2, nz = dx / length * width / 2;
    this.positions.push(ax + nx, PAINT_Y, az + nz, bx + nx, PAINT_Y, bz + nz, ax - nx, PAINT_Y, az - nz, ax - nx, PAINT_Y, az - nz, bx + nx, PAINT_Y, bz + nz, bx - nx, PAINT_Y, bz - nz);
  }
  rect(x: number, z: number, w: number, l: number, width: number) {
    this.stripe(x - w / 2, z - l / 2, x + w / 2, z - l / 2, width); this.stripe(x - w / 2, z + l / 2, x + w / 2, z + l / 2, width);
    this.stripe(x - w / 2, z - l / 2, x - w / 2, z + l / 2, width); this.stripe(x + w / 2, z - l / 2, x + w / 2, z + l / 2, width);
  }
  arc(x: number, z: number, radius: number, width: number, from = 0, to = Math.PI * 2, dash = 0) {
    const steps = Math.max(12, Math.ceil(radius * Math.abs(to - from) / 1.2));
    for (let i = 0; i < steps; i++) {
      if (dash && i % (dash * 2) >= dash) continue;
      const a = from + (to - from) * i / steps, b = from + (to - from) * (i + 1) / steps;
      this.stripe(x + Math.cos(a) * radius, z + Math.sin(a) * radius, x + Math.cos(b) * radius, z + Math.sin(b) * radius, width);
    }
  }
  /** Painted lane arrow pointing along heading (radians, 0 = +z). */
  arrow(x: number, z: number, heading: number, size = 1) {
    const fx = Math.sin(heading), fz = Math.cos(heading), rx = fz, rz = -fx;
    this.stripe(x - fx * 2.4 * size, z - fz * 2.4 * size, x + fx * .6 * size, z + fz * .6 * size, .36 * size);
    const tip = [x + fx * 2.4 * size, z + fz * 2.4 * size], left = [x + fx * .4 * size + rx * size, z + fz * .4 * size + rz * size], right = [x + fx * .4 * size - rx * size, z + fz * .4 * size - rz * size];
    this.positions.push(tip[0], PAINT_Y, tip[1], right[0], PAINT_Y, right[1], left[0], PAINT_Y, left[1]);
  }
  mesh(color: string, bias: Bias, emissive = 0) {
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3)); geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({ color, roughness: .62, side: THREE.DoubleSide, emissive: color, emissiveIntensity: emissive });
    bias(material, -2, -3);
    const mesh = new THREE.Mesh(geometry, material); mesh.receiveShadow = true; mesh.renderOrder = 2; return mesh;
  }
}

/** Collects coloured boxes into one vertex-coloured mesh per material. */
class Batch {
  private parts: THREE.BufferGeometry[] = [];
  add(geometry: THREE.BufferGeometry, color: THREE.ColorRepresentation, x: number, y: number, z: number, yaw = 0, pitch = 0) {
    const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ')), new THREE.Vector3(1, 1, 1)));
    const c = new THREE.Color(color), colors = new Float32Array(g.getAttribute('position').count * 3);
    for (let i = 0; i < colors.length; i += 3) colors.set([c.r, c.g, c.b], i);
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'color', 'uv'].includes(name)) g.deleteAttribute(name);
    if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
    this.parts.push(g);
  }
  box(w: number, h: number, l: number, color: THREE.ColorRepresentation, x: number, y: number, z: number, yaw = 0) { this.add(new THREE.BoxGeometry(w, h, l), color, x, y, z, yaw); }
  geometry() { const geometry = mergeGeometries(this.parts); this.parts.forEach(part => part.dispose()); this.parts = []; return geometry; }
  mesh(material: THREE.Material) {
    const mesh = new THREE.Mesh(this.geometry(), material); mesh.castShadow = true; mesh.receiveShadow = true; return mesh;
  }
}

type ConeState = { hit: number; mode: 'up' | 'flying' | 'down' | 'popping'; p: THREE.Vector3; v: THREE.Vector3; axis: THREE.Vector3; angle: number; spin: number; yaw: number; t: number;
  /** Course-only cones rise when a run starts and sink in free roam: wanted state, current scale, and animation clock (negative while waiting its turn in the wave). */
  want: number; shown: number; showT: number };

export class LotScene {
  group = new THREE.Group();
  private cones: THREE.InstancedMesh;
  private coneStates: ConeState[];
  private matrix = new THREE.Matrix4(); private quaternion = new THREE.Quaternion(); private turn = new THREE.Quaternion(); private scale = new THREE.Vector3();
  private startGlow: THREE.Mesh;
  private time = 0;
  constructor(readonly lot: LotLayout, private bias: Bias) {
    const random = seeded(4721);
    this.buildGround(random);
    this.buildMarkings();
    this.buildStructures(random);
    this.buildSurroundings(random);
    this.startGlow = this.buildStartZone();
    // Traffic cones: orange body, two reflective collars, black base. One draw call.
    const cone = new Batch();
    cone.add(new THREE.CylinderGeometry(.025, .16, .62, 18, 1, true), ORANGE, 0, .36, 0);
    cone.add(new THREE.CylinderGeometry(.075, .112, .1, 18, 1, true).scale(1.04, 1, 1.04), '#f4f4ee', 0, .44, 0);
    cone.add(new THREE.CylinderGeometry(.118, .14, .07, 18, 1, true).scale(1.04, 1, 1.04), '#f4f4ee', 0, .27, 0);
    cone.box(.38, .045, .38, '#1b1d1f', 0, .0225, 0);
    const coneGeometry = cone.geometry();
    this.cones = new THREE.InstancedMesh(coneGeometry, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .55, metalness: 0 }), lot.cones.length);
    this.cones.castShadow = true; this.cones.receiveShadow = true; this.cones.frustumCulled = false; this.cones.name = 'training-cones';
    this.coneStates = lot.cones.map((c, i) => ({ hit: -1, mode: 'up', p: new THREE.Vector3(c.x, 0, c.z), v: new THREE.Vector3(), axis: new THREE.Vector3(1, 0, 0), angle: 0, spin: 0, yaw: i * 1.7, t: 0, want: c.free ? 1 : 0, shown: c.free ? 1 : 0, showT: 1 }));
    this.coneStates.forEach((_, i) => this.placeCone(i));
    this.group.add(this.cones);
  }
  /** Tiled asphalt, a lot-wide grime layer, and grass with a kerb outside the walls. */
  private buildGround(random: () => number) {
    const half = this.lot.half;
    const asphalt = canvasTexture(512, 512, context => {
      const image = context.createImageData(512, 512); const r = seeded(77);
      for (let i = 0; i < image.data.length; i += 4) {
        const grain = (r() - .5) * 26, stone = r() > .985 ? 34 : r() < .01 ? -22 : 0, v = 96 + grain + stone;
        image.data.set([v, v + 2, v + 5, 255], i);
      }
      context.putImageData(image, 0, 0);
    }, true);
    asphalt.repeat.set(half * 2 / 7, half * 2 / 7);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(half * 2, half * 2).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: asphalt, color: 0xc9c9c4, roughness: .94, metalness: 0 }));
    ground.receiveShadow = true; ground.name = 'training-asphalt'; this.group.add(ground);
    // One soft texture across the whole lot: repair patches, oil under bays,
    // sun-bleached lanes and years of rubber on the skid pad.
    const size = 1024, toPixel = (x: number, z: number) => [(x + half) / (half * 2) * size, (half - z) / (half * 2) * size] as const, metre = size / (half * 2);
    const grime = canvasTexture(size, size, context => {
      for (let i = 0; i < 26; i++) {
        const [x, y] = toPixel((random() - .5) * half * 1.8, (random() - .5) * half * 1.8), w = (6 + random() * 22) * metre, h = (4 + random() * 14) * metre;
        context.fillStyle = `rgba(28,30,32,${.16 + random() * .14})`; context.fillRect(x, y, w, h);
        context.strokeStyle = 'rgba(20,20,20,.35)'; context.lineWidth = 1; context.strokeRect(x, y, w, h);
      }
      for (let i = 0; i < 120; i++) {
        const [x, y] = toPixel((random() - .5) * half * 2, (random() - .5) * half * 2);
        const g = context.createRadialGradient(x, y, 0, x, y, (8 + random() * 30) * metre);
        g.addColorStop(0, `rgba(255,252,240,${.05 + random() * .05})`); g.addColorStop(1, 'rgba(255,252,240,0)');
        context.fillStyle = g; context.fillRect(x - 40 * metre, y - 40 * metre, 80 * metre, 80 * metre);
      }
      for (const x of [-126.8, -98.5, -91.5]) for (let z = -66; z <= 51; z += 3) {
        if (random() > .55) continue;
        const [px, py] = toPixel(x + (random() - .5), z);
        context.fillStyle = `rgba(10,10,12,${.18 + random() * .2})`; context.beginPath(); context.ellipse(px, py, (.6 + random() * .8) * metre, (.4 + random() * .5) * metre, random(), 0, Math.PI * 2); context.fill();
      }
      const pad = this.lot.pad;
      for (let i = 0; i < 90; i++) {
        const radius = (pad.radius * (.25 + random() * .8)) * metre, [cx, cy] = toPixel(pad.x + (random() - .5) * 10, pad.z + (random() - .5) * 10);
        context.strokeStyle = `rgba(8,8,10,${.05 + random() * .09})`; context.lineWidth = (.18 + random() * .12) * metre;
        context.beginPath(); context.ellipse(cx, cy, radius, radius * (.82 + random() * .3), random() * Math.PI, random() * 6, random() * 6 + 2 + random() * 4); context.stroke();
      }
      // Rubber laid down along the cone course by earlier runs.
      context.strokeStyle = 'rgba(10,10,12,.08)'; context.lineWidth = .9 * metre;
      for (const offset of [-.9, .9]) {
        context.beginPath();
        const line = [CONE_TRACK.segments[0].start, ...CONE_TRACK.segments.map(segment => segment.end)].map(p => [p.x, p.z] as [number, number]);
        line.forEach(([x, z], i) => { const [px, py] = toPixel(x + offset, z); if (i) context.lineTo(px, py); else context.moveTo(px, py); });
        context.stroke();
      }
    });
    const overlay = new THREE.MeshStandardMaterial({ map: grime, transparent: true, depthWrite: false, roughness: .95 });
    this.bias(overlay, -1, -1);
    const stains = new THREE.Mesh(new THREE.PlaneGeometry(half * 2, half * 2).rotateX(-Math.PI / 2), overlay);
    stains.position.y = .008; stains.renderOrder = 1; stains.receiveShadow = true; this.group.add(stains);
    const grass = canvasTexture(256, 256, context => {
      const image = context.createImageData(256, 256); const r = seeded(91);
      for (let i = 0; i < image.data.length; i += 4) { const n = (r() - .5) * 30; image.data.set([92 + n, 116 + n, 70 + n * .6, 255], i); }
      context.putImageData(image, 0, 0);
    }, true);
    grass.repeat.set(220, 220);
    const field = new THREE.Mesh(new THREE.PlaneGeometry(1600, 1600).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: grass, roughness: 1 }));
    field.position.y = -.04; field.receiveShadow = true; this.group.add(field);
    // A concrete apron outside the barriers keeps the edge from floating on grass.
    const apron = new Batch();
    for (const [x, z, w, l] of [[0, half + 3, half * 2 + 12, 6], [0, -half - 3, half * 2 + 12, 6], [half + 3, 0, 6, half * 2], [-half - 3, 0, 6, half * 2]] as const) apron.box(w, .06, l, '#a9a69c', x, -.02, z);
    this.group.add(apron.mesh(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .95 })));
  }
  private buildMarkings() {
    const white = new Paint(), yellow = new Paint(), orange = new Paint();
    // Parking bays: separators every 3 m and a stop line at the bay mouth.
    for (const [from, to] of [[-129.6, -124.1], [-101.3, -95.8], [-94.2, -88.7]] as const) {
      for (let z = -67.5; z <= 52.5; z += 3) white.stripe(from, z, to, z, .12);
      const mouth = Math.abs(from) > Math.abs(to) ? to : from; white.stripe(mouth, -67.5, mouth, 52.5, .1);
    }
    // Drive-aisle arrows.
    for (const [x, z, heading] of [[-112, -40, 0], [-112, 25, 0], [-80, 25, Math.PI], [-80, -40, Math.PI], [-15, -88, 0], [0, 62, Math.PI / 2]] as const) white.arrow(x, z, heading, 1.1);
    // Skid pad: solid outer ring, dashed inner ring, centre cross.
    const pad = this.lot.pad;
    white.arc(pad.x, pad.z, pad.radius, .22); white.arc(pad.x, pad.z, pad.radius + .5, .08);
    yellow.arc(pad.x, pad.z, 12, .18, 0, Math.PI * 2, 2);
    white.stripe(pad.x - 2, pad.z, pad.x + 2, pad.z, .16); white.stripe(pad.x, pad.z - 2, pad.x, pad.z + 2, .16);
    // Free-roam spawn bay.
    white.rect(this.lot.spawn.x, this.lot.spawn.z, 6, 9, .16);
    // Hatched no-parking zones in front of the container yard and timing hut.
    const hatch = (x0: number, z0: number, x1: number, z1: number) => {
      yellow.rect((x0 + x1) / 2, (z0 + z1) / 2, x1 - x0, z1 - z0, .2);
      for (let s = x0 - (z1 - z0); s < x1; s += 1.6) {
        const ax = Math.max(x0, s), az = z0 + (ax - s), bx = Math.min(x1, s + (z1 - z0)), bz = z0 + (bx - s);
        if (bx > ax) yellow.stripe(ax, az, bx, bz, .22);
      }
    };
    hatch(-118, 72, -88, 80); hatch(40, -128, 56, -120);
    // Cone course: a faint guide line down each lane and the hairpin, in orange.
    // Faint orange guide where the course leaves the start box.
    orange.stripe(this.lot.startZone.x, -100, this.lot.startZone.x, -88, .1);
    this.group.add(white.mesh(PAINT, this.bias), yellow.mesh(YELLOW, this.bias), orange.mesh(ORANGE, this.bias, .08));
    this.group.add(this.label('SKID PAD', pad.x, pad.z - pad.radius - 4, 0, 14, '#f2efe6'));
    this.group.add(this.label('APEX TEST LOT', this.lot.spawn.x, this.lot.spawn.z + 9, 0, 22, '#f2efe6'));
  }
  /** Asphalt lettering, read by a driver heading along `heading`. */
  private label(text: string, x: number, z: number, heading: number, width: number, color: string, glow = 0) {
    const texture = canvasTexture(1024, 160, context => {
      context.fillStyle = color; context.font = '900 120px "Barlow Condensed", "Arial Narrow", Impact, sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle';
      context.fillText(text, 512, 84, 1000);
    });
    const material = new THREE.MeshStandardMaterial({ map: texture, transparent: true, depthWrite: false, roughness: .6, emissive: color, emissiveMap: texture, emissiveIntensity: glow });
    this.bias(material, -2, -3);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, width * 160 / 1024).rotateX(-Math.PI / 2), material);
    mesh.rotation.y = heading + Math.PI; mesh.position.set(x, PAINT_Y + .004, z); mesh.renderOrder = 3; return mesh;
  }
  private buildStructures(random: () => number) {
    const concrete = new Batch(), metal = new Batch(), cars = new Batch(), glass = new Batch();
    // Jersey barriers: tapered concrete profile, 3 m units with a hairline gap.
    const profile = new THREE.Shape([new THREE.Vector2(-.4, 0), new THREE.Vector2(.4, 0), new THREE.Vector2(.4, .08), new THREE.Vector2(.24, .3), new THREE.Vector2(.11, 1.1), new THREE.Vector2(-.11, 1.1), new THREE.Vector2(-.24, .3), new THREE.Vector2(-.4, .08)]);
    const unit = new THREE.ExtrudeGeometry(profile, { depth: 2.96, bevelEnabled: false }).translate(0, 0, -1.48);
    for (const box of this.lot.boxes) {
      if (box.kind === 'wall') {
        const along = box.w > box.l, length = along ? box.w : box.l, count = Math.round(length / 3);
        for (let i = 0; i < count; i++) {
          const offset = -length / 2 + (i + .5) * length / count, shade = 0xb4b0a6 + Math.floor(random() * 3) * 0x030303;
          concrete.add(unit, shade, box.x + (along ? offset : 0), 0, box.z + (along ? 0 : offset), along ? Math.PI / 2 : 0);
        }
      } else if (box.kind === 'container') {
        const colors = ['#9a4630', '#2d6a70', '#c4862c', '#2e4362', '#6f7d4e'], color = colors[Math.floor(random() * colors.length)];
        for (const level of box.h > 3 ? [0, 2.6] : [0]) {
          const tint = level ? colors[Math.floor(random() * colors.length)] : color;
          metal.box(box.w, 2.56, box.l, tint, box.x, level + 1.28, box.z, box.yaw);
          // Corrugation ribs on the long sides and corner posts read the shape from a distance.
          const long = box.w > box.l, length = long ? box.w : box.l, depth = long ? box.l : box.w;
          for (let r = -length / 2 + .3; r < length / 2; r += .6) for (const s of [-1, 1])
            metal.box(long ? .12 : .06, 2.3, long ? .06 : .12, new THREE.Color(tint).multiplyScalar(.82), box.x + (long ? r : s * (depth / 2 + .02)), level + 1.28, box.z + (long ? s * (depth / 2 + .02) : r));
        }
      } else if (box.kind === 'parked') {
        const palette = ['#e9e8e3', '#b9bcc0', '#2a2c30', '#8c1f24', '#24426b', '#3f5640', '#d7d1c2', '#5a5f66'], paint = palette[Math.floor(random() * palette.length)];
        const nose = box.x < -110 ? -1 : box.x < -95 ? 1 : -1;
        cars.box(4.4, .72, 1.84, paint, box.x, .62, box.z);
        cars.box(2.3, .56, 1.66, paint, box.x - nose * .25, 1.24, box.z);
        glass.box(2.1, .44, 1.7, '#1b242b', box.x - nose * .25, 1.24, box.z);
        for (const wx of [-1.4, 1.4]) for (const wz of [-.82, .82]) cars.add(new THREE.CylinderGeometry(.33, .33, .24, 14).rotateX(Math.PI / 2), '#141516', box.x + wx, .33, box.z + wz);
        cars.box(.06, .16, 1.5, '#d8d4c6', box.x + nose * 2.21, .78, box.z);
      } else if (box.kind === 'island') {
        concrete.box(box.w, box.h, box.l, '#c8c3b6', box.x, box.h / 2, box.z);
        for (let z = box.z - box.l / 2 + 6; z < box.z + box.l / 2; z += 12) concrete.add(new THREE.ConeGeometry(.9, 2.6, 6), '#3f6b45', box.x, 1.45, z);
      } else if (box.kind === 'pole') {
        metal.add(new THREE.CylinderGeometry(.09, .16, box.h, 10), '#8a9196', box.x, box.h / 2, box.z);
        metal.box(.2, .5, .5, '#6b7176', box.x, .25, box.z);
        for (const side of [-1, 1]) { metal.box(2.4, .1, .1, '#8a9196', box.x + side * 1.2, box.h - .3, box.z); glass.box(.9, .14, .42, '#fff4d6', box.x + side * 2.2, box.h - .4, box.z); }
      } else if (box.kind === 'kiosk') {
        concrete.box(box.w, box.h, box.l, '#e5e1d6', box.x, box.h / 2, box.z);
        concrete.box(box.w + .8, .22, box.l + .8, '#3b3f44', box.x, box.h + .11, box.z);
        glass.box(box.w + .02, .9, box.l * .8, '#1d2a31', box.x, 1.9, box.z);
        concrete.box(box.w + .04, .18, box.l + .04, ORANGE, box.x, 2.6, box.z);
      }
    }
    const solid = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .88, metalness: 0 });
    const painted = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .55, metalness: .25 });
    const bodywork = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .38, metalness: .35 });
    const windows = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .12, metalness: .6, emissive: 0x000000 });
    this.group.add(concrete.mesh(solid), metal.mesh(painted), cars.mesh(bodywork), glass.mesh(windows));
    // Timing hut sign.
    const sign = canvasTexture(512, 96, context => { context.fillStyle = '#16191c'; context.fillRect(0, 0, 512, 96); context.fillStyle = ORANGE; context.font = '800 58px "Barlow Condensed", Impact, sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText('RACE CONTROL', 256, 50); });
    const kiosk = this.lot.boxes.find(box => box.kind === 'kiosk');
    if (kiosk) {
      const board = new THREE.Mesh(new THREE.PlaneGeometry(4.2, .8), new THREE.MeshBasicMaterial({ map: sign }));
      board.position.set(kiosk.x + kiosk.w / 2 + .42, kiosk.h - .25, kiosk.z); board.rotation.y = Math.PI / 2; this.group.add(board);
    }
  }
  /** Trees just beyond the walls and a low city skyline on the horizon. */
  private buildSurroundings(random: () => number) {
    const half = this.lot.half, trees: THREE.Vector3[] = [];
    for (let i = 0; i < 150; i++) {
      const side = i % 4, t = (random() - .5) * (half * 2 + 30), out = half + 12 + random() * 26;
      trees.push(new THREE.Vector3(side === 0 ? t : side === 1 ? t : side === 2 ? out : -out, 0, side === 0 ? out : side === 1 ? -out : t));
    }
    const crown = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshStandardMaterial({ color: 0x4f7444, roughness: .95, flatShading: true }), trees.length);
    const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(.18, .26, 1, 6), new THREE.MeshStandardMaterial({ color: 0x5a4636, roughness: 1 }), trees.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), color = new THREE.Color();
    trees.forEach((p, i) => {
      const size = 2.6 + random() * 2.4, height = 4 + random() * 3;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), random() * 6);
      crown.setMatrixAt(i, m.compose(new THREE.Vector3(p.x, height + size * .6, p.z), q, new THREE.Vector3(size, size * 1.25, size)));
      crown.setColorAt(i, color.setHSL(.27 + random() * .06, .32 + random() * .12, .26 + random() * .1));
      trunk.setMatrixAt(i, m.compose(new THREE.Vector3(p.x, height / 2, p.z), q, new THREE.Vector3(1, height, 1)));
    });
    crown.castShadow = true; this.group.add(crown, trunk);
    // Skyline: muted blocks with a lit-window facade, far enough to sit in the haze.
    const facade = canvasTexture(128, 256, context => {
      context.fillStyle = '#ffffff'; context.fillRect(0, 0, 128, 256); const r = seeded(5);
      for (let y = 8; y < 256; y += 16) for (let x = 6; x < 128; x += 14) { const v = 120 + r() * 70; context.fillStyle = `rgb(${v * .62},${v * .7},${v * .78})`; context.fillRect(x, y, 9, 10); }
    }, true);
    const blocks = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, .5, 0), new THREE.MeshStandardMaterial({ map: facade, roughness: .8 }), 64);
    for (let i = 0; i < 64; i++) {
      const angle = i / 64 * Math.PI * 2 + random() * .05, radius = 330 + random() * 260, w = 18 + random() * 30, h = 18 + random() * random() * 110;
      blocks.setMatrixAt(i, m.compose(new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius), q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -angle), new THREE.Vector3(w, h, 14 + random() * 20)));
      blocks.setColorAt(i, color.setHSL(.08 + random() * .5, .08, .62 + random() * .2));
    }
    this.group.add(blocks);
  }
  /** The secret: a painted, softly pulsing box with a gantry over it. */
  private buildStartZone() {
    const zone = this.lot.startZone, paint = new Paint();
    paint.rect(zone.x, zone.z, zone.w, zone.l, .3);
    for (let i = 0; i < 3; i++) { const z = zone.z - 2 + i * 1.6; paint.stripe(zone.x - 2.2, z - 1, zone.x, z + .4, .4); paint.stripe(zone.x, z + .4, zone.x + 2.2, z - 1, .4); }
    this.group.add(paint.mesh(ORANGE, this.bias, .25));
    this.group.add(this.label('CONE ATTACK', zone.x, zone.z - zone.l / 2 - 4.6, 0, 11, ORANGE, .35));
    const glowMaterial = new THREE.MeshBasicMaterial({ color: ORANGE, transparent: true, opacity: .16, depthWrite: false, blending: THREE.AdditiveBlending });
    this.bias(glowMaterial, -3, -4);
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(zone.w - .4, zone.l - .4).rotateX(-Math.PI / 2), glowMaterial);
    glow.position.set(zone.x, PAINT_Y + .006, zone.z); glow.renderOrder = 4; this.group.add(glow);
    const frame = new Batch(), span = zone.w + 2, z = zone.z - zone.l / 2 - 10;
    for (const side of [-1, 1]) { frame.box(.35, 5.2, .35, '#1c1f22', zone.x + side * span / 2, 2.6, z); frame.box(.6, .08, .6, '#1c1f22', zone.x + side * span / 2, .04, z); }
    frame.box(span + .35, .9, .3, '#1c1f22', zone.x, 4.9, z);
    this.group.add(frame.mesh(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .5, metalness: .4 })));
    const board = canvasTexture(1024, 128, context => {
      context.fillStyle = ORANGE; context.fillRect(0, 0, 1024, 128);
      context.fillStyle = '#16191c'; for (let x = -40; x < 1024; x += 56) { context.beginPath(); context.moveTo(x, 128); context.lineTo(x + 24, 128); context.lineTo(x + 52, 100); context.lineTo(x + 28, 100); context.fill(); }
      context.font = '900 74px "Barlow Condensed", Impact, sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText('CONE ATTACK  ·  DRIVE IN TO START', 512, 52, 980);
    });
    for (const face of [-1, 1]) {
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(span, .8), new THREE.MeshStandardMaterial({ map: board, emissive: 0xffffff, emissiveMap: board, emissiveIntensity: .35, roughness: .5 }));
      sign.position.set(zone.x, 4.9, z + face * .17); sign.rotation.y = face > 0 ? 0 : Math.PI; this.group.add(sign);
    }
    return glow;
  }
  private placeCone(index: number) {
    const state = this.coneStates[index];
    this.quaternion.setFromAxisAngle(state.axis, state.angle).multiply(this.turn.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, state.yaw));
    let s = 1;
    if (state.mode === 'popping') { const t = Math.min(1, state.t / .38), c = 1.70158; s = 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); }
    s *= state.shown;
    this.cones.setMatrixAt(index, this.matrix.compose(state.p, this.quaternion, this.scale.set(s, s, s)));
  }
  /** Follows the simulation: newly hit cones are thrown, cleared hits pop back upright. */
  update(sim: Simulation | undefined, dt: number, showStart: boolean) {
    this.time += dt;
    (this.startGlow.material as THREE.MeshBasicMaterial).opacity = showStart ? .12 + Math.sin(this.time * 2.4) * .06 : 0;
    const hits = sim?.track.lot === this.lot ? sim.coneHits : undefined;
    const running = sim?.track.kind === 'cones', zone = this.lot.startZone;
    let dirty = false;
    this.coneStates.forEach((state, i) => {
      const want = this.lot.cones[i].free || running ? 1 : 0;
      if (want !== state.want) {
        // Rising cones ripple outward from the start box; sinking ones go together.
        state.want = want; state.showT = want ? -Math.hypot(state.p.x - zone.x, state.p.z - zone.z) / 260 : 0;
      }
      if (state.showT < 1 || state.shown !== state.want) {
        state.showT += dt;
        if (state.want) { const t = THREE.MathUtils.clamp(state.showT / .42, 0, 1), c = 1.70158; state.shown = t <= 0 ? 0 : 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); if (t >= 1) { state.shown = 1; state.showT = 1; } }
        else { const t = THREE.MathUtils.clamp(state.showT / .24, 0, 1); state.shown = 1 - t * t; if (t >= 1) { state.shown = 0; state.showT = 1; } }
        dirty = true; this.placeCone(i);
      }
      const hit = hits ? hits[i] : -1;
      if (hit !== state.hit) {
        if (hit >= 0 && sim) {
          // Thrown along the car's travel and away from its centreline, tumbling end over end.
          const v = sim.car.linvel(), car = sim.car.translation(), away = new THREE.Vector3(state.p.x - car.x, 0, state.p.z - car.z).normalize();
          // A cone weighs a few kilos: it is punted ahead and to one side, not carried at car speed.
          const speed = Math.hypot(v.x, v.z), jitter = Math.sin(i * 12.9898) * .5 + .5, side = (Math.sin(i * 78.233) > 0 ? 1 : -1) * (1.5 + jitter * 2.5);
          const push = .32 + jitter * .18, lx = speed ? -v.z / speed : 0, lz = speed ? v.x / speed : 0;
          state.v.set(v.x * push + away.x * 2.2 + lx * side, 2.2 + Math.min(4.5, speed * .12) + jitter, v.z * push + away.z * 2.2 + lz * side);
          state.axis.set(state.v.z, 0, -state.v.x).normalize(); if (!state.axis.lengthSq()) state.axis.set(1, 0, 0);
          state.spin = 7 + Math.min(14, speed * .5) + jitter * 4; state.mode = 'flying';
        } else if (hit < 0 && state.mode !== 'up') {
          const home = this.lot.cones[i]; state.p.set(home.x, 0, home.z); state.v.set(0, 0, 0); state.angle = 0; state.mode = 'popping'; state.t = 0;
        }
        state.hit = hit;
      }
      if (state.mode === 'flying') {
        const step = Math.min(dt, 1 / 30);
        state.v.y -= 18 * step; state.p.addScaledVector(state.v, step); state.angle += state.spin * step;
        if (state.p.y <= .16 && state.v.y < 0) {
          state.p.y = .16; state.v.y *= -.3; state.v.x *= .42; state.v.z *= .42; state.spin *= .45;
          if (Math.abs(state.v.y) < .9 && Math.hypot(state.v.x, state.v.z) < 1.5) {
            // Settle on its side: the nearest of ±76° (base against the floor), never apex-down.
            const turn = Math.PI * 2, wrapped = state.angle - Math.floor(state.angle / turn) * turn;
            state.angle = Math.floor(state.angle / turn) * turn + (wrapped < Math.PI ? 1.33 : turn - 1.33); state.mode = 'down';
          }
        }
        // Keep cones inside the barriers.
        const limit = this.lot.half - .8;
        if (Math.abs(state.p.x) > limit) { state.p.x = Math.sign(state.p.x) * limit; state.v.x *= -.3; }
        if (Math.abs(state.p.z) > limit) { state.p.z = Math.sign(state.p.z) * limit; state.v.z *= -.3; }
        dirty = true; this.placeCone(i);
      } else if (state.mode === 'popping') {
        state.t += dt; if (state.t >= .38) state.mode = 'up'; dirty = true; this.placeCone(i);
      }
    });
    if (dirty) this.cones.instanceMatrix.needsUpdate = true;
  }
}
