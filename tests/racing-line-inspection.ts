// Top-down view of a venue with its baked racing line (red) and the drive trace it was built from (cyan).
// /tests/racing-line-inspection.html?track=spa&x=..&z=..&size=160 ; "Next corner" steps through the tightest bends.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { TRACKS } from '../shared/tracks';
import { RACING_LINES } from '../shared/racing-lines';
import { racingLine } from '../shared/racing-line';

const renderer = new THREE.WebGLRenderer({ canvas: document.querySelector('canvas')!, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
const scene = new THREE.Scene(); scene.background = new THREE.Color('#182329');
scene.add(new THREE.HemisphereLight(0xffffff, 0x77818a, 2.4));
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -2000, 2000), loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
const overlay = new THREE.Group(); scene.add(overlay);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const select = $<HTMLSelectElement>('track'), status = $<HTMLOutputElement>('status');
const params = new URLSearchParams(location.search);
TRACKS.forEach(track => select.add(new Option(track.name, track.id)));
select.value = params.get('track') ?? TRACKS[0].id;
let venue: THREE.Group | undefined, corners: number[] = [], corner = -1, generation = 0;

function view(x: number, z: number, size: number) {
  $<HTMLInputElement>('x').value = x.toFixed(0); $<HTMLInputElement>('z').value = z.toFixed(0); $<HTMLInputElement>('size').value = size.toFixed(0);
  const aspect = innerWidth / innerHeight;
  camera.left = -size / 2 * aspect; camera.right = size / 2 * aspect; camera.top = size / 2; camera.bottom = -size / 2;
  camera.position.set(x, 500, z); camera.up.set(0, 0, -1); camera.lookAt(x, 0, z); camera.updateProjectionMatrix();
  history.replaceState(null, '', `?track=${select.value}&x=${x.toFixed(0)}&z=${z.toFixed(0)}&size=${size.toFixed(0)}`);
  renderer.render(scene, camera);
}
/** A flat ribbon along `points`, `width` metres across, drawn over everything. */
const strip = (points: THREE.Vector3[], color: string, width: number) => {
  const positions: number[] = [];
  points.forEach((p, i) => {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)], l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const sx = (b.z - a.z) / l * width / 2, sz = -(b.x - a.x) / l * width / 2;
    positions.push(p.x - sx, p.y, p.z - sz, p.x + sx, p.y, p.z + sz);
  });
  const index: number[] = [];
  for (let i = 0; i < points.length - 1; i++) index.push(i * 2, i * 2 + 2, i * 2 + 1, i * 2 + 1, i * 2 + 2, i * 2 + 3);
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setIndex(index);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color, depthTest: false, side: THREE.DoubleSide }));
  mesh.renderOrder = 10; return mesh;
};
async function load() {
  const version = ++generation, track = TRACKS.find(track => track.id === select.value)!;
  status.textContent = `Loading ${track.name}`;
  const next = (await loader.loadAsync(`/models/tracks/${track.runtimeModel ?? track.model}`)).scene;
  if (version !== generation) return;
  if (venue) scene.remove(venue);
  venue = next; scene.add(venue);
  overlay.clear();
  const line = racingLine(RACING_LINES[track.id], track.metersPerUnit);
  const points = Array.from({ length: line.n + 1 }, (_, i) => new THREE.Vector3(line.x[i % line.n], line.y[i % line.n] + .3, line.z[i % line.n]));
  overlay.add(strip(track.mapPath!.map(p => new THREE.Vector3(p.x, p.y + .3, p.z)), '#40e0ff', .5), strip(points, '#ff3030', 1));
  // Corners: local curvature maxima, tightest first.
  corners = [];
  for (let i = 0; i < line.n; i++) if (line.curvature[i] > .012 && line.curvature[i] >= line.curvature[(i + line.n - 1) % line.n] && line.curvature[i] > line.curvature[(i + 1) % line.n]) corners.push(i);
  corners = corners.filter((i, k) => !corners.slice(0, k).some(j => Math.abs(j - i) < 12));
  corner = -1;
  status.textContent = `${track.name}: ${line.n} stations, ${(line.length / 1000).toFixed(2)} km, ${corners.length} corners (red line, cyan trace)`;
  const x = Number(params.get('x') ?? line.x[0]), z = Number(params.get('z') ?? line.z[0]);
  params.delete('x'); params.delete('z');
  view(x, z, Number(params.get('size') ?? 160));
}
const step = (delta: number) => {
  if (!corners.length) return;
  corner = (corner + delta + corners.length) % corners.length;
  const i = corners[corner], line = racingLine(RACING_LINES[select.value], TRACKS.find(t => t.id === select.value)!.metersPerUnit);
  view(line.x[i], line.z[i], Number($<HTMLInputElement>('size').value));
  status.textContent = `Corner ${corner + 1} of ${corners.length}: station ${i}, radius ${(1 / line.curvature[i]).toFixed(0)} m`;
};
select.onchange = () => { params.delete('x'); params.delete('z'); void load(); };
$('go').onclick = () => view(Number($<HTMLInputElement>('x').value), Number($<HTMLInputElement>('z').value), Number($<HTMLInputElement>('size').value));
$('next').onclick = () => step(1); $('prev').onclick = () => step(-1);
function resize() { renderer.setSize(innerWidth, innerHeight); view(Number($<HTMLInputElement>('x').value || 0), Number($<HTMLInputElement>('z').value || 0), Number($<HTMLInputElement>('size').value || 160)); }
window.addEventListener('resize', resize); renderer.setSize(innerWidth, innerHeight);
await load();

