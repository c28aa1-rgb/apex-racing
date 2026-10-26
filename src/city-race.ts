import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CITY_RACES, type StreetRace, type Track } from '../shared/tracks';
import type { FittedGate } from '../shared/gates';
import type { Simulation } from '../shared/physics';

/**
 * What the city shows for its street races: in free roam, each race's start box (a lit outline on the road, a beam
 * of light to find it by and its name); during a race, the police cars of its roadblocks with their lightbars
 * flashing red and blue and washing the road in colour, and the next two timing gates as lit posts with a curtain
 * of light between them (the next one bright and numbered, the one after faint). The solid parts live in the simulation.
 */
type GateMarker = { group: THREE.Group; posts: THREE.Mesh[]; curtain: THREE.Mesh; line: THREE.Mesh; sign: THREE.Sprite; materials: THREE.Material[]; text?: string; signBase: number };

/** Most police cars on show at once (the largest race has 8 roadblocks of up to 6 cars). */
const MAX_POLICE = 64;
type Model = { parts: THREE.InstancedMesh[]; beacon: { min: THREE.Vector3; max: THREE.Vector3 } };

export class CityRaceScene {
  readonly group = new THREE.Group();
  private models: Model[] = [];
  private lamps: THREE.InstancedMesh;
  private washes: THREE.InstancedMesh;
  private boxes = new THREE.Group();
  private cars: { matrix: THREE.Matrix4; model: number; phase: number }[] = [];
  private race?: Track;
  private time = 0;
  private color = new THREE.Color();
  private markers: GateMarker[] = [];
  private shownGate = '';

