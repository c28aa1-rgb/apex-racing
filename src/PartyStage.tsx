import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { AnimatePresence, motion } from 'framer-motion';
import { Crown, UserRound, RotateCcw } from 'lucide-react';
import { carById } from '../shared/cars';
import type { PartyMember } from '../shared/party';
import type { RaceWorld } from './world';

type Slot = { x: number; y: number; width: number };
type Stage = { update: (members: PartyMember[], capacity: number) => void; retry: () => void; orbit: (dx: number) => void };

export function PartyStage({ members, capacity, hostId, selfId, world, reduced, entrance = false }: {
  members: PartyMember[]; capacity: number; hostId?: string; selfId?: string; world: RaceWorld; reduced: boolean; entrance?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null), stage = useRef<Stage | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]), [loaded, setLoaded] = useState<Record<string, string>>({}), [failed, setFailed] = useState<string[]>([]);
  const [rendererError, setRendererError] = useState(false), [retry, setRetry] = useState(0);

  useEffect(() => {
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ canvas: canvas.current!, antialias: true, alpha: false }); }
    catch { setRendererError(true); return; }
    setRendererError(false);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = false;
    const scene = new THREE.Scene(); scene.background = new THREE.Color('#c6d9dc');
    scene.fog = new THREE.Fog('#c6d9dc', 80, 180);
    const camera = new THREE.PerspectiveCamera(39, 1, .1, 240);
    const pmrem = new THREE.PMREMGenerator(renderer), environment = new RoomEnvironment();
    const env = pmrem.fromScene(environment, .04); scene.environment = env.texture; environment.dispose(); pmrem.dispose();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x6b7980, 1.1));
    const sun = new THREE.DirectionalLight(0xfff8ed, 2); sun.position.set(-18, 32, 20); sun.castShadow = true;
    Object.assign(sun.shadow.camera, { left: -32, right: 32, top: 32, bottom: -32, near: 1, far: 100 });
    sun.shadow.mapSize.set(2048, 2048); sun.shadow.normalBias = .035; sun.shadow.bias = -.0001; scene.add(sun);
    const pavement = document.createElement('canvas'); pavement.width = pavement.height = 128;
    const ctx = pavement.getContext('2d')!, grain = ctx.createImageData(128, 128); let seed = 531;
    for (let i = 0; i < grain.data.length; i += 4) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; const value = 183 + (seed >>> 28); grain.data.set([value, value + 5, value + 6, 255], i); }
    ctx.putImageData(grain, 0, 0);
    const floorTexture = new THREE.CanvasTexture(pavement); floorTexture.wrapS = floorTexture.wrapT = THREE.RepeatWrapping; floorTexture.repeat.set(60, 60); floorTexture.colorSpace = THREE.SRGBColorSpace;
    const floorMaterial = new THREE.MeshStandardMaterial({ color: '#ccd5d5', map: floorTexture, roughness: .95 });
    const floorGeometry = new THREE.PlaneGeometry(200, 200);
    const floor = new THREE.Mesh(floorGeometry, floorMaterial); floor.rotation.x = -Math.PI / 2; floor.position.y = -.025; floor.receiveShadow = true; scene.add(floor);
    const architecture = new THREE.Group(); scene.add(architecture);
    const wall = new THREE.MeshStandardMaterial({ color: '#cad7d8', roughness: .9 }), trim = new THREE.MeshStandardMaterial({ color: '#427b81', roughness: .55 }), door = new THREE.MeshStandardMaterial({ color: '#9eafb1', roughness: .75 }), paint = new THREE.MeshStandardMaterial({ color: '#f0f0d9', roughness: .8 }), stop = new THREE.MeshStandardMaterial({ color: '#d8b747', roughness: .8 });
    const box = (w: number, h: number, d: number, x: number, y: number, z: number, material: THREE.Material) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material); mesh.position.set(x, y, z); mesh.castShadow = mesh.receiveShadow = true; architecture.add(mesh); return mesh;
    };
    box(90, 8, 1, 0, 4, -24, wall); box(90, .6, 1.6, 0, 7.7, -23.7, trim);
    for (let x = -36; x <= 36; x += 9) {
      box(7.8, 5.7, .2, x, 2.85, -23.38, door);
      box(.35, 7.2, 1.6, x - 4.3, 3.6, -23.1, wall);
      for (let y = .5; y < 5.7; y += .48) box(7.8, .025, .04, x, y, -23.25, trim);
      box(3, .09, .3, x, 6.5, -22.9, paint);
    }
    box(1, 1, 65, -31, .5, 0, wall); box(1, 1, 65, 31, .5, 0, wall);
    box(.15, .015, 110, -25, .005, 18, paint); box(.15, .015, 110, 25, .005, 18, paint);
    const signCanvas = document.createElement('canvas'); signCanvas.width = 1024; signCanvas.height = 128;
    const signContext = signCanvas.getContext('2d')!; signContext.fillStyle = '#265466'; signContext.fillRect(0, 0, 1024, 128);
    signContext.fillStyle = '#f1faee'; signContext.font = '700 82px Shoulders'; signContext.fillText('APEX / PADDOCK', 36, 94);
    const signTexture = new THREE.CanvasTexture(signCanvas); signTexture.colorSpace = THREE.SRGBColorSpace;
    const signMaterial = new THREE.MeshBasicMaterial({ map: signTexture }); box(13, 1.6, .06, 0, 6.7, -23.1, signMaterial);
    const bays = new THREE.Group(); scene.add(bays);
    const lineMaterial = new THREE.LineBasicMaterial({ color: '#eef2dc' });
    const parking = new THREE.Group(); scene.add(parking);
    const models = new Map<string, { carId: string; group: THREE.Group; ready: boolean; failed: boolean; entered: number }>();
    let currentMembers: PartyMember[] = [], count = 0, disposed = false, frame = 0, columns = 4, yaw = .06;
    let positions: THREE.Vector3[] = [];

    const layout = () => {
      const width = root.current!.clientWidth, height = root.current!.clientHeight;
      if (!width || !height) return;
      renderer.setSize(width, height, false);
      columns = width < 600 ? 2 : Math.min(4, count);
      const rows = Math.ceil(count / columns), spacing = 5.8;
      positions = Array.from({ length: count }, (_, index) => new THREE.Vector3((index % columns - (columns - 1) / 2) * spacing, 0, ((rows - 1) / 2 - Math.floor(index / columns)) * 10.5));
      const mobile = width < 620, bottom = entrance ? (mobile ? 295 : 40) : (mobile ? 255 : width < 900 ? 180 : 130), top = 150;
      const available = Math.max(240, height - top - bottom), aspect = width / available;
      const distance = Math.max(10, (columns * spacing + 2.8) / aspect / .65, rows * 7.8 + 1);
      const focus = new THREE.Vector3(entrance && !mobile ? -5 : 0, 0, 0);
      camera.aspect = aspect;
      camera.position.set(focus.x + Math.sin(yaw) * distance, distance * (rows > 1 ? .95 : .66), Math.cos(yaw) * distance);
      camera.lookAt(focus);
      camera.setViewOffset(width, available, 0, -top, width, height);
      camera.updateProjectionMatrix(); camera.updateMatrixWorld();
      bays.children.forEach(child => (child as THREE.LineSegments).geometry.dispose()); bays.clear();
      parking.children.forEach(child => (child as THREE.Mesh).geometry.dispose()); parking.clear();
      positions.forEach((position, index) => {
        const points = [-2.1,0,-3.1, -2.1,0,3.1, 2.1,0,-3.1, 2.1,0,3.1, -2.1,0,3.1, -.9,0,3.1, .9,0,3.1, 2.1,0,3.1];
        const geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
        const lines = new THREE.LineSegments(geometry, lineMaterial); lines.position.copy(position); lines.position.y = .012; bays.add(lines);
        for (const side of [-1, 1]) {
          const marking = new THREE.Mesh(new THREE.BoxGeometry(.08, .012, 6.6), paint); marking.position.copy(position).add(new THREE.Vector3(side * 2.45, .01, 0)); parking.add(marking);
          const curb = new THREE.Mesh(new THREE.BoxGeometry(1.3, .16, .22), stop); curb.position.copy(position).add(new THREE.Vector3(side * 1.1, .08, -2.8)); curb.castShadow = true; parking.add(curb);
        }
        const member = currentMembers[index]; if (member) models.get(member.id)?.group.position.copy(position);
      });
      const projected = positions.map(position => { const p = position.clone().add(new THREE.Vector3(0, 1.8, -1)).project(camera); return { x: (p.x + 1) * width / 2, y: (1 - p.y) * height / 2 }; });
      setSlots(projected.map((slot, index) => {
        const neighbors = projected.filter((_, other) => other !== index && Math.floor(other / columns) === Math.floor(index / columns));
        return { ...slot, width: Math.min(mobile ? 143 : 180, ...neighbors.map(other => Math.abs(other.x - slot.x) - 10)) };
      }));
      renderer.shadowMap.needsUpdate = true;
    };
    const update = (next: PartyMember[], capacity: number) => {
      currentMembers = next; count = capacity;
      for (const [id, model] of models) if (!next.some(member => member.id === id && member.carId === model.carId)) { scene.remove(model.group); models.delete(id); }
      for (const member of next) {
        if (models.has(member.id)) continue;
        const group = new THREE.Group(); scene.add(group);
        const record = { carId: member.carId, group, ready: false, failed: false, entered: 0 }; models.set(member.id, record);
        void world.partyModel(member.carId).then(model => {
          if (disposed || models.get(member.id) !== record) return;
          model.rotation.y = -.32;
          const box = new THREE.Box3().setFromObject(model), center = box.getCenter(new THREE.Vector3());
          model.position.set(-center.x, -box.min.y + .025, -center.z);
          model.traverse(object => { if (object instanceof THREE.Mesh) { object.castShadow = !(Array.isArray(object.material) ? object.material : [object.material]).every(material => material.transparent); object.receiveShadow = false; } });
          group.add(model); record.ready = true; record.entered = performance.now();
          renderer.shadowMap.needsUpdate = true;
          setLoaded(previous => ({ ...previous, [member.id]: member.carId }));
          setFailed(previous => previous.filter(id => id !== member.id));
        }).catch(() => { if (!disposed && models.get(member.id) === record) { record.failed = true; setFailed(previous => [...previous.filter(id => id !== member.id), member.id]); } });
      }
      layout();
    };
    stage.current = { update, orbit: dx => { yaw = THREE.MathUtils.clamp(yaw + dx * .0015, -.15, .15); layout(); }, retry: () => {
      for (const [id, model] of models) if (model.failed) { scene.remove(model.group); models.delete(id); }
      setFailed([]); update(currentMembers, count);
    } };
    const resize = new ResizeObserver(layout); resize.observe(root.current!);
    const render = (now: number) => {
      if (disposed) return;
      frame = requestAnimationFrame(render);
      if (document.hidden) return;
      for (const model of models.values()) if (model.ready) {
        const progress = reduced ? 1 : Math.min(1, (now - model.entered) / 360);
        const wasMoving = model.group.position.y !== 0;
        model.group.position.y = (1 - progress) ** 3 * .65;
        if (wasMoving) renderer.shadowMap.needsUpdate = true;
      }
      renderer.render(scene, camera);
    };
    frame = requestAnimationFrame(render);
    return () => {
      disposed = true; stage.current = null; cancelAnimationFrame(frame); resize.disconnect();
      bays.children.forEach(child => (child as THREE.LineSegments).geometry.dispose());
      architecture.children.forEach(child => (child as THREE.Mesh).geometry.dispose()); parking.children.forEach(child => (child as THREE.Mesh).geometry.dispose());
      [wall, trim, door, paint, stop, signMaterial].forEach(material => material.dispose()); signTexture.dispose(); floorTexture.dispose(); sun.shadow.dispose();
      lineMaterial.dispose(); floorGeometry.dispose(); floorMaterial.dispose(); env.dispose(); renderer.dispose();
      // Car geometries and textures belong to RaceWorld's shared model cache.
    };
  }, [world, reduced, retry, entrance]);

  const signature = members.map(member => `${member.id}:${member.carId}`).join('|');
  useEffect(() => { stage.current?.update(members, capacity); }, [signature, capacity, world, reduced, retry, entrance]);
  return <div className="party-stage" ref={root} data-capacity={capacity}>
    <canvas ref={canvas} aria-label="Party car lineup" onPointerDown={event => event.currentTarget.setPointerCapture(event.pointerId)} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) stage.current?.orbit(event.movementX); }} onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)}/>
    {rendererError ? <div className="party-stage-fallback" role="status">Car preview unavailable.<button onClick={() => setRetry(value => value + 1)}><RotateCcw size={16}/> Retry preview</button>{members.map(member => <p key={member.id}>{member.nickname} / {carById(member.carId).shortName}</p>)}</div> :
    <ol className="party-nameplates" aria-label="Players in lobby">
      <AnimatePresence initial={false}>
        {Array.from({ length: capacity }, (_, index) => {
          const member = members[index], slot = slots[index]; if (!slot) return null;
          return <li key={member?.id ?? `empty-${index}`} style={{ left: slot.x, top: slot.y, width: slot.width }} className={member ? 'occupied' : 'vacant'}>
            <motion.div initial={{ opacity: 0, y: reduced ? 0 : 5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: reduced ? 0 : .22 }}>
              {member ? <><strong>{member.id === hostId && <Crown size={13} aria-label="Host"/>}<span className="party-driver-name" title={member.nickname}>{member.nickname}</span>{member.id === selfId && <small>You</small>}</strong><span title={carById(member.carId).name}>{carById(member.carId).shortName}</span>{failed.includes(member.id) ? <button className="party-model-retry" onClick={() => stage.current?.retry()}><RotateCcw size={12}/> Retry model</button> : loaded[member.id] !== member.carId && <small className="party-model-loading" role="status">Loading car...</small>}</> : <><UserRound size={15}/><span>Open place</span></>}
            </motion.div>
          </li>;
        })}
      </AnimatePresence>
    </ol>}
  </div>;
}
