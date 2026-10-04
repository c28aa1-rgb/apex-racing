import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { TRACKS, spawnGate } from '../shared/tracks';
import { PARTY_GRIDS } from '../shared/party-grids';

const renderer = new THREE.WebGLRenderer({ canvas: document.querySelector('canvas')!, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
const scene = new THREE.Scene(); scene.background = new THREE.Color('#899797');
scene.add(new THREE.HemisphereLight(0xffffff, 0x77818a, 2));
const sun = new THREE.DirectionalLight(0xffffff, 2); sun.position.set(30, 90, 20); scene.add(sun);
const camera = new THREE.PerspectiveCamera(45, 1, .1, 4000), loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
const markers = new THREE.Group(); scene.add(markers);
let venue: THREE.Group | undefined, angled = false, generation = 0;
const select = document.querySelector<HTMLSelectElement>('#track')!, status = document.querySelector<HTMLOutputElement>('#status')!;
TRACKS.forEach(track => select.add(new Option(track.name, track.id)));
select.value = new URLSearchParams(location.search).get('track') ?? TRACKS[0].id;
const config = await fetch('/api/dev-circuit-config').then(response => response.json());
const focus = () => {
  const track = TRACKS.find(track => track.id === select.value)!, saved = config.starts?.[track.id];
  const gate = spawnGate(track), position = saved?.position ?? gate.position;
  const heading = saved?.heading ?? Math.atan2(gate.forward.x, gate.forward.z);
  const forward = new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading));
  const center = new THREE.Vector3(position.x, position.y, position.z).addScaledVector(forward, -26);
  camera.position.copy(center).add(new THREE.Vector3(0, angled ? 60 : 105, 0));
  if (angled) camera.position.addScaledVector(forward, -45);
  camera.up.copy(angled ? new THREE.Vector3(0, 1, 0) : forward);
  camera.lookAt(center); camera.updateProjectionMatrix();
  return { position, heading };
};
async function load() {
  const version = ++generation, track = TRACKS.find(track => track.id === select.value)!;
  status.textContent = `Loading ${track.name}`;
  const next = (await loader.loadAsync(`/models/tracks/${track.runtimeModel ?? track.model}`)).scene;
  if (version !== generation) return;
  if (venue) { scene.remove(venue); venue.traverse(object => { if (object instanceof THREE.Mesh) { object.geometry.dispose(); (Array.isArray(object.material) ? object.material : [object.material]).forEach(material => { for (const value of Object.values(material)) if (value instanceof THREE.Texture) value.dispose(); material.dispose(); }); } }); }
  venue = next; scene.add(venue);
  markers.children.forEach(child => { if (child instanceof THREE.Mesh) { child.geometry.dispose(); (child.material as THREE.Material).dispose(); } }); markers.clear();
  focus();
  PARTY_GRIDS[track.id as keyof typeof PARTY_GRIDS].slots.forEach(({position,heading},i)=>{
    const box = new THREE.Mesh(new THREE.BoxGeometry(2.5, .08, 6.1), new THREE.MeshBasicMaterial({ color: i ? '#00ffff' : '#ff6040', wireframe: true, depthTest: false }));
    box.position.set(position.x, position.y + .3, position.z); box.rotation.y = heading; markers.add(box);
  });
  status.textContent = `${track.name}: 8 starting slots`;
  renderer.render(scene, camera);
}
select.onchange = () => { history.replaceState(null, '', `?track=${select.value}`); void load(); };
document.querySelector<HTMLInputElement>('#markers')!.onchange = event => { markers.visible = (event.target as HTMLInputElement).checked; renderer.render(scene, camera); };
document.querySelector<HTMLButtonElement>('#angle')!.onclick = event => { angled = !angled; (event.target as HTMLButtonElement).textContent = angled ? 'Top view' : 'Angled view'; focus(); renderer.render(scene, camera); };
function resize() { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.render(scene, camera); }
window.addEventListener('resize', resize); resize();
await load();