  constructor() {
    this.group.name = 'apex-city-races';
    // Lightbar lamps (two per car) and the coloured wash on the road around each car.
    this.lamps = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ toneMapped: false }), MAX_POLICE * 2);
    this.lamps.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_POLICE * 2 * 3), 3);
    const glow = document.createElement('canvas'); glow.width = glow.height = 64;
    const g = glow.getContext('2d')!, gradient = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, 'rgba(255,255,255,1)'); gradient.addColorStop(.45, 'rgba(255,255,255,.35)'); gradient.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gradient; g.fillRect(0, 0, 64, 64);
    const washMaterial = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(glow), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    this.washes = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), washMaterial, MAX_POLICE * 2);
    this.washes.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_POLICE * 2 * 3), 3);
    for (const mesh of [this.lamps, this.washes]) { mesh.count = 0; mesh.frustumCulled = false; mesh.renderOrder = 2; this.group.add(mesh); }
    this.buildBoxes();
    this.group.add(this.boxes);
    for (let i = 0; i < 2; i++) { const marker = this.gateMarker(); this.markers.push(marker); this.group.add(marker.group); }
  }

  /** Posts, a curtain of light across the road, a glowing line on it and a sign; laid out per gate in placeGate. */
  private gateMarker(): GateMarker {
    const group = new THREE.Group(); group.visible = false;
    const glow = document.createElement('canvas'); glow.width = 4; glow.height = 128;
    const c = glow.getContext('2d')!, fade = c.createLinearGradient(0, 128, 0, 0);
    fade.addColorStop(0, 'rgba(255,255,255,.85)'); fade.addColorStop(.25, 'rgba(255,255,255,.3)'); fade.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = fade; c.fillRect(0, 0, 4, 128);
    const post = new THREE.MeshBasicMaterial({ toneMapped: false });
    const curtain = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(glow), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    const line = new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    const posts = [0, 1].map(() => { const mesh = new THREE.Mesh(new THREE.CylinderGeometry(.24, .32, 7.5, 12).translate(0, 3.75, 0), post); group.add(mesh); return mesh; });
    const curtainMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 3.2).translate(0, 1.6, 0), curtain); curtainMesh.renderOrder = 3; group.add(curtainMesh);
    const lineMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, .7).rotateX(-Math.PI / 2), line); lineMesh.renderOrder = 3; group.add(lineMesh);
    const sign = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false, toneMapped: false })); group.add(sign);
    return { group, posts, curtain: curtainMesh, line: lineMesh, sign, materials: [post, curtain, line, sign.material], signBase: 0 };
  }
  /** Shows the race's next gate and the one after (sim.checkpoint counts the gates passed). */
  showGates(sim: Simulation, eye?: THREE.Vector3) {
    const track = sim.track; if (!this.race || track !== this.race || sim.finished) { for (const m of this.markers) m.group.visible = false; return; }
    const gates = sim.gates, all = [...gates.checkpoints, gates.finish], next = sim.checkpoint, laps = track.street!.laps, perLap = (track.checkpoints.length + 1) / laps;
    const key = `${track.id}:${next}`;
    if (key !== this.shownGate) {
      this.shownGate = key;
      this.markers.forEach((marker, k) => {
        const index = next + k, gate = all[index];
        marker.group.visible = !!gate; if (!gate) return;
        const finish = index === all.length - 1, lapLine = !finish && laps > 1 && (index + 1) % perLap === 0;
        const label = finish ? 'FINISH' : lapLine ? `LAP ${Math.round((index + 1) / perLap) + 1}` : `${index + 1} / ${all.length - 1}`;
        this.placeGate(marker, gate, finish ? new THREE.Color(3, 3, 3) : lapLine ? new THREE.Color(3, 2, .3) : new THREE.Color(.25, 2.6, 2.2), label, k === 0);
      });
    }
    // The next gate breathes; the one after stays faint.
    const pulse = .8 + .2 * Math.sin(this.time * 5);
    this.markers.forEach((marker, k) => {
      const strength = k === 0 ? pulse : .32; (marker.curtain.material as THREE.MeshBasicMaterial).opacity = strength * .8; (marker.line.material as THREE.MeshBasicMaterial).opacity = strength; marker.sign.material.opacity = k === 0 ? 1 : .55;
      // Signs grow with distance (up to 3x), so the next gate's number reads from well down the road.
      const grow = eye ? THREE.MathUtils.clamp(marker.sign.position.distanceTo(eye) / 45, 1, 3) : 1, base = k === 0 ? 6 : 4.2;
      marker.sign.scale.set(base * grow, base * grow * .3125, 1); marker.sign.position.y = marker.signBase + (grow - 1) * 1.2;
    });
  }
  private placeGate(marker: GateMarker, gate: FittedGate, color: THREE.Color, label: string, next: boolean) {
    const left = gate.roadLeft, right = gate.roadRight, width = right - left, mid = (left + right) / 2;
    const at = (lateral: number, along = 0) => new THREE.Vector3(gate.position.x + gate.side.x * lateral + gate.forward.x * along, gate.heightAt(along, lateral), gate.position.z + gate.side.z * lateral + gate.forward.z * along);
    marker.posts[0].position.copy(at(left)); marker.posts[1].position.copy(at(right));
    const centre = at(mid), yaw = Math.atan2(gate.forward.x, gate.forward.z);
    marker.curtain.position.copy(centre); marker.curtain.rotation.set(0, yaw, 0); marker.curtain.scale.set(width, 1, 1);
    marker.line.position.copy(centre).setY(centre.y + .05); marker.line.rotation.set(0, yaw, 0); marker.line.scale.set(width, 1, 1);
    for (const material of marker.materials) if ('color' in material) (material as THREE.MeshBasicMaterial).color.copy(color);
    marker.sign.material.color.set(1, 1, 1);
    if (marker.text !== label) {
      marker.text = label;
      const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 160;
      const c = canvas.getContext('2d')!, hex = `rgb(${Math.min(255, color.r * 90)},${Math.min(255, color.g * 90)},${Math.min(255, color.b * 90)})`;
      c.fillStyle = 'rgba(8,12,18,.8)'; c.beginPath(); c.roundRect(8, 8, 496, 144, 24); c.fill();
      c.strokeStyle = hex; c.lineWidth = 8; c.stroke();
      c.fillStyle = '#fff'; c.font = '800 88px system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(label, 256, 84);
      marker.sign.material.map?.dispose();
      const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; marker.sign.material.map = texture; marker.sign.material.needsUpdate = true;
    }
    marker.signBase = centre.y + (next ? 8.6 : 7.8); marker.sign.position.copy(centre).setY(marker.signBase);
  }

  /** Takes the police cars from public/models/traffic/police-cars.glb (built by design/build-police.ts). */
  build(scene: THREE.Object3D) {
    scene.updateMatrixWorld(true);
    for (const vehicle of scene.children) {
      if (!vehicle.userData.apexVehicle) continue;
      // The vehicle node itself turns and centres the source model into the game's car frame (forward +z, wheels on
      // y = 0), so each part's full world matrix (the scene root sits at the origin) is its place in that frame.
      const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
      vehicle.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        // Every part in the car's own frame, with the same attributes, so a material's parts merge into one draw.
        const g = object.geometry.clone().applyMatrix4(object.matrixWorld);
        for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
        if (!g.attributes.normal) g.computeVertexNormals();
        if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
        if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);
        const material = object.material as THREE.Material;
        (byMaterial.get(material) ?? byMaterial.set(material, []).get(material)!).push(g);
      });
      const parts = [...byMaterial].map(([material, geometries]) => {
        const mesh = new THREE.InstancedMesh(geometries.length > 1 ? mergeGeometries(geometries)! : geometries[0], material, MAX_POLICE);
        mesh.count = 0; mesh.frustumCulled = false; mesh.receiveShadow = true; this.group.add(mesh); return mesh;
      });
      const beacon = vehicle.userData.beacon as { min: number[]; max: number[] } | undefined;
      this.models.push({ parts, beacon: { min: new THREE.Vector3(...(beacon?.min ?? [-.5, 1.35, -.4])), max: new THREE.Vector3(...(beacon?.max ?? [.5, 1.5, -.25])) } });
    }
    this.show(this.race);
  }

  /** The race being driven (its roadblocks appear), or undefined for free roam (the start boxes appear). */
  show(race: Track | undefined) {
    this.race = race; this.cars = [];
    this.boxes.visible = !race;
    const street = race?.street;
    for (const block of street?.roadblocks ?? []) for (const [k, car] of block.cars.entries()) {
      const matrix = new THREE.Matrix4().compose(new THREE.Vector3(car[0], car[1], car[2]), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), car[3]), new THREE.Vector3(1, 1, 1));
      this.cars.push({ matrix, model: car[4] % Math.max(1, this.models.length), phase: (k % 2) * .5 + block.x * .013 });
    }
    const counts = this.models.map(() => 0);
    for (const car of this.cars) {
      const model = this.models[car.model]; if (!model) continue;
      const i = counts[car.model]++;
      for (const mesh of model.parts) mesh.setMatrixAt(i, car.matrix);
    }
    this.models.forEach((model, m) => { for (const mesh of model.parts) { mesh.count = counts[m]; mesh.instanceMatrix.needsUpdate = true; } });
    this.lamps.count = this.washes.count = this.models.length ? this.cars.length * 2 : 0;
    this.update(0);
  }
  get active() { return this.race; }

  /** Lightbars: each half flashes in a quick double pulse, red then blue, the cars of a block out of step. */
  update(dt: number, eye?: THREE.Vector3) {
    this.time += dt;
    const m = new THREE.Matrix4(), local = new THREE.Matrix4(), size = new THREE.Vector3();
    this.cars.forEach((car, i) => {
      const model = this.models[car.model]; if (!model) return;
      const { min, max } = model.beacon; size.set((max.x - min.x) * .46, (max.y - min.y) * 1.1, (max.z - min.z) * 1.1);
      for (const side of [0, 1]) {
        const t = (this.time * 1.6 + car.phase + side * .5) % 1, on = t < .12 || (t > .2 && t < .32) ? 1 : .05;
        const x = side ? max.x - (max.x - min.x) / 4 : min.x + (max.x - min.x) / 4;
        local.compose(new THREE.Vector3(x, (min.y + max.y) / 2, (min.z + max.z) / 2), new THREE.Quaternion(), size);
        m.multiplyMatrices(car.matrix, local);
        this.lamps.setMatrixAt(i * 2 + side, m);
        this.lamps.setColorAt(i * 2 + side, side ? this.color.setRGB(.3 * on, .6 * on, 6 * on) : this.color.setRGB(6 * on, .25 * on, .2 * on));
        local.compose(new THREE.Vector3(x * 5, .05, -.3), new THREE.Quaternion(), new THREE.Vector3(9, 1, 9));
        m.multiplyMatrices(car.matrix, local);
        this.washes.setMatrixAt(i * 2 + side, m);
        this.washes.setColorAt(i * 2 + side, side ? this.color.setRGB(.02 * on, .06 * on, .55 * on) : this.color.setRGB(.55 * on, .03 * on, .02 * on));
      }
    });
    for (const mesh of [this.lamps, this.washes]) { mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true; }
    // The start-box beams breathe slowly; beam and name fade out close up, so they never fill the view from the box.
    for (const box of this.boxes.children) {
      const near = eye ? Math.min(1, Math.max(0, (box.position.distanceTo(eye) - 12) / 25)) : 1;
      for (const child of box.children) {
        if (child.userData.beam) (child as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>).material.opacity = (.16 + .06 * Math.sin(this.time * 2)) * near;
        if (child instanceof THREE.Sprite) { child.material.opacity = near; child.visible = near > .02; }
      }
    }
  }

  /** A lit outline, a beam and a name over each race's start box. */
  private buildBoxes() {
    const orange = new THREE.Color(2.4, .62, .08);
    const line = new THREE.MeshBasicMaterial({ color: orange, toneMapped: false });
    const fill = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, .32, .05), transparent: true, opacity: .22, depthWrite: false, toneMapped: false });
    for (const race of CITY_RACES) {
      const zone = (race.street as StreetRace).zone, box = new THREE.Group();
      box.position.set(zone.x, zone.y + .06, zone.z); box.rotation.y = zone.heading;
      const edge = (w: number, l: number, x: number, z: number) => { const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, l).rotateX(-Math.PI / 2), line); mesh.position.set(x, .01, z); box.add(mesh); };
      edge(zone.w, .3, 0, zone.l / 2); edge(zone.w, .3, 0, -zone.l / 2); edge(.3, zone.l, zone.w / 2, 0); edge(.3, zone.l, -zone.w / 2, 0);
      const ground = new THREE.Mesh(new THREE.PlaneGeometry(zone.w, zone.l).rotateX(-Math.PI / 2), fill); box.add(ground);
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 2.2, 40, 20, 1, true).translate(0, 20, 0),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(1, .4, .08), transparent: true, opacity: .18, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
      beam.userData.beam = true; box.add(beam);
      box.add(this.label(race.name, race.street!.laps > 1 ? `${race.street!.laps} laps · ${(race.length / race.street!.laps / 1000).toFixed(1)} km` : `Sprint · ${(race.length / 1000).toFixed(1)} km`));
      this.boxes.add(box);
    }
  }
  private label(name: string, detail: string) {
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 160;
    const c = canvas.getContext('2d')!;
    c.fillStyle = 'rgba(10,14,20,.78)'; c.beginPath(); c.roundRect(8, 8, 496, 144, 22); c.fill();
    c.fillStyle = '#ff7a1a'; c.fillRect(8, 8, 10, 144);
    c.fillStyle = '#fff'; c.font = '700 58px system-ui, sans-serif'; c.fillText(name, 40, 78);
    c.fillStyle = '#ffb37a'; c.font = '500 32px system-ui, sans-serif'; c.fillText(`${detail} · stop in the box`, 40, 124);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, toneMapped: false, depthWrite: false }));
    sprite.scale.set(8, 2.5, 1); sprite.position.set(0, 4.2, 0);
    return sprite;
  }
}
