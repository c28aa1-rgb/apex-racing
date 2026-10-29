import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { assetUrl } from '../shared/assets';
import { CHUNK, LANE_INNER, LANE_OUTER, LANE_WIDTH, LANES, MEDIAN_HALF, MEDIAN_HEIGHT, RAIL, RAIL_HEIGHT, ROAD_EDGE, SAMPLES, STEP, TERRAIN_REACH, pointOn, type HighwayChunk, type HighwayRoad, type HighwaySample, type Prop } from '../shared/highway';
import type { Simulation } from '../shared/physics';

/**
 * Draws the Endless Highway around the player, chunk by chunk, from the same generator the physics uses
 * (shared/highway.ts): the banked asphalt with its paint and rumble strips, guardrails and the median barrier, the
 * desert either side, roadside furniture (mile posts, guide signs, gantries, overpasses, a pole line), plants
 * and rocks, and a ring of distant mesas on the horizon.
 *
 * Coordinates: chunk meshes sit at their absolute positions inside `group`, which is moved by minus the simulation's
 * floating origin, so three.js (float64 matrices) composes them into small camera-relative numbers. Instanced plants
 * and rocks keep float32 matrices, so they are stored relative to `propBase`, a point near the player.
 *
 * At most one chunk is built per frame, nearest first; the road a few kilometres ahead is always ready before the
 * player reaches it.
 */
type Bias = (material: THREE.Material, factor: number, units: number) => void;
/** Chunks drawn behind the player's chunk, and the furthest ahead (also limited by the draw distance). */
const DRAW_BEHIND = 2, DRAW_AHEAD_MAX = 16;
/** Plants and rocks are drawn only this many chunks either side (they are small, and the fog hides them sooner). */
const PROP_CHUNKS = 5;
/** Width of a painted line, the dashes' length and their cycle (3 m of paint every 12 m). */
const LINE = .15, DASH = 3, DASH_CYCLE = 12;
const SIGN_GREEN = '#0d6b3d';
const PLACES = ['Dry Wash Rd', 'Coyote Springs', 'Red Butte', 'Mesa Verde', 'Juniper Pass', 'Sand Hollow', 'Painted Rock', 'Copper Canyon', 'Antelope Valley', 'Silver Lake Rd', 'Ocotillo', 'Broken Spur Rd', 'Pinon Flats', 'Las Rocas', 'Three Wells', 'Quail Ridge'];