/**
 * Albedo tiles for design/build-venue-surface.ts: the loaded venue drawn straight down, unlit (texture times
 * colour), as RGBA bytes in base64. `top`/`bottom` clip the view to the road's level, so bridges, gantries and tree
 * canopies above it and anything below drop out. Rows run north (-z) to south.
 */
let unlit = false;
const albedo = new THREE.WebGLRenderTarget(1, 1);
(window as unknown as { __albedoTile: unknown }).__albedoTile = async (x: number, z: number, size: number, pixels: number, top: number, bottom: number) => {
  if (!venue) return undefined;
  if (!unlit) {
    unlit = true;
    venue.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      const swap = (m: THREE.Material) => { const s = m as THREE.MeshStandardMaterial; return new THREE.MeshBasicMaterial({ map: s.map ?? null, color: s.color ?? new THREE.Color(1, 1, 1), vertexColors: s.vertexColors, side: THREE.DoubleSide, alphaTest: Math.max(.5, s.alphaTest), transparent: false }); };
      object.material = Array.isArray(object.material) ? object.material.map(swap) : swap(object.material);
    });
    overlay.visible = false;
  }
  albedo.setSize(pixels, pixels);
  const view = new THREE.OrthographicCamera(-size / 2, size / 2, size / 2, -size / 2, .01, top - bottom);
  view.position.set(x, top, z); view.up.set(0, 0, -1); view.lookAt(x, bottom, z); view.updateMatrixWorld(); view.updateProjectionMatrix();
  const background = scene.background; scene.background = new THREE.Color(0, 0, 0);
  renderer.setRenderTarget(albedo); renderer.render(scene, view); renderer.setRenderTarget(null);
  scene.background = background;
  const bytes = new Uint8Array(pixels * pixels * 4);
  renderer.readRenderTargetPixels(albedo, 0, 0, pixels, pixels, bytes);
  // Render targets read bottom row first; flip so row 0 is the top of the view (smallest z).
  const flipped = new Uint8Array(bytes.length), row = pixels * 4;
  for (let r = 0; r < pixels; r++) flipped.set(bytes.subarray((pixels - 1 - r) * row, (pixels - r) * row), r * row);
  let text = ''; for (let i = 0; i < flipped.length; i += 0x8000) text += String.fromCharCode(...flipped.subarray(i, i + 0x8000));
  return btoa(text);
};
(window as unknown as { __venueReady: () => boolean }).__venueReady = () => !!venue && status.textContent?.includes('stations') === true;