/** Plain arrays of a mesh being built: positions, normals, uvs, colours and indices. */
class Mesh {
  p: number[] = []; n: number[] = []; uv: number[] = []; c: number[] = []; i: number[] = [];
  get count() { return this.p.length / 3; }
  vertex(x: number, y: number, z: number, u = 0, v = 0, color: [number, number, number] = [1, 1, 1], normal?: [number, number, number]) {
    this.p.push(x, y, z); this.uv.push(u, v); this.c.push(...color); this.n.push(...(normal ?? [0, 1, 0]));
    return this.count - 1;
  }
  quad(a: number, b: number, c: number, d: number) { this.i.push(a, b, c, c, b, d); }
  /** A box: centre, half sizes, turned by yaw about y. */
  box(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, yaw: number, color: [number, number, number] = [1, 1, 1]) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const at = (x: number, y: number, z: number): [number, number, number] => [cx + x * c + z * s, cy + y, cz - x * s + z * c];
    const faces: [number[], number[]][] = [[[1, 0, 0], [0, 0, 1]], [[-1, 0, 0], [0, 0, -1]], [[0, 1, 0], [1, 0, 0]], [[0, -1, 0], [-1, 0, 0]], [[0, 0, 1], [-1, 0, 0]], [[0, 0, -1], [1, 0, 0]]];
    for (const [normal, tangent] of faces) {
      const bit = normal.map((v, k) => v * [hx, hy, hz][k]), t = tangent.map((v, k) => v * [hx, hy, hz][k]);
      const b = [normal[1] * tangent[2] - normal[2] * tangent[1], normal[2] * tangent[0] - normal[0] * tangent[2], normal[0] * tangent[1] - normal[1] * tangent[0]].map((v, k) => v * [hx, hy, hz][k]);
      const n = at(normal[0], normal[1], normal[2]); const worldNormal: [number, number, number] = [n[0] - cx, n[1] - cy, n[2] - cz]; const l = Math.hypot(...worldNormal); worldNormal.forEach((v, k) => worldNormal[k] = v / l);
      const corner = (u: number, w: number) => this.vertex(...at(bit[0] + t[0] * u + b[0] * w, bit[1] + t[1] * u + b[1] * w, bit[2] + t[2] * u + b[2] * w), (u + 1) * Math.max(hx, hz), (w + 1) * hy, color, worldNormal);
      this.quad(corner(-1, -1), corner(1, -1), corner(-1, 1), corner(1, 1));
    }
  }
  /** A vertical cylinder from y0 to y1, radius r0 at the bottom and r1 at the top. */
  cylinder(x: number, y0: number, z: number, y1: number, r0: number, r1: number, sides = 8, color: [number, number, number] = [1, 1, 1]) {
    const first = this.count;
    for (let k = 0; k <= sides; k++) {
      const a = k / sides * Math.PI * 2, cx = Math.cos(a), sz = Math.sin(a);
      this.vertex(x + cx * r0, y0, z + sz * r0, k / sides, 0, color, [cx, 0, sz]);
      this.vertex(x + cx * r1, y1, z + sz * r1, k / sides, (y1 - y0) / 2, color, [cx, 0, sz]);
    }
    for (let k = 0; k < sides; k++) this.quad(first + k * 2 + 1, first + k * 2 + 3, first + k * 2, first + k * 2 + 2);
  }
  /** Smooth normals, from the triangles' winding, for the vertices from `fromVertex` (built by the triangles from `fromIndex`). */
  normalsFrom(fromVertex: number, fromIndex: number) {
    const sum = new Float64Array((this.count - fromVertex) * 3);
    for (let k = fromIndex; k < this.i.length; k += 3) {
      const [a, b, c] = [this.i[k], this.i[k + 1], this.i[k + 2]], p = this.p;
      const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2], wx = p[c * 3] - p[a * 3], wy = p[c * 3 + 1] - p[a * 3 + 1], wz = p[c * 3 + 2] - p[a * 3 + 2];
      const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      for (const v of [a, b, c]) if (v >= fromVertex) { sum[(v - fromVertex) * 3] += nx; sum[(v - fromVertex) * 3 + 1] += ny; sum[(v - fromVertex) * 3 + 2] += nz; }
    }
    for (let v = fromVertex; v < this.count; v++) {
      const o = (v - fromVertex) * 3, l = Math.hypot(sum[o], sum[o + 1], sum[o + 2]) || 1;
      this.n[v * 3] = sum[o] / l; this.n[v * 3 + 1] = sum[o + 1] / l; this.n[v * 3 + 2] = sum[o + 2] / l;
    }
  }
  geometry(computeNormals = false) {
    if (!this.i.length) return undefined;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setIndex(this.i);
    if (computeNormals) g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

function hash(a: number, b: number) { let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b, 0xc2b2ae35); h = Math.imul(h ^ h >>> 15, 0x2c1b3c6d); h ^= h >>> 13; return (h >>> 0) / 4294967296; }
const gauss = (x: number, width: number) => Math.exp(-(x * x) / (2 * width * width));
const mix3 = (a: number[], b: number[], t: number): [number, number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function canvasTexture(width: number, height: number, draw: (c: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  draw(canvas.getContext('2d')!);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 8;
  return texture;
}
/** A green guide sign: white border and lettering, as on real highways. */
function signFace(lines: string[], width: number, height: number, arrow?: 'down' | 'right') {
  return canvasTexture(width, height, c => {
    c.fillStyle = SIGN_GREEN; c.fillRect(0, 0, width, height);
    const edge = Math.round(height * .045); c.strokeStyle = '#f4f4ee'; c.lineWidth = edge * .7;
    const r = edge * 2.2; c.beginPath(); c.roundRect(edge, edge, width - edge * 2, height - edge * 2, r); c.stroke();
    // Subtle weathering: faded patches and a little grime towards the bottom.
    const grime = c.createLinearGradient(0, 0, 0, height); grime.addColorStop(0, 'rgba(255,255,255,0.04)'); grime.addColorStop(1, 'rgba(40,30,10,0.12)');
    c.fillStyle = grime; c.fillRect(0, 0, width, height);
    c.fillStyle = '#f4f4ee'; c.textAlign = 'center'; c.textBaseline = 'middle';
    const size = height / (lines.length + 1.1);
    lines.forEach((line, k) => {
      c.font = `${k === lines.length - 1 && lines.length > 1 ? 600 : 700} ${Math.round(size * (k === lines.length - 1 && lines.length > 1 ? .72 : .86))}px "Instrument", "Arial Narrow", Arial, sans-serif`;
      c.fillText(line, width / 2 - (arrow === 'right' ? width * .07 : 0), height * (k + .9) / (lines.length + .8));
    });
    if (arrow) {
      c.save(); c.translate(arrow === 'right' ? width * .88 : width * .5, arrow === 'right' ? height * .5 : height * .84); if (arrow === 'right') c.rotate(-Math.PI / 4);
      const s = height * .16; c.beginPath(); c.moveTo(0, s); c.lineTo(-s * .8, -s * .1); c.lineTo(-s * .28, -s * .1); c.lineTo(-s * .28, -s); c.lineTo(s * .28, -s); c.lineTo(s * .28, -s * .1); c.lineTo(s * .8, -s * .1); c.closePath(); c.fill(); c.restore();
    }
  });
}

type PropKindModel = { parts: { geometry: THREE.BufferGeometry; material: THREE.Material }[]; height: number };
type Built = { index: number; group: THREE.Group; textures: THREE.Texture[] };

export class HighwayScene {
  readonly group = new THREE.Group();
  /** Instanced plants and rocks, placed relative to propBase (absolute) to keep their float32 matrices small. */
  private props = new THREE.Group();
  private propBase = new THREE.Vector3();
  private propMeshes = new Map<string, THREE.InstancedMesh[]>();
  private models = new Map<string, PropKindModel>();
  private built = new Map<number, Built>();
  private propsFor = '';
  private horizon: THREE.Mesh;
  private reflectors: THREE.MeshBasicMaterial;
  private materials: Record<'road' | 'paint' | 'terrain' | 'steel' | 'concrete' | 'wood' | 'signBack' | 'wire', THREE.Material>;
  private textures: THREE.Texture[] = [];
  private drawAhead = 12;
  private wet = false;
  /** Sign faces, lit a little at night (retroreflective sheeting in the headlamps). */
  private signs = new Set<THREE.MeshStandardMaterial>();
  private signGlow = 0;

  /** The road being drawn: the simulation's own (same seed, same chunks); a new run's seed rebuilds everything. */
  private road!: HighwayRoad;
  private constructor(private bias: Bias) {
    this.group.name = 'apex-highway';
    const tex = (name: string, color: boolean, repeat = true) => {
      const texture = new THREE.TextureLoader().load(assetUrl(`models/highway/textures/${name}.jpg`));
      if (color) texture.colorSpace = THREE.SRGBColorSpace;
      if (repeat) texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.anisotropy = 8; this.textures.push(texture); return texture;
    };
    const surface = (name: string, options: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial({ map: tex(`${name}_diff`, true), normalMap: tex(`${name}_nor`, false), roughnessMap: tex(`${name}_rough`, false), vertexColors: true, ...options });
    const paint = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .62, metalness: 0, color: 0xffffff });
    this.bias(paint, -2, -2);
    this.materials = {
      road: surface('asphalt', { color: 0xc9c9c9, roughness: 1, normalScale: new THREE.Vector2(.8, .8) }),
      paint,
      terrain: surface('sand', { color: 0xffffff, roughness: 1, normalScale: new THREE.Vector2(1.2, 1.2) }),
      steel: new THREE.MeshStandardMaterial({ color: 0xb3b8bb, roughness: .38, metalness: .85, vertexColors: true, side: THREE.DoubleSide }),
      concrete: surface('concrete', { color: 0xd8d4cc, roughness: 1, side: THREE.DoubleSide }),
      wood: new THREE.MeshStandardMaterial({ color: 0x5b4734, roughness: .92, metalness: 0, vertexColors: true }),
      signBack: new THREE.MeshStandardMaterial({ color: 0x8d9295, roughness: .55, metalness: .6, vertexColors: true }),
      wire: new THREE.LineBasicMaterial({ color: 0x1d1d1b, transparent: true, opacity: .75 }),
    };
    this.reflectors = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    this.horizon = this.buildHorizon();
    this.group.add(this.props);
  }

  /** Loads the scenery models and textures; the road itself is built as it is driven. */
  static async create(loader: GLTFLoader, bias: Bias) {
    const scene = new HighwayScene(bias);
    try {
      const gltf = await loader.loadAsync(assetUrl('models/highway/highway-props.glb'));
      gltf.scene.updateMatrixWorld(true);
      for (const kind of gltf.scene.children) {
        const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
        kind.traverse(object => {
          if (!(object instanceof THREE.Mesh)) return;
          const geometry = object.geometry.clone().applyMatrix4(new THREE.Matrix4().copy(kind.matrixWorld).invert().multiply(object.matrixWorld));
          for (const name of Object.keys(geometry.attributes)) if (!['position', 'normal', 'uv'].includes(name)) geometry.deleteAttribute(name);
          const material = object.material as THREE.MeshStandardMaterial;
          // Desert light: the city's garden greens are dusted down to dry olive.
          if (/shrub_02|tree_small_02|pine_tree_01_Foliage/i.test(material.name) && !material.userData.dusted) { material.color.multiply(new THREE.Color(.86, .82, .62)); material.userData.dusted = true; }
          (byMaterial.get(material) ?? byMaterial.set(material, []).get(material)!).push(geometry);
        });
        const parts = [...byMaterial].map(([material, geometries]) => ({ material, geometry: geometries.length > 1 ? mergeGeometries(geometries)! : geometries[0] }));
        const box = new THREE.Box3(); for (const part of parts) { part.geometry.computeBoundingBox(); box.union(part.geometry.boundingBox!); }
        scene.models.set(kind.name, { parts, height: box.max.y - box.min.y });
      }
    } catch (error) { console.warn('Highway scenery models unavailable.', error); }
    return scene;
  }

  /** How far ahead to build, from the player's draw distance. */
  setDrawDistance(metres: number) { this.drawAhead = Math.min(DRAW_AHEAD_MAX, Math.max(6, Math.ceil(metres / CHUNK) + 1)); }
  /** Rain: the asphalt darkens and shines. */
  setWet(wet: boolean) {
    if (wet === this.wet) return; this.wet = wet;
    const road = this.materials.road as THREE.MeshStandardMaterial;
    road.roughness = wet ? .42 : 1; road.color.setHex(wet ? 0x8a8a8a : 0xc9c9c9);
  }
  /** Night: retroreflectors light up in the headlamps (0 day to 1 night); the horizon takes the sky's colour. */
  setLight(night: number, horizon: THREE.Color) {
    this.reflectors.color.setScalar(.35 + night * 2.2);
    this.signGlow = night * .32; for (const material of this.signs) material.emissiveIntensity = this.signGlow;
    const m = this.horizon.material as THREE.ShaderMaterial;
    m.uniforms.haze.value.copy(horizon); m.uniforms.light.value = .25 + (1 - night) * .75;
  }

  /** Per frame: follow the floating origin, build the next missing chunk, drop far ones, keep the horizon round the camera. */
  /** Adopts the simulation's road; a different seed (a new run) starts the scenery over. */
  private follow(road: HighwayRoad) {
    if (this.road && this.road.seed !== road.seed) { for (const built of [...this.built.values()]) this.drop(built); this.propsFor = ''; }
    this.road = road;
  }
  update(sim: Simulation, camera: THREE.Camera) {
    const highway = sim.highway; if (!highway) return;
    this.follow(highway.road);
    this.group.position.set(-highway.origin.x, -highway.origin.y, -highway.origin.z);
    // The horizon is drawn in the local frame, under the camera.
    this.horizon.position.set(camera.position.x, camera.position.y - 60, camera.position.z);
    const centre = this.road.indexOf(highway.s), from = centre - DRAW_BEHIND, to = centre + this.drawAhead;
    // Behind as well when driving the wrong way.
    const back = highway.along < -5 ? this.drawAhead - DRAW_BEHIND : 0;
    for (const [index, built] of this.built) if (index < from - back - 1 || index > to + 1) this.drop(built);
    let missing: number | undefined;
    for (let d = 0; d <= Math.max(to - centre, centre - from + back); d++) {
      for (const index of [centre + d, centre - d]) if (index >= from - back && index <= to && !this.built.has(index)) { missing = index; break; }
      if (missing !== undefined) break;
    }
    if (missing !== undefined) this.build(missing);
    const key = `${centre}`;
    if (key !== this.propsFor && this.models.size) { this.propsFor = key; this.placeProps(centre); }
    this.props.position.set(this.propBase.x - highway.origin.x, this.propBase.y - highway.origin.y, this.propBase.z - highway.origin.z);
  }
  /** Builds every chunk in range at once (for the first frame, so the road is never seen half-built). */
  prime(sim: Simulation) {
    const highway = sim.highway; if (!highway) return;
    this.follow(highway.road);
    const centre = this.road.indexOf(highway.s);
    for (let index = centre - DRAW_BEHIND; index <= centre + Math.min(this.drawAhead, 8); index++) if (!this.built.has(index)) this.build(index);
  }

  // ------------------------------------------------------------------ chunk building
  private build(index: number) {
    const chunk = this.road.chunk(index), first = chunk.samples[0];
    const group = new THREE.Group(); group.position.set(first.x, first.y, first.z); group.name = `highway-chunk-${index}`;
    const origin = { x: first.x, y: first.y, z: first.z };
    const textures: THREE.Texture[] = [];
    const add = (geometry: THREE.BufferGeometry | undefined, material: THREE.Material, shadows = true) => {
      if (!geometry) return;
      const mesh = new THREE.Mesh(geometry, material); mesh.receiveShadow = true; mesh.castShadow = shadows && material !== this.materials.paint; mesh.matrixAutoUpdate = false; mesh.updateMatrix();
      group.add(mesh);
    };
    add(this.roadSurface(chunk, origin), this.materials.road, false);
    add(this.paint(chunk, origin), this.materials.paint, false);
    add(this.terrain(chunk, origin), this.materials.terrain, false);
    const steel = new Mesh(), concrete = new Mesh(), wood = new Mesh(), signBack = new Mesh(), reflectors = new Mesh(), wires: number[] = [];
    this.barriers(chunk, origin, steel, concrete);
    for (const prop of chunk.props) this.furniture(prop, origin, { steel, concrete, wood, signBack, reflectors, wires, group, textures });
    add(steel.geometry(), this.materials.steel);
    add(concrete.geometry(), this.materials.concrete);
    add(wood.geometry(), this.materials.wood);
    add(signBack.geometry(), this.materials.signBack);
    add(reflectors.geometry(), this.reflectors, false);
    if (wires.length) { const lines = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(wires, 3)), this.materials.wire); lines.frustumCulled = true; lines.geometry.computeBoundingSphere(); group.add(lines); }
    group.updateMatrix(); group.matrixAutoUpdate = false;
    this.group.add(group);
    this.built.set(index, { index, group, textures });
  }
  private drop(built: Built) {
    built.group.traverse(object => { if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) { object.geometry.dispose(); if (!Object.values(this.materials).includes(object.material) && object.material !== this.reflectors) { this.signs.delete(object.material); (object.material as THREE.Material).dispose(); } } });
    for (const texture of built.textures) texture.dispose();
    built.group.removeFromParent(); this.built.delete(built.index);
  }

  /** Texture coordinates along the road repeat every 1400 m (a whole number of tiles), so they stay precise. */
  private along(s: number, chunk: HighwayChunk, tile: number) { const base = Math.floor(chunk.s0 / 1400) * 1400; return (s - base) / tile; }

  /** The asphalt from guardrail to guardrail, shaded per vertex: darker wheel paths, paler shoulders, patched sections. */
  private roadSurface(chunk: HighwayChunk, origin: { x: number; y: number; z: number }) {
    const mesh = new Mesh(), columns: number[] = [];
    for (let lat = -RAIL - 1.5; lat <= RAIL + 1.5 + 1e-6; lat += .6) columns.push(lat);
    const lanes = Array.from({ length: LANES }, (_, k) => LANE_INNER + (k + .5) * LANE_WIDTH);
    for (const sample of chunk.samples) {
      // Resurfaced stretches, a few hundred metres long, each carriageway on its own.
      const patch = [1, -1].map(side => .9 + .14 * hash(Math.floor((sample.s + side * 137) / 260), side + 7));
      const normal = new THREE.Vector3(Math.cos(sample.heading) * sample.bank, 1, -Math.sin(sample.heading) * sample.bank).normalize();
      for (const lat of columns) {
        const a = Math.abs(lat), p = pointOn(sample, lat);
        let shade = patch[lat >= 0 ? 0 : 1];
        if (a > LANE_INNER - .2 && a < LANE_OUTER + .2) {
          for (const c of lanes) shade *= 1 - .13 * (gauss(a - (c - .85), .3) + gauss(a - (c + .85), .3)) - .07 * gauss(a - c, .25);
        } else shade *= 1.07;
        // Wind-blown sand and grime against the barriers.
        const dust = gauss(a - RAIL, .9) * .45;
        const color = mix3([shade, shade, shade], [1.05, .93, .76], dust);
        mesh.vertex(p.x - origin.x, p.y - origin.y, p.z - origin.z, lat / 4, this.along(sample.s, chunk, 4), color, [normal.x, normal.y, normal.z]);
      }
    }
    for (let k = 0; k < SAMPLES - 1; k++) for (let c = 0; c < columns.length - 1; c++) { const a = k * columns.length + c, b = a + columns.length; mesh.quad(a, a + 1, b, b + 1); }
    return mesh.geometry();
  }

  /**
   * Paint: a solid yellow line on the median side and a solid white one on the outside of each carriageway, white
   * dashes between lanes (3 m every 12 m, counted from s = 0 so they run on across chunks), and rumble strips
   * milled into the outer shoulders.
   */
  private paint(chunk: HighwayChunk, origin: { x: number; y: number; z: number }) {
    const mesh = new Mesh(), white: [number, number, number] = [.93, .93, .9], yellow: [number, number, number] = [.95, .72, .16], groove: [number, number, number] = [.035, .035, .035];
    const stripe = (from: number, to: number, lat: number, width: number, color: [number, number, number], lift = .012) => {
      const steps = Math.max(1, Math.ceil((to - from) / STEP));
      const firstVertex = mesh.count;
      for (let k = 0; k <= steps; k++) {
        const s = from + (to - from) * k / steps, sample = this.road.at(s);
        for (const edge of [-1, 1]) { const p = pointOn(sample, lat + edge * width / 2, lift); mesh.vertex(p.x - origin.x, p.y - origin.y, p.z - origin.z, 0, 0, color); }
      }
      for (let k = 0; k < steps; k++) { const a = firstVertex + k * 2; mesh.quad(a, a + 1, a + 2, a + 3); }
    };
    const s0 = chunk.s0, s1 = s0 + CHUNK;
    for (const side of [1, -1]) {
      stripe(s0, s1, side * (LANE_INNER - .12), LINE, yellow);
      stripe(s0, s1, side * (LANE_OUTER + .12), LINE, white);
      for (let k = 1; k < LANES; k++) {
        const lat = side * (LANE_INNER + k * LANE_WIDTH);
        for (let start = Math.floor(s0 / DASH_CYCLE) * DASH_CYCLE; start < s1; start += DASH_CYCLE) {
          const from = Math.max(s0, start), to = Math.min(s1, start + DASH);
          if (to > from) stripe(from, to, lat, LINE * .85, white);
        }
      }
      // Rumble strips: short grooves across a band of the outer shoulder.
      for (let s = Math.ceil(s0 / .5) * .5; s < s1; s += .5) stripe(s, Math.min(s1, s + .16), side * (LANE_OUTER + .7), .4, groove, .004);
    }
    return mesh.geometry();
  }

  /**
   * The desert either side: from the end of the paved verge out to TERRAIN_REACH, on the generator's ground height,
   * coloured from pale caliche to red earth in broad patches, greyer gravel by the road and darker in the ditch.
   */
  private terrain(chunk: HighwayChunk, origin: { x: number; y: number; z: number }) {
    const mesh = new Mesh();
    const reach = [RAIL + 1.5, RAIL + 3, RAIL + 5, RAIL + 7.5, RAIL + 10, RAIL + 13, RAIL + 17, RAIL + 23, RAIL + 31, RAIL + 42, 75, 100, 130, 170, 220, 280, 350, TERRAIN_REACH];
    const tile = 7, base = { x: Math.floor(chunk.samples[0].x / 700) * 700, z: Math.floor(chunk.samples[0].z / 700) * 700 };
    for (const side of [1, -1]) {
      const columns = reach.map(r => side * r), rows = chunk.samples.length;
      // Heights on a grid one row/column wider than drawn, for smooth normals across chunk seams.
      const grid: THREE.Vector3[][] = [];
      for (let k = -1; k <= rows; k++) {
        const s = chunk.s0 + k * STEP, sample = this.road.at(s), row: THREE.Vector3[] = [];
        for (let c = -1; c <= columns.length; c++) {
          const lat = c < 0 ? side * (RAIL + 1) : c >= columns.length ? side * (TERRAIN_REACH + 30) : columns[c];
          const p = pointOn(sample, lat); row.push(new THREE.Vector3(p.x, this.road.ground(s, lat), p.z));
        }
        grid.push(row);
      }
      const firstVertex = mesh.count;
      for (let k = 0; k < rows; k++) for (let c = 0; c < columns.length; c++) {
        const p = grid[k + 1][c + 1], along = new THREE.Vector3().subVectors(grid[k + 2][c + 1], grid[k][c + 1]), across = new THREE.Vector3().subVectors(grid[k + 1][c + 2], grid[k + 1][c]).multiplyScalar(side);
        const normal = new THREE.Vector3().crossVectors(along, across).normalize(); if (normal.y < 0) normal.negate();
        const a = Math.abs(columns[c]);
        const broad = .5 + .5 * Math.sin(p.x * .0031 + Math.cos(p.z * .0023) * 2.1) * Math.cos(p.z * .0027 - p.x * .0011);
        let color = mix3([1.02, .95, .84], [.95, .72, .55], broad);
        color = mix3(color, [.8, .78, .74], Math.max(0, 1 - (a - RAIL - 1.5) / 4.5) * .8);
        const ditch = gauss(a - (RAIL + 6), 2.2) * .12; color = color.map(v => v * (1 - ditch + .06 * (hash(Math.round(p.x), Math.round(p.z)) - .5))) as [number, number, number];
        mesh.vertex(p.x - origin.x, p.y - origin.y, p.z - origin.z, (p.x - base.x) / tile, (p.z - base.z) / tile, color, [normal.x, normal.y, normal.z]);
      }
      for (let k = 0; k < rows - 1; k++) for (let c = 0; c < columns.length - 1; c++) {
        const a = firstVertex + k * columns.length + c, b = a + columns.length;
        if (side > 0) mesh.quad(a, a + 1, b, b + 1); else mesh.quad(a + 1, a, b + 1, b);
      }
    }
    return mesh.geometry();
  }

  /**
   * Guardrails: a galvanised W-beam on steel posts every 1.9 m (with blockouts), along each outer edge. Median: a
   * concrete safety-shape barrier along the centreline.
   */
  private barriers(chunk: HighwayChunk, origin: { x: number; y: number; z: number }, steel: Mesh, concrete: Mesh) {
    // W-beam cross-section: height, and how far it stands out towards the road from the rail line.
    const beam: [number, number][] = [[.47, .02], [.5, .1], [.545, .1], [.6, .045], [.645, .045], [.7, .1], [.745, .1], [.775, .02]];
    const sweep = (target: Mesh, profile: [number, number][], latOf: (offset: number) => number, uvScale: number, color: [number, number, number] | ((y: number) => [number, number, number]) = [1, 1, 1]) => {
      const first = target.count, firstIndex = target.i.length;
      for (const sample of chunk.samples) {
        let v = 0;
        profile.forEach(([y, offset], j) => {
          if (j) v += Math.hypot(y - profile[j - 1][0], offset - profile[j - 1][1]);
          const lat = latOf(offset), p = pointOn(sample, lat);
          target.vertex(p.x - origin.x, p.y + y - origin.y, p.z - origin.z, this.along(sample.s, chunk, uvScale), v * 2, typeof color === 'function' ? color(y) : color);
        });
      }
      const n = profile.length;
      for (let k = 0; k < SAMPLES - 1; k++) for (let j = 0; j < n - 1; j++) { const a = first + k * n + j, b = a + n; target.quad(a, b, a + 1, b + 1); }
      target.normalsFrom(first, firstIndex);
    };
    for (const side of [1, -1]) {
      // Front face (towards the road) and a flat back.
      sweep(steel, side < 0 ? beam : [...beam].reverse(), offset => side * (RAIL - offset), 4);
      sweep(steel, side < 0 ? [[.775, 0], [.47, 0]] : [[.47, 0], [.775, 0]], () => side * (RAIL + .004), 4, [.8, .8, .8]);
      for (let s = Math.ceil(chunk.s0 / 1.905) * 1.905; s < chunk.s0 + CHUNK; s += 1.905) {
        const sample = this.road.at(s), post = pointOn(sample, side * (RAIL + .12)), block = pointOn(sample, side * (RAIL + .02));
        steel.box(post.x - origin.x, post.y - origin.y - .25, post.z - origin.z, .05, .5, .075, sample.heading, [.86, .86, .86]);
        steel.box(block.x - origin.x, block.y - origin.y + .6, block.z - origin.z, .06, .12, .05, sample.heading, [.8, .8, .8]);
      }
    }
    // Safety-shape median (half widths by height), with a seam every 6 m between cast sections.
    const median: [number, number][] = [[0, .305], [.075, .305], [.33, .19], [MEDIAN_HEIGHT, .08]];
    const profile: [number, number][] = [...median.map(([y, w]) => [y, w] as [number, number]), ...[...median].reverse().map(([y, w]) => [y, -w] as [number, number])];
    // Tyre rubber and road grime along the foot, weathered paler towards the top.
    sweep(concrete, profile, offset => offset, 3, y => { const k = .5 + .5 * Math.min(1, y / .45); return [k * .97, k * .96, k * .93]; });
    void MEDIAN_HALF; void RAIL_HEIGHT; void ROAD_EDGE;
  }

  /** Roadside furniture for one prop record: posts, signs, gantries, overpasses, the pole line and reflectors. */
  private furniture(prop: Prop, origin: { x: number; y: number; z: number }, out: { steel: Mesh; concrete: Mesh; wood: Mesh; signBack: Mesh; reflectors: Mesh; wires: number[]; group: THREE.Group; textures: THREE.Texture[] }) {
    const sample = this.road.at(prop.s), local = (lat: number, lift = 0) => { const p = pointOn(sample, lat, lift); return { x: p.x - origin.x, y: p.y - origin.y, z: p.z - origin.z }; };
    const panel = (texture: THREE.Texture, at: { x: number; y: number; z: number }, width: number, height: number, yaw: number) => {
      out.textures.push(texture);
      const face = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshStandardMaterial({ map: texture, roughness: .45, metalness: 0, emissiveMap: texture, emissive: 0xffffff, emissiveIntensity: 0 }));
      const material = face.material as THREE.MeshStandardMaterial; material.emissiveIntensity = this.signGlow; this.signs.add(material);
      face.position.set(at.x, at.y, at.z); face.rotation.y = yaw; face.matrixAutoUpdate = false; face.updateMatrix(); face.receiveShadow = true;
      face.userData.retroreflective = true;
      out.group.add(face);
      out.signBack.box(at.x - Math.sin(yaw) * .035, at.y, at.z - Math.cos(yaw) * .035, width / 2, height / 2, .03, yaw);
    };
    // Facing traffic on the carriageway at lat: towards -s for lat > 0 (that traffic drives towards +s).
    const facing = (lat: number) => sample.heading + (lat > 0 ? Math.PI : 0);
    switch (prop.kind) {
      case 'delineator': {
        const p = local(prop.lat, .82), yaw = facing(prop.lat);
        out.steel.box(p.x, p.y - .06, p.z, .04, .1, .04, sample.heading, [.9, .9, .9]);
        const color: [number, number, number] = [1, .97, .9];
        out.reflectors.box(p.x + Math.sin(yaw) * .045, p.y + .01, p.z + Math.cos(yaw) * .045, .035, .05, .006, yaw, color);
        break;
      }
      case 'marker': {
        const p = local(prop.lat), yaw = facing(prop.lat);
        out.steel.box(p.x, p.y + .7, p.z, .03, .75, .03, yaw, [.85, .85, .85]);
        const km = Math.abs(prop.variant); // mile number
        panel(canvasTexture(128, 200, c => {
          c.fillStyle = SIGN_GREEN; c.fillRect(0, 0, 128, 200); c.strokeStyle = '#f4f4ee'; c.lineWidth = 6; c.strokeRect(6, 6, 116, 188);
          c.fillStyle = '#f4f4ee'; c.textAlign = 'center'; c.font = '700 34px "Instrument", Arial, sans-serif'; c.fillText('MILE', 64, 66);
          c.font = `700 ${km >= 100 ? 48 : 60}px "Instrument", Arial, sans-serif`; c.fillText(String(km), 64, 150);
        }), { x: p.x + Math.sin(yaw) * .05, y: p.y + 1.35, z: p.z + Math.cos(yaw) * .05 }, .45, .7, yaw);
        break;
      }
      case 'sign': {
        for (const side of [1, -1]) {
          const lat = side * prop.lat, p = local(lat), yaw = facing(lat), place = PLACES[Math.abs(prop.variant * 7 + (side > 0 ? 0 : 3)) % PLACES.length];
          const across = { x: Math.cos(yaw), z: -Math.sin(yaw) };
          for (const offset of [-1.6, 1.6]) out.steel.box(p.x + across.x * offset, p.y + 1.6, p.z + across.z * offset, .09, 1.7, .07, yaw, [.8, .8, .8]);
          panel(signFace([place, ['EXIT 1/2 MILE', 'EXIT 1 MILE', 'EXIT 2 MILES'][Math.abs(prop.variant) % 3]], 1024, 520), { x: p.x + Math.sin(yaw) * .12, y: p.y + 3.05, z: p.z + Math.cos(yaw) * .12 }, 5.2, 2.64, yaw);
        }
        break;
      }
      case 'gantry': {
        // One gantry over each carriageway: posts on the verge and beside the median, a box truss, two signs.
        for (const side of [1, -1]) {
          const yaw = facing(side), outer = local(side * (RAIL + 1.4)), inner = local(side * .7), height = 6.3;
          for (const foot of [outer, inner]) out.steel.cylinder(foot.x, foot.y - .3, foot.z, foot.y + height + 1.4, .2, .17, 10, [.85, .85, .85]);
          const mid = { x: (outer.x + inner.x) / 2, y: Math.max(outer.y, inner.y) + height, z: (outer.z + inner.z) / 2 }, span = Math.hypot(outer.x - inner.x, outer.z - inner.z);
          const truss = sample.heading + Math.PI / 2;
          for (const dy of [0, 1.2]) for (const dz of [-.45, .45]) out.steel.box(mid.x + Math.sin(sample.heading) * dz, mid.y + dy, mid.z + Math.cos(sample.heading) * dz, span / 2, .06, .06, sample.heading, [.82, .82, .82]);
          for (let k = 0; k <= 10; k++) {
            const t = k / 10 - .5, at = { x: mid.x + Math.sin(truss) * t * span, z: mid.z + Math.cos(truss) * t * span };
            out.steel.box(at.x, mid.y + .6, at.z, .04, .6, .5, sample.heading + Math.PI / 2 + Math.PI / 2, [.8, .8, .8]);
          }
          const placeA = PLACES[Math.abs(prop.variant + (side > 0 ? 2 : 9)) % PLACES.length], placeB = PLACES[Math.abs(prop.variant * 3 + (side > 0 ? 5 : 1)) % PLACES.length];
          const laneCentre = (k: number) => side * (LANE_INNER + (k + .5) * LANE_WIDTH);
          const front = (lat: number) => { const p = local(lat); return { x: p.x + Math.sin(yaw) * .75, y: mid.y + .55, z: p.z + Math.cos(yaw) * .75 }; };
          panel(signFace([placeA, 'NEXT 3 EXITS'], 1024, 520, 'down'), front((laneCentre(0) + laneCentre(1)) / 2), 6.4, 3.25, yaw);
          panel(signFace([`EXIT ${10 + (prop.variant % 80)}`, placeB], 1024, 640, 'right'), front(laneCentre(2) + side * .4), 3.6, 2.25, yaw);
        }
        break;
      }
      case 'overpass': this.overpass(prop, origin, out.concrete, out.steel, out.group); break;
      case 'pole': {
        const p = local(prop.lat), base = this.road.ground(prop.s, prop.lat) - origin.y;
        out.wood.cylinder(p.x, base - .5, p.z, base + 11, .15, .11, 7);
        const across = sample.heading + Math.PI / 2;
        out.wood.box(p.x, base + 10.2, p.z, 1.25, .06, .07, across);
        // Wires to the next pole along (60 m on), sagging between them.
        const next = this.road.point(prop.s + 60, prop.lat), nextBase = this.road.ground(prop.s + 60, prop.lat) - origin.y;
        for (const offset of [-1.1, 0, 1.1]) {
          const ax = p.x + Math.sin(across) * offset, az = p.z + Math.cos(across) * offset, bx = next.x - origin.x + Math.sin(across) * offset, bz = next.z - origin.z + Math.cos(across) * offset;
          for (let k = 0; k < 8; k++) {
            const t0 = k / 8, t1 = (k + 1) / 8, y = (t: number) => base + 10.28 + (nextBase - base) * t - 1.1 * 4 * t * (1 - t);
            out.wires.push(ax + (bx - ax) * t0, y(t0), az + (bz - az) * t0, ax + (bx - ax) * t1, y(t1), az + (bz - az) * t1);
          }
        }
        break;
      }
      default: break;
    }
  }

  /**
   * A road bridge crossing over the highway: a concrete deck on two piers, rising from earth embankments, and the
   * crossing road running on across the desert either side.
   */
  private overpass(prop: Prop, origin: { x: number; y: number; z: number }, concrete: Mesh, steel: Mesh, group: THREE.Group) {
    const sample = this.road.at(prop.s), axis = sample.heading + Math.PI / 2 + prop.yaw;
    const dir = { x: Math.sin(axis), z: Math.cos(axis) }, across = { x: Math.cos(axis), z: -Math.sin(axis) };
    const centre = { x: sample.x, z: sample.z }, deckY = sample.y + 7.2, width = 12, abut = RAIL + 26, foot = abut + 120;
    // The crossing road's height at distance d from the highway's centreline (positive towards +lat).
    const groundAt = (d: number) => this.road.ground(prop.s - d * Math.sin(prop.yaw), -d * Math.cos(prop.yaw));
    const height = (d: number) => { const a = Math.abs(d); if (a <= abut) return deckY; const g = groundAt(d) + .15, t = Math.min(1, (a - abut) / (foot - abut)); return deckY + (g - deckY) * t * t * (3 - 2 * t); };
    const point = (d: number, w: number) => ({ x: centre.x + dir.x * d + across.x * w - origin.x, z: centre.z + dir.z * d + across.z * w - origin.z });
    // Deck and parapets over the span, as boxes along the axis.
    const mid = point(0, 0), yaw = axis;
    concrete.box(mid.x, deckY - .75 - origin.y, mid.z, abut, .75, width / 2, yaw - Math.PI / 2);
    for (const w of [-width / 2 + .15, width / 2 - .15]) { const p = point(0, w); concrete.box(p.x, deckY + .45 - origin.y, p.z, abut, .45, .15, yaw - Math.PI / 2); }
    // Piers: a cap beam on three columns each side, outside the guardrails.
    for (const d of [-(RAIL + 5), RAIL + 5]) {
      const cap = point(d, 0), groundY = groundAt(d) - origin.y;
      concrete.box(cap.x, deckY - 2 - origin.y, cap.z, .7, .5, width / 2 - .5, yaw - Math.PI / 2);
      for (const w of [-4, 0, 4]) { const c = point(d, w); concrete.cylinder(c.x, groundY - 1, c.z, deckY - 2.3 - origin.y, .55, .5, 12); }
    }
    // Embankments and the crossing road beyond the abutments, out to the edge of the terrain.
    const embankment = new Mesh(), road = new Mesh();
    for (const side of [-1, 1]) {
      const firstE = embankment.count, firstR = road.count, steps = 40;
      for (let k = 0; k <= steps; k++) {
        const d = side * (abut + (TERRAIN_REACH - abut) * k / steps), y = height(d) - origin.y, g = groundAt(d) - origin.y - 2.5;
        const slope = Math.max(0, y - g) * 1.8 + 1;
        for (const [w, yy] of [[-width / 2 - slope, g], [-width / 2, y], [width / 2, y], [width / 2 + slope, g]] as [number, number][]) { const p = point(d, w); embankment.vertex(p.x, yy, p.z, d / 6, w / 6, [.95, .82, .66]); }
        for (const w of [-width / 2 + .4, width / 2 - .4]) { const p = point(d, w); road.vertex(p.x, y + .03, p.z, w / 4, d / 4, [.92, .92, .92]); }
      }
      for (let k = 0; k < steps; k++) {
        for (let j = 0; j < 3; j++) { const a = firstE + k * 4 + j, b = a + 4; if (side < 0) embankment.quad(a, a + 1, b, b + 1); else embankment.quad(a + 1, a, b + 1, b); }
        const a = firstR + k * 2, b = a + 2; if (side < 0) road.quad(a, a + 1, b, b + 1); else road.quad(a + 1, a, b + 1, b);
      }
    }
    // Deck top asphalt across the span.
    { const a = road.count; for (const d of [-abut, abut]) for (const w of [-width / 2 + .4, width / 2 - .4]) { const p = point(d, w); road.vertex(p.x, deckY + .03 - origin.y, p.z, w / 4, d / 4, [.92, .92, .92]); } road.quad(a + 1, a, a + 3, a + 2); }
    const add = (mesh: Mesh, material: THREE.Material) => { const g = mesh.geometry(true); if (!g) return; const m = new THREE.Mesh(g, material); m.receiveShadow = true; m.matrixAutoUpdate = false; group.add(m); };
    add(embankment, this.materials.terrain); add(road, this.materials.road);
    // Railing posts along the parapets.
    for (let d = -abut; d <= abut; d += 2.5) for (const w of [-width / 2 + .15, width / 2 - .15]) { const p = point(d, w); steel.box(p.x, deckY + 1.1 - origin.y, p.z, .04, .2, .04, yaw, [.85, .85, .85]); }
  }

  // ------------------------------------------------------------------ plants and rocks
  /** Which model a scattered prop uses: quiver trees and junipers, desert bushes, boulders and the odd fallen log. */
  private modelFor(prop: Prop) {
    if (prop.kind === 'tree') return prop.variant < 2 ? 'quiver' : prop.variant === 2 ? 'pine' : 'tree';
    if (prop.kind === 'shrub') return ['bush-0', 'bush-1', 'shrub-0', 'shrub-2'][prop.variant];
    return ['rock-0', 'rock-1', 'rock-0', 'log'][prop.variant];
  }
  /** Scale per model: the scans are life size, but a quiver tree in the open desert stands taller, and bushes vary. */
  private scaleFor(model: string, prop: Prop) {
    switch (model) {
      case 'quiver': return 2.6 * prop.scale;
      case 'bush-0': case 'bush-1': return 2.4 * prop.scale;
      case 'pine': return .55 * prop.scale;
      case 'tree': return .7 * prop.scale;
      case 'log': return .9;
      default: return prop.scale;
    }
  }
  /** Fills the instanced plant and rock batches from the chunks around `centre`. */
  private placeProps(centre: number) {
    const placements = new Map<string, THREE.Matrix4[]>();
    const anchor = this.road.chunk(centre).samples[0];
    this.propBase.set(anchor.x, anchor.y, anchor.z);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), scale = new THREE.Vector3(), at = new THREE.Vector3();
    for (let index = centre - PROP_CHUNKS + 2; index <= centre + PROP_CHUNKS; index++) {
      const chunk = this.road.chunk(index);
      const crossings = chunk.props.filter(p => p.kind === 'overpass');
      for (const prop of chunk.props) {
        if (prop.kind !== 'tree' && prop.kind !== 'shrub' && prop.kind !== 'rock') continue;
        // Not on an overpass's embankment or crossing road.
        if (crossings.some(c => Math.abs((prop.s - c.s) * Math.cos(c.yaw) - prop.lat * Math.sin(c.yaw)) < 16)) continue;
        const model = this.modelFor(prop), kind = this.models.get(model); if (!kind) continue;
        const p = this.road.point(prop.s, prop.lat), size = this.scaleFor(model, prop);
        at.set(p.x - anchor.x, this.road.ground(prop.s, prop.lat) - anchor.y, p.z - anchor.z);
        q.setFromAxisAngle(up, prop.yaw);
        m.compose(at, q, scale.setScalar(size));
        (placements.get(model) ?? placements.set(model, []).get(model)!).push(m.clone());
      }
    }
    for (const [model, kind] of this.models) {
      const list = placements.get(model) ?? [];
      let meshes = this.propMeshes.get(model);
      if (!meshes || meshes[0].instanceMatrix.count < list.length) {
        for (const old of meshes ?? []) { old.removeFromParent(); old.dispose(); }
        const capacity = Math.max(32, Math.ceil(list.length * 1.4));
        meshes = kind.parts.map(part => { const mesh = new THREE.InstancedMesh(part.geometry, part.material, capacity); mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false; mesh.name = `highway-${model}`; return mesh; });
        this.propMeshes.set(model, meshes); this.props.add(...meshes);
      }
      for (const mesh of meshes) { list.forEach((matrix, i) => mesh.setMatrixAt(i, matrix)); mesh.count = list.length; mesh.instanceMatrix.needsUpdate = true; }
    }
  }

  // ------------------------------------------------------------------ horizon
  /**
   * A ring of distant mesas and buttes, 4 km out, drawn without fog: flat-topped silhouettes with talus slopes, shaded
   * by height and faded into the sky's haze so they read as far away. Follows the camera.
   */
  private buildHorizon() {
    const segments = 720, radius = 4200, positions: number[] = [], heights: number[] = [];
    const n = (x: number, scale: number, seed: number) => { const u = x / scale, i = Math.floor(u), t = u - i, f = t * t * (3 - 2 * t); const a = hash(i % Math.round(segments / scale), seed), b = hash((i + 1) % Math.round(segments / scale), seed); return a + (b - a) * f; };
    for (let k = 0; k <= segments; k++) {
      const x = k % segments;
      // Mesa tops: noise pushed through a steep curve, so heights cluster at plateaus with cliffs between.
      const raw = n(x, 60, 3) * .65 + n(x, 15, 4) * .25 + n(x, 5, 5) * .1;
      const plateau = Math.round(raw * 4) / 4, cliff = Math.min(1, Math.abs(raw * 4 - Math.round(raw * 4)) * 2.2);
      heights.push(40 + Math.max(0, (plateau + (raw - plateau) * cliff * .4) - .25) * 520);
    }
    for (let k = 0; k <= segments; k++) {
      const a = k / segments * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      positions.push(c * radius, -40, s * radius, c * radius, heights[k], s * radius);
    }
    const index: number[] = [];
    for (let k = 0; k < segments; k++) { const a = k * 2; index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    const geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setIndex(index);
    const material = new THREE.ShaderMaterial({
      uniforms: { haze: { value: new THREE.Color(0xc4e1eb) }, rock: { value: new THREE.Color(0x9a6a4e) }, light: { value: 1 } },
      vertexShader: 'varying float vHeight; void main(){ vHeight = position.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform vec3 haze; uniform vec3 rock; uniform float light; varying float vHeight; void main(){ float t = clamp(vHeight / 320.0, 0.0, 1.0); vec3 c = mix(rock * (0.6 + 0.3 * t) * light, haze, 0.4 + 0.15 * t); gl_FragColor = vec4(c, 1.0); }',
      side: THREE.DoubleSide, fog: false, depthWrite: true,
    });
    // Drawn after the sky dome, which pins itself to the far plane (with a reversed depth buffer it would paint over
    // anything drawn before it), and after the opaque scenery, which hides the mesas' feet behind the near desert.
    const mesh = new THREE.Mesh(geometry, material); mesh.frustumCulled = false; mesh.renderOrder = 1; mesh.name = 'highway-horizon';
    return mesh;
  }
  /** The horizon lives outside `group` (in the local frame, around the camera). */
  get horizonMesh() { return this.horizon; }

  dispose() {
    for (const built of [...this.built.values()]) this.drop(built);
    for (const meshes of this.propMeshes.values()) for (const mesh of meshes) mesh.dispose();
    for (const kind of this.models.values()) for (const part of kind.parts) part.geometry.dispose();
    for (const material of Object.values(this.materials)) material.dispose();
    for (const texture of this.textures) texture.dispose();
    this.reflectors.dispose(); this.horizon.geometry.dispose(); (this.horizon.material as THREE.Material).dispose();
    this.group.removeFromParent(); this.horizon.removeFromParent();
  }
}
export type { HighwaySample };
