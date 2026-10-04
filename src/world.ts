import { assetUrl } from '../shared/assets';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { direction, orientation, spawnGate, type Track, type Gate } from '../shared/tracks';
import { collisionGeometry, type Simulation, type Frame } from '../shared/physics';
import { fittedGates, GATE_STEP, type FittedGate } from '../shared/gates';
import { buildRoadMesh, interpolateRoad, type RoadPoint } from '../shared/road';
import { carById, DEFAULT_CAR, type CarId } from '../shared/cars';
import { CarRig, prepareCarModel } from './car-rig';
import { FinishConfetti, SkidMarks, StartLight } from './race-effects';
import { Sky } from 'three/addons/objects/Sky.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import type { WeatherPreset } from './settings';
import { GRAPHICS_PRESETS, type GraphicsOptions } from './graphics';
import { Weather, WEATHER } from './weather';
import { LotScene } from './lot-scene';

const palettes = { road: 0x4d6470, edge: 0xf1eee3, orange: 0xff784c, navy: 0x173b4c, teal: 0x45c8bd, sand: 0xe1dfb5, rock: 0x8fa9a0, leaf: 0x518d7c, barrier: 0xaab5b5, roadSide: 0x303c42, tire: 0x1d272c };
const material = (color: THREE.ColorRepresentation) => new THREE.MeshStandardMaterial({ color, roughness: 0.9, flatShading: true });
const asphaltMaterial = () => {
  const canvas=document.createElement('canvas');canvas.width=canvas.height=128;const context=canvas.getContext('2d')!;
  const image=context.createImageData(128,128);let seed=1947;
  for(let index=0;index<image.data.length;index+=4){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const grain=(seed>>>27)-16;image.data[index]=76+grain;image.data[index+1]=88+grain;image.data[index+2]=94+grain;image.data[index+3]=255;}
  context.putImageData(image,0,0);const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;texture.wrapS=texture.wrapT=THREE.RepeatWrapping;texture.anisotropy=8;
  return new THREE.MeshStandardMaterial({color:0xb8bec0,map:texture,roughness:.96,metalness:.02});
};
function reversedDepthSupported() {
  // ?depth=log forces the older logarithmic depth path for comparison on problem GPUs.
  if(new URLSearchParams(location.search).get('depth')==='log')return false;
  const context=document.createElement('canvas').getContext('webgl2');
  const supported=!!context?.getExtension('EXT_clip_control');
  context?.getExtension('WEBGL_lose_context')?.loseContext();
  return supported;
}
export type StartPlacement = { position: { x: number; y: number; z: number }; heading: number };
/** Local-space adjustment from the model's detected driver-seat position. */
export type CockpitOffset = { x: number; y: number; z: number; reference?: 'driver-seat' };
export type EditorMode = 'spawn' | 'finish' | 'road';
import type { CameraMode, CameraOptions } from './camera-modes';
export { CAMERA_LABELS, CAMERA_MODES, type CameraMode, type CameraOptions } from './camera-modes';
export class RaceWorld {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  skidMarks = new SkidMarks();
  startLight!: StartLight;
  finishConfetti = new FinishConfetti();
  weather = new Weather();
  private wideView=true;
  private weatherMaterials=new Map<THREE.MeshStandardMaterial,{roughness:number;color:THREE.Color}>();
  pointerLockEnabled = true;
  sensitivity = 1;
  camera = new THREE.PerspectiveCamera(46, innerWidth / innerHeight, 0.2, 10000);
  trackGroup = new THREE.Group();
  venueGroup = new THREE.Group();
  private cullEntries:{mesh:THREE.Mesh,center:THREE.Vector3,radius:number,full:THREE.BufferGeometry,lod?:THREE.BufferGeometry}[]=[];
  private cullAt=new THREE.Vector3(Infinity,0,0);
  private cullFar=-1;
  garageGroup = new THREE.Group();
  car = new THREE.Group(); ghost = new THREE.Group();
  wheelGroups: THREE.Group[] = [];
  private carRig?: CarRig;
  center = new THREE.Vector3();
  trackRadius = 300;
  currentTrack?: Track;
  venueReady: Promise<void> = Promise.resolve();
  venueLoadError = '';
  cameraTarget = new THREE.Vector3();
  reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private staticBatches = new Map<THREE.Material, THREE.BufferGeometry[]>();
  /** -1 when depth is reversed: polygon offsets must pull towards larger depth values. */
  private depthSign = 1;
  private decalBias(material: THREE.Material, factor: number, units: number) {
    material.polygonOffset=true;material.polygonOffsetFactor=factor*this.depthSign;material.polygonOffsetUnits=units*this.depthSign;
  }
  private gateMarkings = new THREE.Group();
  private lotScene?: LotScene;
  private markedGates?: { track: Track; checkpoints: Gate[]; finish: Gate };
  private mats:Record<string,THREE.MeshStandardMaterial> = {...Object.fromEntries(Object.entries(palettes).map(([k,c])=>[k,material(c)])),road:asphaltMaterial(),barrier:new THREE.MeshStandardMaterial({color:palettes.barrier,roughness:.32,metalness:.72}),tire:new THREE.MeshStandardMaterial({color:palettes.tire,roughness:.93,transparent:true,opacity:.2,depthWrite:false})};
  private shadow: THREE.DirectionalLight;
  private composer?: EffectComposer;
  private options?: GraphicsOptions;
  /** Frame-rate ceiling for rendering (0 = unlimited); Game.frame reads it. */
  fpsCap=0;
  private renderRatio=1;
  private slowFrames=0;
  private fastFrames=0;
  private clock = 0;
  private finishElapsed = 0;
  private finishCameraOffset = new THREE.Vector3();
  private finishLookOffset = new THREE.Vector3();
  private finishFov = 60;
  private loader = new GLTFLoader();
  private modelCache = new Map<CarId, Promise<THREE.Group>>();
  private carLoadToken = 0;
  private ghostLoadToken = 0;
  private venueLoadToken = 0;
  private garageLoad?: Promise<void>;
  private currentCarId: CarId = DEFAULT_CAR.id;
  private garageAngle = -2.8;
  private visualCarPosition = new THREE.Vector3();
  private visualCarQuaternion = new THREE.Quaternion();
  private visualSuspensionLift = 0;
  /** Slowly filtered lift that keeps the tyres on the visible asphalt; see chase(). */
  private visualClearance = 0;
  private visualCarReady = false;
  private contactTick = -1;
  private visibleWheelFloors: (number | undefined)[] = [];
  private lastWheelPosition = new THREE.Vector3();
  private cockpitEye?:THREE.Vector3;
  private legacyCockpitEye?:THREE.Vector3;
  private useDetectedSeat = true;
  private cockpitOffset = new THREE.Vector3();
  cameraMode: CameraMode = 'chase';
  cameraOptions: CameraOptions = { fov: 58, distance: 1, shake: true, recenter: true };
  /** Held look-back key: exterior views swing round to face behind the car. */
  lookBack = false;
  /** Called when the mouse wheel changes the chase distance, so it can be saved. */
  onCameraDistance?: (distance: number) => void;
  /** Cockpit view. Turning it off returns to the chase camera; other exterior views are kept. */
  get firstPerson() { return this.cameraMode === 'cockpit'; }
  set firstPerson(value: boolean) { if (value) this.cameraMode = 'cockpit'; else if (this.cameraMode === 'cockpit') this.cameraMode = 'chase'; }
  private lookInputAt = -Infinity;
  /** Chase rig state: camera and aim offsets from the car, spring velocities, and smoothed motion cues. */
  private rig = { offset: new THREE.Vector3(), offsetVelocity: new THREE.Vector3(), aim: new THREE.Vector3(), aimVelocity: new THREE.Vector3(),
    velocity: new THREE.Vector3(), accel: new THREE.Vector3(), roll: 0, fov: 58, shake: 0, hits: 0, time: 0, ready: false,
    /** Stabilisation: the point the camera follows (height filtered), its smoothed heading, and a smoothed car orientation for interior views. */
    anchor: new THREE.Vector3(), heading: new THREE.Vector3(0, 0, 1), carQ: new THREE.Quaternion(), stable: false };
  private tv?: { position: THREE.Vector3; side: number };  private mouseLookEnabled = false;
  private lookYaw = 0;
  private lookPitch = 0;
  private lookDrag?: { x: number; y: number };
  rotateGarage(dx: number) { this.garageAngle = THREE.MathUtils.clamp(this.garageAngle-dx*.009,-2.8,-.65); }
  resetGarageView() { this.garageAngle = -2.8; }
  setMouseLook(active: boolean) {
    this.mouseLookEnabled = active;
    this.lookDrag = undefined;
    this.canvas.style.cursor = active ? 'grab' : '';
    if(!active&&document.pointerLockElement===this.canvas)document.exitPointerLock();
  }
  lockMouse() { if(this.pointerLockEnabled&&this.mouseLookEnabled&&!location.pathname.startsWith('/dev'))void this.canvas.requestPointerLock()?.catch(()=>{}); }
  resetMouseLook() { this.lookYaw = 0; this.lookPitch = 0; }
  setCockpitOffset(offset?: CockpitOffset) {
    this.cockpitOffset.set(offset?.x ?? 0, offset?.y ?? 0, offset?.z ?? 0);
    // Existing calibrations keep their original origin. New/default positions
    // can use the newly separated steering wheel without moving saved cameras.
    this.useDetectedSeat=!offset||offset.reference==='driver-seat';
  }
  private canvas: HTMLCanvasElement;
  private editorActive = false;
  private editorZoom = 1;
  private editorPan = new THREE.Vector2();
  private editorPanKeys = new Set<string>();
  private editorDrag?: { x: number; y: number; panX: number; panZ: number; moved: boolean };
  private editorPlacement?: StartPlacement;
  private editorMode: EditorMode = 'spawn';
  private editorMarker = new THREE.Group();
  private editorFinishMarker = new THREE.Group();
  private editorRoadGuide = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x65d5cc }));
  private editorRoadEdge?: THREE.Vector3;
  private editorChange?: (placement: StartPlacement) => void;
  private editorRoadChange?: (segment: number, width: number) => void;
  private editorRaycaster = new THREE.Raycaster();
  constructor(canvas: HTMLCanvasElement, private cinematicActors=false) {
    this.canvas = canvas;
    this.scene.add(this.skidMarks.mesh,this.finishConfetti.mesh,this.weather.group);
    this.loader.setMeshoptDecoder(MeshoptDecoder);
    // Cockpit near clipping is 2.5 cm, while venues extend for kilometres.
    // A reversed depth buffer keeps distant road layers apart without writing
    // gl_FragDepth, so the GPU can still reject hidden pixels before shading.
    // Logarithmic depth remains the fallback where EXT_clip_control is missing.
    const reversed=reversedDepthSupported();
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: !reversed, reversedDepthBuffer: reversed, powerPreference: 'high-performance' });
    // Error checks call getProgramInfoLog, which blocks until each shader finishes compiling.
    this.renderer.debug.checkShaderErrors=import.meta.env.DEV;
    this.depthSign=this.renderer.capabilities.reversedDepthBuffer?-1:1;this.decalBias(this.skidMarks.mesh.material as THREE.Material,-2,-2);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = false;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.05;
    this.scene.background = new THREE.Color(0xc4e1eb); this.scene.fog = new THREE.Fog(0xc4e1eb, 800, 2600);
    this.scene.add(new THREE.HemisphereLight(0xe3efff, 0x62665b, 1.15));
    this.shadow = new THREE.DirectionalLight(0xfff2dc, 2.8);
    this.shadow.position.set(-160, 300, 80); this.shadow.castShadow = false;
    this.scene.add(this.shadow, this.shadow.target);
    Object.assign(this.shadow.shadow.camera,{left:-8,right:8,top:8,bottom:-8,near:1,far:80});
    this.shadow.shadow.mapSize.set(1024,1024);
    this.shadow.shadow.normalBias=.025;this.shadow.shadow.bias=-.00015;
    const sky=new Sky();sky.name='apex-sky';sky.scale.setScalar(9000);
    sky.material.uniforms.turbidity.value=3;
    sky.material.uniforms.rayleigh.value=1.4;
    sky.material.uniforms.sunPosition.value.copy(this.shadow.position).normalize();
    this.scene.add(sky);
    const environmentScene=new THREE.Scene();environmentScene.add(sky.clone());
    const pmrem=new THREE.PMREMGenerator(this.renderer);
    this.scene.environment=pmrem.fromScene(environmentScene,.04,.1,20000).texture;
    this.scene.environmentIntensity=.45;pmrem.dispose();
    // Built after the renderer and environment exist. Created earlier, its lit
    // materials rendered as a flat white silhouette under the reversed depth buffer.
    this.startLight=new StartLight();this.scene.add(this.startLight);
    void this.startLight.load(this.loader).then(()=>this.prewarm([this.startLight])).catch(error=>console.warn('Marshal drone model unavailable; using the built-in drone.',error));
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(5000,5000), material(0x8fcbd1));
    sea.rotation.x = -Math.PI/2; sea.position.y = -80; sea.receiveShadow = true; this.scene.add(sea);
    this.garageGroup.visible = false;
    this.scene.add(this.venueGroup, this.trackGroup, this.garageGroup, this.car, this.ghost, this.editorMarker, this.editorFinishMarker, this.editorRoadGuide);
    this.buildEditorMarker(); this.buildEditorFinishMarker(); this.editorMarker.visible = false; this.editorFinishMarker.visible = false; this.editorRoadGuide.visible = false;
    this.buildPlaceholder(this.car, false);this.buildPlaceholder(this.ghost, true); this.ghost.visible = false;
    addEventListener('resize', this.resize);
    addEventListener('keydown', this.editorKeydown);
    addEventListener('keyup', this.editorKeyup);
    addEventListener('blur', this.editorKeyclear);
    // Listen at the window as well as the canvas. The race HUD deliberately
    // overlays the canvas, and some browsers retarget a drag to that transparent
    // layer after the first pixel. Capturing here keeps mouse-look continuous.
    addEventListener('pointerdown', this.racePointerDown, true);
    addEventListener('pointermove', this.racePointerMove, true);
    addEventListener('pointerup', this.racePointerUp, true);
    addEventListener('pointercancel', this.racePointerUp, true);
    canvas.addEventListener('pointerdown', this.editorPointerDown);
    canvas.addEventListener('pointermove', this.editorPointerMove);
    canvas.addEventListener('pointerup', this.editorPointerUp);
    canvas.addEventListener('pointercancel', this.editorPointerCancel);
    canvas.addEventListener('wheel', this.editorWheel, { passive: false });
    addEventListener('wheel', this.raceWheel, { passive: false });
  }
  private resize = () => {
    this.camera.aspect = innerWidth/innerHeight; this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth,innerHeight);
    this.composer?.setSize(innerWidth,innerHeight);
  };
  private tuneTextures(root:THREE.Object3D) {
    const anisotropy=Math.min(this.renderer.capabilities.getMaxAnisotropy(),this.options?.anisotropy??1);
    const seen=new Set<THREE.Texture>();
    root.traverse(object=>{
      if(!(object instanceof THREE.Mesh))return;
      for(const material of Array.isArray(object.material)?object.material:[object.material])for(const value of Object.values(material)){
        if(value instanceof THREE.Texture&&!seen.has(value)){
          seen.add(value);
          if(value.anisotropy!==anisotropy){value.anisotropy=anisotropy;value.needsUpdate=true;}
        }
      }
    });
  }
  setGraphics(next:GraphicsOptions) {
    const previous=this.options;
    if(previous&&JSON.stringify(previous)===JSON.stringify(next))return;
    this.options=next;this.fpsCap=next.fpsCap;
    this.renderRatio=Math.min(devicePixelRatio,next.renderScale);this.slowFrames=0;this.fastFrames=0;
    this.renderer.setPixelRatio(this.renderRatio);
    this.renderer.shadowMap.enabled=next.shadows>0;
    this.shadow.castShadow=next.shadows>0;
    if(next.shadows>0&&this.shadow.shadow.mapSize.x!==next.shadows){
      this.shadow.shadow.map?.dispose();this.shadow.shadow.map=null;this.shadow.shadow.mapSize.set(next.shadows,next.shadows);
    }
    if(previous?.anisotropy!==next.anisotropy){this.tuneTextures(this.venueGroup);this.tuneTextures(this.car);}
    // Rebuild post-processing only when its passes change; resizing alone covers a new render scale.
    if(!previous||previous.bloom!==next.bloom||previous.smoothing!==next.smoothing){
      this.composer?.passes.forEach(pass=>pass.dispose());this.composer?.dispose();this.composer=undefined;
      if(next.bloom||next.smoothing){
        this.composer=new EffectComposer(this.renderer);
        this.composer.addPass(new RenderPass(this.scene,this.camera));
        if(next.bloom)this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth,innerHeight),.12,.35,1.2));
        if(next.smoothing)this.composer.addPass(new SMAAPass());
        this.composer.addPass(new OutputPass());
      }
    }
    this.cullFar=-1;
    this.setWeather(this.weather.preset);
    this.resize();
    // Warm the exact shader variant for the selected renderer settings.
    void this.compileInBackground(this.finishConfetti.mesh,this.scene);
  }
  /** Fog range for a weather preset; clear weather follows the player's draw distance. */
  private fogRange(preset:WeatherPreset){
    const base=WEATHER[preset],distance=this.options?.drawDistance??GRAPHICS_PRESETS.balanced.drawDistance;
    return preset==='clear'?{near:distance*.31,far:distance}:{near:base.near,far:base.far};
  }
  setWeather(preset:WeatherPreset) {
    this.weather.preset=preset;
    const settings=WEATHER[preset];
    (this.scene.background as THREE.Color).setHex(settings.color);
    const fog=this.scene.fog as THREE.Fog;const range=this.fogRange(preset);fog.color.setHex(settings.color);fog.near=range.near;fog.far=range.far;
    this.scene.getObjectByName('apex-sky')!.visible=preset==='clear';
    this.shadow.intensity=settings.sun;
    this.scene.children.forEach(object=>{if(object instanceof THREE.HemisphereLight)object.intensity=settings.ambient;});
    this.venueGroup.traverse(object=>{
      if(!(object instanceof THREE.Mesh))return;
      for(const material of Array.isArray(object.material)?object.material:[object.material]){
        if(!(material instanceof THREE.MeshStandardMaterial)||!/asphalt|tarmac|road/i.test(object.name+' '+material.name))continue;
        if(!this.weatherMaterials.has(material))this.weatherMaterials.set(material,{roughness:material.roughness,color:material.color.clone()});
      }
    });
    for(const [material,original] of this.weatherMaterials){
      material.roughness=preset==='rain'?Math.min(original.roughness,.38):original.roughness;
      material.color.copy(original.color);if(preset==='rain')material.color.multiplyScalar(.7);
    }
  }
  updateWeather(dt:number){this.weather.update(dt,this.camera,this.options?.weatherDensity??.6,this.reducedMotion,this.garageGroup.visible||this.wideView);}
  adaptResolution(fps:number) {
    const options=this.options;
    if(!options?.adaptive||document.hidden)return;
    const target=options.fpsCap?Math.min(options.fpsCap,options.targetFps):options.targetFps;
    this.slowFrames=fps<target*.8?this.slowFrames+1:0;
    this.fastFrames=fps>target*.97?this.fastFrames+1:0;
    if(this.slowFrames<1&&this.fastFrames<3)return;
    const limit=Math.min(devicePixelRatio,options.renderScale);
    const floor=Math.min(limit,Math.max(.5,limit*.65));
    const ratio=this.slowFrames>=1?Math.max(floor,this.renderRatio-.15):Math.min(limit,this.renderRatio+.05);
    this.slowFrames=0;this.fastFrames=0;
    if(Math.abs(ratio-this.renderRatio)<.01)return;
    this.renderRatio=ratio;this.renderer.setPixelRatio(ratio);this.resize();
  }
  private racePointerDown = (event: PointerEvent) => {
    if (!this.mouseLookEnabled || this.editorActive || event.button !== 0) return;
    const target=event.target;
    if(target instanceof Element && target.closest('button,input,select,option,textarea,label,a,dialog,[role="slider"]'))return;
    this.lockMouse();
    this.lookDrag={x:event.clientX,y:event.clientY};this.canvas.style.cursor='grabbing';event.preventDefault();
  };
  private racePointerMove = (event: PointerEvent) => {
    const locked=document.pointerLockElement===this.canvas;
    if((!this.lookDrag&&!locked)||!this.mouseLookEnabled||this.editorActive)return;
    const dx=locked?event.movementX:event.clientX-this.lookDrag!.x,dy=locked?event.movementY:event.clientY-this.lookDrag!.y;this.lookDrag={x:event.clientX,y:event.clientY};
    this.lookYaw=THREE.MathUtils.euclideanModulo(this.lookYaw+dx*.0055*this.sensitivity+Math.PI,Math.PI*2)-Math.PI;
    this.lookPitch=THREE.MathUtils.clamp(this.lookPitch-dy*.0042*this.sensitivity,-.65,.45);this.lookInputAt=performance.now();event.preventDefault();
  };
  private racePointerUp = () => {if(!this.lookDrag)return;this.lookDrag=undefined;this.canvas.style.cursor=this.mouseLookEnabled?'grab':'';};
  private buildEditorMarker() {
    // A true vehicle footprint makes it clear whether the chosen grid slot has
    // enough room. Use the standard 911's real body dimensions as the editor's
    // neutral reference car.
    const { bodyWidthM: width, lengthM: length } = DEFAULT_CAR.dimensions;
    const fill = new THREE.Mesh(new THREE.PlaneGeometry(width, length), new THREE.MeshBasicMaterial({ color: 0xff784c, transparent: true, opacity: .22, side: THREE.DoubleSide }));
    fill.rotation.x = -Math.PI / 2; fill.position.y = .025;
    const halfWidth = width / 2, halfLength = length / 2;
    const outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-halfWidth, .05, -halfLength), new THREE.Vector3(halfWidth, .05, -halfLength),
      new THREE.Vector3(halfWidth, .05, halfLength), new THREE.Vector3(-halfWidth, .05, halfLength)
    ]), new THREE.LineBasicMaterial({ color: 0xffd0bd, transparent: true, opacity: 1 }));
    const nose = new THREE.Line(new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-halfWidth * .72, .07, halfLength * .35), new THREE.Vector3(0, .07, halfLength + .65), new THREE.Vector3(halfWidth * .72, .07, halfLength * .35)
    ]), new THREE.LineBasicMaterial({ color: 0xff784c }));
    [fill, outline, nose].forEach(object => { object.renderOrder = 999; object.material.depthTest = false; object.material.depthWrite = false; });
    this.editorMarker.add(fill, outline, nose);
  }
  private buildEditorFinishMarker() {
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-1, .08, 0), new THREE.Vector3(1, .08, 0)]), new THREE.LineBasicMaterial({ color: 0xffd0bd }));
    const chevron = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-.34, .09, -.72), new THREE.Vector3(0, .09, -.32), new THREE.Vector3(.34, .09, -.72)]), new THREE.LineBasicMaterial({ color: 0xff784c }));
    [line, chevron].forEach(object => { object.renderOrder = 999; object.material.depthTest = false; object.material.depthWrite = false; });
    this.editorFinishMarker.add(line, chevron);
  }
  beginStartEditor(track: Track, placement: StartPlacement | undefined, onChange: (placement: StartPlacement) => void) {
    this.beginPlacementEditor(track, 'spawn', placement, onChange);
  }
  beginPlacementEditor(track: Track, mode: Exclude<EditorMode, 'road'>, placement: StartPlacement | undefined, onChange: (placement: StartPlacement) => void) {
    this.currentTrack = track; this.editorMode = mode; this.editorActive = true; this.editorChange = onChange; this.editorRoadChange = undefined; this.editorZoom = 1; this.editorPan.set(0, 0); this.editorDrag = undefined;
    this.setEditorPlacement(placement);
  }
  beginRoadEditor(track: Track, onChange: (segment: number, width: number) => void) {
    this.currentTrack = track; this.editorMode = 'road'; this.editorActive = true; this.editorChange = undefined; this.editorRoadChange = onChange; this.editorZoom = 1; this.editorPan.set(0, 0); this.editorDrag = undefined; this.editorRoadEdge = undefined;
    this.editorMarker.visible = false; this.editorFinishMarker.visible = false; this.editorRoadGuide.visible = false;
  }
  endStartEditor() { this.editorActive = false; this.editorChange = undefined; this.editorRoadChange = undefined; this.editorMarker.visible = false; this.editorFinishMarker.visible = false; this.editorRoadGuide.visible = false; }
  setEditorPlacement(placement?: StartPlacement) {
    this.editorPlacement = placement;
    this.editorMarker.visible = this.editorActive && this.editorMode === 'spawn' && !!placement;
    this.editorFinishMarker.visible = this.editorActive && this.editorMode === 'finish' && !!placement;
    if (!placement) return;
    const marker = this.editorMode === 'finish' ? this.editorFinishMarker : this.editorMarker;
    marker.position.set(placement.position.x, placement.position.y + .12, placement.position.z);
    marker.rotation.y = placement.heading;
    if (this.editorMode === 'finish' && this.currentTrack) marker.scale.x = this.currentTrack.finish.width / 2;
  }
  private editorPointerDown = (event: PointerEvent) => {
    if (!this.editorActive || !this.currentTrack || event.button !== 0) return;
    this.editorDrag = { x: event.clientX, y: event.clientY, panX: this.editorPan.x, panZ: this.editorPan.y, moved: false };
    this.canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  private editorPointerMove = (event: PointerEvent) => {
    if (!this.editorActive || !this.editorDrag) return;
    const dx = event.clientX - this.editorDrag.x, dy = event.clientY - this.editorDrag.y;
    if (Math.hypot(dx, dy) > 4) this.editorDrag.moved = true;
    if (!this.editorDrag.moved) return;
    const scale = Math.max(420, this.trackRadius * 1.45) * this.editorZoom / Math.max(this.canvas.clientHeight, 1) * 1.28;
    // Pan follows the model under the pointer: drag right/down to inspect the
    // right/down side of the circuit, rather than moving the view against hand motion.
    this.editorPan.set(this.editorDrag.panX + dx * scale, this.editorDrag.panZ - dy * scale);
    event.preventDefault();
  };
  private editorPointerUp = (event: PointerEvent) => {
    const drag = this.editorDrag; this.editorDrag = undefined;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    if (!this.editorActive || !this.currentTrack || !drag || drag.moved) return;
    const rect = this.canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.editorRaycaster.setFromCamera(pointer, this.camera);
    const hit = this.editorRaycaster.intersectObject(this.venueGroup, true)[0];
    if (!hit) return;
    const point = hit.point;
    if (this.editorMode === 'road') {
      if (!this.editorRoadEdge) {
        this.editorRoadEdge = point.clone();
        this.editorRoadGuide.geometry.setFromPoints([point, point]); this.editorRoadGuide.visible = true;
        return;
      }
      const edge = this.editorRoadEdge; this.editorRoadEdge = undefined;
      this.editorRoadGuide.geometry.setFromPoints([edge, point]);
      let segment = 0, distance = Infinity;
      this.currentTrack.segments.forEach((item, index) => {
        const x = (edge.x + point.x) / 2, z = (edge.z + point.z) / 2;
        const dx = item.end.x - item.start.x, dz = item.end.z - item.start.z, length2 = dx * dx + dz * dz;
        const t = length2 ? Math.max(0, Math.min(1, ((x - item.start.x) * dx + (z - item.start.z) * dz) / length2)) : 0;
        const next = Math.hypot(x - (item.start.x + dx * t), z - (item.start.z + dz * t));
        if (next < distance) { distance = next; segment = index; }
      });
      this.editorRoadChange?.(segment, Math.hypot(edge.x - point.x, edge.z - point.z));
      return;
    }
    if (!this.editorPlacement) {
      const placement = { position: { x: point.x, y: point.y, z: point.z }, heading: this.currentTrack.start ? Math.atan2(this.currentTrack.start.forward.x, this.currentTrack.start.forward.z) : 0 };
      this.setEditorPlacement(placement); this.editorChange?.(placement); return;
    }
    const dx = point.x - this.editorPlacement.position.x, dz = point.z - this.editorPlacement.position.z;
    if (Math.hypot(dx, dz) < 1) return;
    const placement = { ...this.editorPlacement, heading: Math.atan2(dx, dz) };
    this.setEditorPlacement(placement); this.editorChange?.(placement);
  };
  private editorPointerCancel = () => { this.editorDrag = undefined; };
  private editorKeydown = (event: KeyboardEvent) => {
    const key = event.key.toLowerCase();
    if (this.editorActive && ['w', 'a', 's', 'd'].includes(key)) { this.editorPanKeys.add(key); event.preventDefault(); return; }
    if (!this.editorActive || !this.editorPlacement || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 1 : .2;
    const forwardX = Math.sin(this.editorPlacement.heading), forwardZ = Math.cos(this.editorPlacement.heading);
    const rightX = Math.cos(this.editorPlacement.heading), rightZ = -Math.sin(this.editorPlacement.heading);
    let x = 0, z = 0;
    if (event.key === 'ArrowUp') { x = forwardX; z = forwardZ; }
    if (event.key === 'ArrowDown') { x = -forwardX; z = -forwardZ; }
    if (event.key === 'ArrowRight') { x = rightX; z = rightZ; }
    if (event.key === 'ArrowLeft') { x = -rightX; z = -rightZ; }
    const placement = { ...this.editorPlacement, position: { ...this.editorPlacement.position, x: this.editorPlacement.position.x + x * step, z: this.editorPlacement.position.z + z * step } };
    this.setEditorPlacement(placement); this.editorChange?.(placement);
  };
  private editorKeyup = (event: KeyboardEvent) => { this.editorPanKeys.delete(event.key.toLowerCase()); };
  private editorKeyclear = () => { this.editorPanKeys.clear(); };
  /** Mouse wheel while driving: pull the chase cameras in or out. */
  private raceWheel = (event: WheelEvent) => {
    if (!this.mouseLookEnabled || this.editorActive || !['chase', 'far', 'drone'].includes(this.cameraMode)) return;
    const target = event.target; if (target instanceof Element && target.closest('dialog,input,select,textarea,.settings-panel')) return;
    event.preventDefault();
    this.cameraOptions.distance = THREE.MathUtils.clamp(this.cameraOptions.distance * (event.deltaY > 0 ? 1.07 : 1 / 1.07), .6, 1.8);
    this.onCameraDistance?.(this.cameraOptions.distance);
  };
  private editorWheel = (event: WheelEvent) => {
    if (!this.editorActive) return;
    // Deliberately unrestricted for precise grid placement on large circuits.
    event.preventDefault(); this.editorZoom *= event.deltaY > 0 ? 1.12 : .84;
  };
  private box(w: number,h: number,l: number,p: THREE.Vector3, q: THREE.Quaternion, mat: THREE.Material) {
    const geometry = new THREE.BoxGeometry(w,h,l);
    geometry.applyMatrix4(new THREE.Matrix4().compose(p,q,new THREE.Vector3(1,1,1)));
    const batch = this.staticBatches.get(mat) ?? []; batch.push(geometry); this.staticBatches.set(mat,batch);
  }
  private ribbon(points: RoadPoint[], from: number, to: number, lift = .02) {
    const positions = new Float32Array(points.length * 6);
    points.forEach((point, index) => {
      const a = interpolateRoad(point, from, lift), b = interpolateRoad(point, to, lift);
      positions.set([a.x, a.y, a.z, b.x, b.y, b.z], index * 6);
    });
    const indices = new Uint32Array((points.length - 1) * 6);
    for (let index = 0; index < points.length - 1; index++) {
      const vertex = index * 2;
      indices.set([vertex, vertex + 2, vertex + 1, vertex + 1, vertex + 2, vertex + 3], index * 6);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1)); geometry.computeVertexNormals();
    return geometry;
  }
  private roadSide(points: RoadPoint[], edge: 'left'|'right', depth = .55) {
    const positions=new Float32Array(points.length*6);
    points.forEach((point,index)=>{const p=point[edge];positions.set([p.x,p.y-.02,p.z,p.x,p.y-depth,p.z],index*6);});
    const indices=new Uint32Array((points.length-1)*6);
    for(let index=0;index<points.length-1;index++){const vertex=index*2;indices.set(edge==='left'?[vertex,vertex+1,vertex+2,vertex+1,vertex+3,vertex+2]:[vertex,vertex+2,vertex+1,vertex+1,vertex+2,vertex+3],index*6);}
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));geometry.setIndex(new THREE.BufferAttribute(indices,1));geometry.computeVertexNormals();return geometry;
  }
  /**
   * Compiles shaders and uploads geometry and textures for everything a race
   * can show, including scenery outside the current view, hidden cockpit parts,
   * the ghost and the start lights. Otherwise each first sighting stalls the GPU
   * mid-race. One scissored draw of a single pixel does all of it at load time.
   */
  /**
   * renderer.compileAsync, but tolerant of materials disposed mid-compile (a track swap during a menu warm-up):
   * three r180 polls every material's program and throws on one that no longer has a program.
   */
  private compileInBackground(target:THREE.Object3D,scene?:THREE.Scene) {
    let pending:Set<THREE.Material>;
    try{pending=this.renderer.compile(target,this.camera,scene);}catch(error){console.warn('Shader warmup failed.',error);return Promise.resolve();}
    return new Promise<void>(resolve=>{
      const check=()=>{
        for(const material of pending){const program=(this.renderer.properties.get(material) as {currentProgram?:{isReady():boolean}}).currentProgram;if(!program||program.isReady())pending.delete(material);}
        if(pending.size)setTimeout(check,10);else resolve();
      };
      check();
    });
  }
  async prewarm(roots:THREE.Object3D[]=[this.venueGroup,this.trackGroup,this.car,this.ghost,this.startLight]) {
    const reveal=()=>{
      const saved:[THREE.Object3D,boolean,boolean][]=[];
      for(const root of roots)root.traverse(object=>{
        saved.push([object,object.frustumCulled,object.visible]);object.frustumCulled=false;
        // Venue pieces hidden by the track itself stay hidden in races too.
        if(object===root||(root!==this.venueGroup&&root!==this.trackGroup))object.visible=true;
      });
      return ()=>{for(const [object,culled,visible] of saved){object.frustumCulled=culled;object.visible=visible;}};
    };
    // Compile in the background first (KHR_parallel_shader_compile), so the
    // upload draw below never waits on the shader compiler.
    let restore=reveal();
    const compiled=this.compileInBackground(this.scene);
    restore();await compiled;
    restore=reveal();const scissor=this.renderer.getScissorTest();
    try{this.renderer.setScissorTest(true);this.renderer.setScissor(0,0,1,1);this.renderer.render(this.scene,this.camera);}
    finally{this.renderer.setScissorTest(scissor);this.renderer.setScissor(0,0,this.canvas.width,this.canvas.height);restore();}
  }
  /** Paints each timing gate across the asphalt it was measured against. */
  private markGates(track: Track) {
    const marked={track,checkpoints:track.checkpoints,finish:track.finish};this.markedGates=marked;
    this.clearGateMarkings();
    // Free roam paints no timing gates; the cone course reveals its own when it starts.
    if(track.kind==='lot')return;
    void collisionGeometry(track).catch(()=>undefined).then(mesh=>{
      if(this.markedGates!==marked)return;
      const gates=fittedGates(track,mesh);
      gates.checkpoints.forEach(gate=>this.gateMarkings.add(this.gateMarking(gate,'checkpoint')));
      this.gateMarkings.add(this.gateMarking(gates.finish,'finish'));
      this.prewarm([this.gateMarkings]);
    });
  }
  private clearGateMarkings() {
    this.gateMarkings.traverse(object=>{if(object instanceof THREE.Mesh){object.geometry.dispose();const material=object.material as THREE.MeshStandardMaterial;material.map?.dispose();material.dispose();}});
    this.gateMarkings.clear();
  }
  private gateMarking(gate: FittedGate, kind: 'checkpoint'|'finish') {
    const finish=kind==='finish',depth=finish?1.6:1.2,square=.8;
    const canvas=document.createElement('canvas'),context=canvas.getContext('2d')!;
    if(finish){
      // Two rows of 0.8 m squares; the texture repeats across the road.
      canvas.width=canvas.height=64;
      for(let x=0;x<2;x++)for(let y=0;y<2;y++){context.fillStyle=(x+y)%2?'#14191c':'#f4f2ea';context.fillRect(x*32,y*32,32,32);}
    }else{
      canvas.width=4;canvas.height=64;
      context.fillStyle='#f4f2ea';context.fillRect(0,0,4,64);context.fillStyle='#1fc9b8';context.fillRect(0,8,4,48);
    }
    const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;texture.wrapS=THREE.RepeatWrapping;
    texture.magFilter=finish?THREE.NearestFilter:THREE.LinearFilter;texture.anisotropy=8;
    const columns:number[]=[];for(let lateral=gate.roadLeft;lateral<gate.roadRight;lateral+=GATE_STEP)columns.push(lateral);columns.push(gate.roadRight);
    const rows=finish?[-.8,-.4,0,.4,.8]:[-.6,0,.6];
    const positions=new Float32Array(columns.length*rows.length*3),uvs=new Float32Array(columns.length*rows.length*2),indices:number[]=[];
    rows.forEach((along,row)=>columns.forEach((lateral,column)=>{
      const index=row*columns.length+column,x=gate.position.x+gate.forward.x*along+gate.side.x*lateral,z=gate.position.z+gate.forward.z*along+gate.side.z*lateral;
      positions.set([x,gate.heightAt(along,lateral)+.035,z],index*3);
      uvs.set([finish?(lateral-gate.roadLeft)/(square*2):0,(along+depth/2)/depth],index*2);
      if(row&&column){const a=(row-1)*columns.length+column-1,b=row*columns.length+column-1;indices.push(a,a+1,b,a+1,b+1,b);}
    }));
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));geometry.setAttribute('uv',new THREE.BufferAttribute(uvs,2));
    geometry.setIndex(indices);geometry.computeVertexNormals();
    const marking=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({map:texture,emissive:0xffffff,emissiveMap:texture,emissiveIntensity:.18,roughness:.75,side:THREE.DoubleSide}));
    this.decalBias(marking.material,-2,-2);marking.receiveShadow=true;marking.name=`${kind}-marking`;
    return marking;
  }
  private gate(gate: Gate, text: string, color: string) {
    const group = new THREE.Group(); group.position.copy(gate.position); group.quaternion.copy(gate.rotation);
    const mat = material(color);
    for (const side of [-1,1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.7,6.7,0.8),mat);
      post.position.set(side*(gate.width/2+0.1),3.1,0); post.castShadow = true; group.add(post);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(gate.width+1.1,1.3,0.8),mat);
    beam.position.y = 6.2; beam.castShadow = true; group.add(beam);
    const c = document.createElement('canvas'); c.width = 512; c.height = 80;
    const ctx = c.getContext('2d')!; ctx.fillStyle = color; ctx.fillRect(0,0,512,80);
    ctx.fillStyle = '#132b3b'; ctx.font = 'bold 42px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text,256,43);
    const texture = new THREE.CanvasTexture(c); texture.colorSpace = THREE.SRGBColorSpace;
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(gate.width-1,1.2),new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide }));
    sign.position.set(0,6.2,-0.415); sign.rotation.y = Math.PI; group.add(sign);
    for (let i=0;i<18;i++) for(let j=0;j<2;j++) {
      const check = new THREE.Mesh(new THREE.BoxGeometry(gate.width/18,0.025,0.6),this.mats[(i+j)%2 ? 'navy' : 'edge']);
      check.position.set(-gate.width/2+(i+0.5)*gate.width/18,0.022,j*0.6); group.add(check);
    }
    this.trackGroup.add(group);
  }
  private disposeObject(root:THREE.Object3D) {
    root.traverse(object=>{if(!(object instanceof THREE.Mesh))return;object.geometry.dispose();(object.userData.apexLod as THREE.BufferGeometry|undefined)?.dispose();const materials=Array.isArray(object.material)?object.material:[object.material];materials.forEach(item=>{for(const value of Object.values(item))if(value instanceof THREE.Texture)value.dispose();item.dispose();});});
  }
  private splitVenueForCulling(root: THREE.Object3D, cell=180, maxChunks=256, simplifier?:typeof import('meshoptimizer').MeshoptSimplifier) {
    // Several supplied GLBs contain a single large ground/venue mesh. Its
    // bounds span the circuit, making normal frustum culling ineffective: the
    // chase camera keeps submitting every triangle even though only a small
    // part is visible. Split only very large, single-material static meshes
    // into spatial chunks. Attribute buffers stay shared, so this adds no
    // duplicate texture or vertex memory.
    const candidates: THREE.Mesh[]=[];
    root.traverse(object=>{if(object instanceof THREE.Mesh)candidates.push(object);});
    for(const mesh of candidates){
      const source=mesh.geometry, position=source.getAttribute('position') as THREE.BufferAttribute|undefined;
      const index=source.getIndex(), triangleCount=(index?.count??position?.count??0)/3;
      if(!position||triangleCount<15000||Array.isArray(mesh.material)||source.groups.length>1||Object.keys(source.morphAttributes).length)continue;
      const chunks=new Map<string,number[]>(), centroid=new THREE.Vector3();
      for(let offset=0;offset<triangleCount*3;offset+=3){
        const a=index?index.getX(offset):offset,b=index?index.getX(offset+1):offset+1,c=index?index.getX(offset+2):offset+2;
        // Optimized GLBs commonly store normalized local vertices under a
        // circuit-sized node transform. Spatial keys must therefore use world
        // coordinates; local coordinates collapsed an entire venue into one
        // chunk and defeated frustum culling while the car was moving.
        centroid.set((position.getX(a)+position.getX(b)+position.getX(c))/3,(position.getY(a)+position.getY(b)+position.getY(c))/3,(position.getZ(a)+position.getZ(b)+position.getZ(c))/3).applyMatrix4(mesh.matrixWorld);
        const key=`${Math.floor(centroid.x/cell)}:${Math.floor(centroid.z/cell)}`,next=chunks.get(key)??[];next.push(a,b,c);chunks.set(key,next);
      }
      if(chunks.size<2||chunks.size>maxChunks||!mesh.parent)continue;
      // Far chunks get a decimated index buffer over the same vertex buffers (no extra vertex memory).
      // Absolute error is in local units, so convert a ~1.5 m world tolerance. Cutout/blended materials keep full detail.
      let flat:Float32Array|undefined;const material=mesh.material as THREE.Material;
      const lodEligible=!!simplifier&&!material.transparent&&material.alphaTest===0&&!material.userData.apexRoadOverlay;
      const localError=1.5/Math.max(1e-6,mesh.matrixWorld.getMaxScaleOnAxis());
      const parent=mesh.parent, group=new THREE.Group();group.name=mesh.name;group.matrix.copy(mesh.matrix);group.matrixAutoUpdate=false;group.layers.mask=mesh.layers.mask;
      for(const values of chunks.values()){
        const geometry=new THREE.BufferGeometry();
        for(const [name,attribute] of Object.entries(source.attributes))geometry.setAttribute(name,attribute);
        geometry.setIndex(values);geometry.drawRange.start=0;geometry.drawRange.count=values.length;
        const box=new THREE.Box3();
        for(const vertex of values)box.expandByPoint(new THREE.Vector3(position.getX(vertex),position.getY(vertex),position.getZ(vertex)));
        geometry.boundingBox=box;geometry.boundingSphere=box.getBoundingSphere(new THREE.Sphere());
        const chunk=new THREE.Mesh(geometry,mesh.material);
        if(lodEligible&&values.length>=3600){
          if(!flat){flat=new Float32Array(position.count*3);for(let i=0;i<position.count;i++){flat[i*3]=position.getX(i);flat[i*3+1]=position.getY(i);flat[i*3+2]=position.getZ(i);}}
          const [reduced]=simplifier!.simplify(new Uint32Array(values),flat,3,Math.max(900,Math.floor(values.length*.2/3)*3),localError,['LockBorder','ErrorAbsolute']);
          if(reduced.length<values.length*.7){
            const lod=new THREE.BufferGeometry();
            for(const [name,attribute] of Object.entries(source.attributes))lod.setAttribute(name,attribute);
            lod.setIndex(new THREE.BufferAttribute(reduced,1));lod.boundingBox=box;lod.boundingSphere=geometry.boundingSphere;
            chunk.userData.apexLod=lod;
          }
        }
        chunk.castShadow=mesh.castShadow;chunk.receiveShadow=mesh.receiveShadow;chunk.renderOrder=mesh.renderOrder;chunk.layers.mask=mesh.layers.mask;group.add(chunk);
      }
      parent.add(group);parent.remove(mesh);
    }
  }
  /** Records each static venue piece's world-space bounds so far pieces can skip the draw. */
  private registerDistanceCulling(root:THREE.Object3D) {
    root.updateMatrixWorld(true);
    this.cullEntries=[];
    root.traverse(object=>{
      if(!(object instanceof THREE.Mesh)||!object.visible)return;
      if(!object.geometry.boundingSphere)object.geometry.computeBoundingSphere();
      const sphere=object.geometry.boundingSphere!.clone().applyMatrix4(object.matrixWorld);
      this.cullEntries.push({mesh:object,center:sphere.center,radius:sphere.radius,full:object.geometry,lod:object.userData.apexLod});
    });
    this.cullFar=-1;
  }
  /** Hides venue pieces wholly beyond the fog, so distant scenery costs no draw calls. */
  private cullVenue(far:number) {
    const position=this.camera.position;
    if(far===this.cullFar&&position.distanceToSquared(this.cullAt)<625)return;
    this.cullFar=far;this.cullAt.copy(position);
    const lodAt=this.options?.lodDistance??0;
    // Small props vanish sooner: they are already hazy and cover few pixels, while big chunks (ground, stands) stay until fully fogged.
    for(const entry of this.cullEntries){
      const reach=(entry.radius<30?far*.6:entry.radius<80?far*.85:far)+150;
      const gap=position.distanceTo(entry.center)-entry.radius;
      entry.mesh.visible=gap<reach;
      // Hysteresis keeps a chunk at the LOD boundary from flipping geometry every pass.
      if(entry.lod)entry.mesh.geometry=lodAt>0&&gap>(entry.mesh.geometry===entry.lod?lodAt-30:lodAt+30)?entry.lod:entry.full;
    }
  }
  private async loadVenue(track:Track) {
    this.venueLoadError='';
    const token=++this.venueLoadToken;this.disposeObject(this.venueGroup);this.venueGroup.clear();this.cullEntries=[];this.cullFar=-1;
    const filename=track.model;if(!filename)return;
    try{
      // Clean runtime meshes preserve road markings and thin scenery. The same
      // asset is used by the collision builder; supplied originals stay intact.
      const raceFilename=track.runtimeModel??filename.replace(/\.glb$/,'.race.glb');
      let gltf;
      try { gltf=await this.loader.loadAsync(assetUrl(`models/tracks/${raceFilename}`)); }
      catch { gltf=await this.loader.loadAsync(assetUrl(`models/tracks/${filename}`)); }
      if(token!==this.venueLoadToken){this.disposeObject(gltf.scene);return;}
      const model=gltf.scene;model.updateMatrixWorld(true);
      let simplifier;try{const {MeshoptSimplifier}=await import('meshoptimizer');await MeshoptSimplifier.ready;if(MeshoptSimplifier.supported)simplifier=MeshoptSimplifier;}catch(error){console.warn('Venue LOD unavailable.',error);}
      if(token!==this.venueLoadToken){this.disposeObject(model);return;}
      this.splitVenueForCulling(model,180,256,simplifier);
      const overlayOrder=new Map<THREE.Material,number>();
      model.traverse(object=>{if(!(object instanceof THREE.Mesh))return;object.castShadow=false;object.receiveShadow=true;const materials=Array.isArray(object.material)?object.material:[object.material];materials.forEach(item=>{
        for(const value of Object.values(item))if(value instanceof THREE.Texture){value.minFilter=THREE.LinearMipmapLinearFilter;value.generateMipmaps=true;value.needsUpdate=true;}
        if(item instanceof THREE.MeshStandardMaterial&&/^(?:asph|road|tarmac)|^doted_line/i.test(item.name)){
          item.roughness=Math.max(.9,item.roughness);item.metalness=0;
        }
        // Only actual decals get bias. "roadt" also matched base road surfaces,
        // pulling the road through its own markings at shallow camera angles.
        if(item.userData.apexRoadOverlay||/^(?:line|groove|stripe|rubber|doted)(?:\b|_|\d)|^ROADTSTRIPE|^asph_patch_joint/i.test(item.name)){
          item.depthWrite=!item.transparent;this.decalBias(item,-1,-4);
          // Keep blended road layers in a stable order as the camera moves.
          // Draw them before car glass, which deliberately does not write depth.
          if(!overlayOrder.has(item)){
            overlayOrder.set(item,overlayOrder.size);
            // gl_FragDepth overrides fixed-function polygon bias. Apply a
            // 3 cm view-depth bias plus slope bias in logarithmic space keeps
            // shallow-angle decals visible where exported layers intersect.
            item.onBeforeCompile=(shader:THREE.WebGLProgramParametersWithUniforms)=>{
              shader.fragmentShader=shader.fragmentShader.replace('#include <logdepthbuf_fragment>',`#include <logdepthbuf_fragment>
                #if defined( USE_LOGARITHMIC_DEPTH_BUFFER )
                  float decalSlope = max(abs(dFdx(gl_FragDepth)), abs(dFdy(gl_FragDepth)));
                  if(vIsPerspective != 0.0) gl_FragDepth = log2(max(0.000001, vFragDepth - 0.03)) * logDepthBufFC * 0.5 - decalSlope * 2.0;
                #endif`);
            };
            item.customProgramCacheKey=()=> 'apex-road-decal-log-depth-v1';
            item.needsUpdate=true;
          }
          object.renderOrder=item.transparent?-1000+overlayOrder.get(item)!:2;
        }
      });});
      this.registerDistanceCulling(model);
      this.tuneTextures(model);this.venueGroup.add(model);this.venueGroup.visible=this.trackGroup.visible;this.setWeather(this.weather.preset);
      this.prewarm();
    }catch(error){if(token===this.venueLoadToken)this.venueLoadError=`Could not load ${track.name}. Return to the lobby and retry.`;console.warn(`Could not load the detailed venue for ${track.name}.`,error);}
  }
  /** Builds the Training Grounds once; switching between free roam and the cone course keeps the scenery. */
  private setLot(track: Track) {
    const same = !!this.lotScene && this.lotScene.lot === track.lot;
    this.currentTrack = track; this.markedGates = undefined;
    if (!same) {
      this.weatherMaterials.clear();
      this.trackGroup.traverse(obj => { if (obj instanceof THREE.Mesh) { obj.geometry.dispose(); const mats = Array.isArray(obj.material) ? obj.material : [obj.material]; for(const m of mats) if(!Object.values(this.mats).includes(m)) { for(const value of Object.values(m))if(value instanceof THREE.Texture)value.dispose(); m.dispose(); } } });
      this.trackGroup.clear(); this.staticBatches.clear();
      this.lotScene = new LotScene(track.lot!, (material, factor, units) => this.decalBias(material, factor, units));
      this.trackGroup.add(this.lotScene.group, this.gateMarkings);
      this.center.set(-10, 0, 0); this.trackRadius = track.lot!.half * 1.25;
      this.venueReady = this.loadVenue(track);
      void this.prewarm([this.trackGroup]);
    }
    const spawn = spawnGate(track);
    this.car.position.copy(spawn.position); this.car.position.y += 0.82; this.car.quaternion.copy(spawn.rotation);
    this.ghost.visible = false;
    if (!same) this.overview(0, true);
  }
  /** Per-frame Training Grounds animation: cones and the start-box pulse. */
  updateLot(sim: Simulation | undefined, dt: number, showStart: boolean) { this.lotScene?.update(sim, dt, showStart); }
  setTrack(track: Track) {
    if (track.lot) { this.setLot(track); return; }
    this.lotScene = undefined;
    this.weatherMaterials.clear();
    this.currentTrack = track;
    this.trackGroup.traverse(obj => { if (obj instanceof THREE.Mesh) { obj.geometry.dispose(); const mats = Array.isArray(obj.material) ? obj.material : [obj.material]; for(const m of mats) if(!Object.values(this.mats).includes(m)) { m.map?.dispose(); m.dispose(); } } });
    this.trackGroup.clear(); this.staticBatches.clear();
    this.markedGates=undefined;this.trackGroup.add(this.gateMarkings);
    const bounds = new THREE.Box3();
    const road = buildRoadMesh(track);
    const roadGeometry = new THREE.BufferGeometry();
    roadGeometry.setAttribute('position', new THREE.BufferAttribute(road.vertices, 3));
    const roadUv=new Float32Array(road.points.length*4);road.points.forEach((point,index)=>roadUv.set([0,point.distance/7,1,point.distance/7],index*4));
    roadGeometry.setAttribute('uv',new THREE.BufferAttribute(roadUv,2));
    roadGeometry.setIndex(new THREE.BufferAttribute(road.indices, 1)); roadGeometry.computeVertexNormals();
    const roadMesh = new THREE.Mesh(roadGeometry, this.mats.road); roadMesh.receiveShadow = true;roadMesh.visible=!track.model;
    this.trackGroup.add(roadMesh);
    for(const edge of ['left','right'] as const){const side=new THREE.Mesh(this.roadSide(road.points,edge),this.mats.roadSide);side.receiveShadow=true;side.visible=!track.model;this.trackGroup.add(side);}
    // The shoulder, painted edge line, and faint tire paths share the exact road
    // sampling used by collision, so all of the surface layers stay sealed.
    for(const [from,to,mat,lift] of [[0,.055,this.mats.edge,.035],[.945,1,this.mats.edge,.035],[.055,.068,this.mats.edge,.045],[.932,.945,this.mats.edge,.045],[.3,.36,this.mats.tire,.026],[.64,.7,this.mats.tire,.026]] as const){
      const strip=new THREE.Mesh(this.ribbon(road.points,from,to,lift),mat);strip.receiveShadow=true;strip.visible=!track.model;this.trackGroup.add(strip);
    }
    for (let index = 0; index < road.points.length - 1; index++) {
      const start = road.points[index], end = road.points[index + 1];
      bounds.expandByPoint(new THREE.Vector3().copy(start.center));
      for (const edge of ['left','right'] as const) {
        const a = start[edge], b = end[edge], d = direction(a, b);
        const q = new THREE.Quaternion().copy(orientation(d));
        const length = new THREE.Vector3().copy(a).distanceTo(b);
        const mid = new THREE.Vector3((a.x+b.x)/2,(a.y+b.y)/2+.36,(a.z+b.z)/2);
        this.box(.18,.54,length+.08,mid,q,this.mats.barrier);
        if(index%3===0)this.box(.16,.82,.16,new THREE.Vector3(a.x,a.y+.12,a.z),new THREE.Quaternion(),this.mats.barrier);
      }
      if(index%2===0)for(const across of [.027,.973]){
        const a=interpolateRoad(start,across,.065),b=interpolateRoad(end,across,.065),d=direction(a,b),q=new THREE.Quaternion().copy(orientation(d));
        this.box(.72,.055,new THREE.Vector3().copy(a).distanceTo(b)*.88,new THREE.Vector3((a.x+b.x)/2,(a.y+b.y)/2,(a.z+b.z)/2),q,index%4===0?this.mats.orange:this.mats.edge);
      }
    }
    bounds.expandByPoint(new THREE.Vector3().copy(road.points.at(-1)!.center));
    for (const [i,s] of track.segments.entries()) {
      const d = direction(s.start,s.end), q = new THREE.Quaternion().copy(orientation(d));
      const length = new THREE.Vector3().copy(s.start).distanceTo(s.end);
      const mid = new THREE.Vector3().copy(s.start).add(s.end).multiplyScalar(0.5);
      if(s.surface==='boost') {
        const first=road.points.findIndex(point=>point.segment===i);let last=first;
        while(last+1<road.points.length&&road.points[last+1].segment===i)last++;
        const section=road.points.slice(Math.max(0,first),Math.min(road.points.length,last+2));
        if(section.length>1){const boost=new THREE.Mesh(this.ribbon(section,.15,.85,.055),this.mats.teal);boost.receiveShadow=true;boost.visible=!track.model;this.trackGroup.add(boost);}
      }
      if(i%3===0)this.box(2.2,mid.y+1,2.2,new THREE.Vector3(mid.x,(mid.y-1)/2,mid.z),new THREE.Quaternion(),this.mats.navy);
    }
    this.center.copy(bounds.getCenter(new THREE.Vector3()));
    this.trackRadius=Math.max(250,bounds.getSize(new THREE.Vector3()).length()*.5);
    this.venueReady = this.loadVenue(track);
    if(!track.model){
      this.gate({...track.start,position:{x:track.start.position.x-track.start.forward.x*14,y:track.start.position.y,z:track.start.position.z-track.start.forward.z*14}},'APEX  /  START','#f1eee3');
      track.checkpoints.forEach((gate,i)=>this.gate(gate,`CHECKPOINT  ${i+1}`,'#65d5cc'));
      this.gate(track.finish,'FINISH','#ff784c');
    }
    let seed = track.name.length * 7451;
    const random = () => { seed = (Math.imul(seed,1664525)+1013904223)>>>0; return seed/4294967296; };
    // Deliberately faceted islands and distant silhouettes, all generated as native game geometry.
    for(let i=0;i<32;i++) {
      const angle=random()*Math.PI*2, radius=100+random()*400;
      const x=this.center.x+Math.cos(angle)*radius,z=this.center.z+Math.sin(angle)*radius;
      const nearRoad=track.segments.some(s=>new THREE.Vector2(s.start.x-x,s.start.z-z).length()<28);
      if(nearRoad) continue;
      const size=18+random()*35;
      const island=new THREE.Mesh(new THREE.DodecahedronGeometry(size,0),this.mats.sand);
      island.position.set(x,-6,z); island.scale.set(1,0.25,1); island.rotation.y=random()*5;
      island.receiveShadow=true;island.visible=!track.model; this.trackGroup.add(island);
      if(i%3===0) {
        const rock=new THREE.Mesh(new THREE.ConeGeometry(size*0.65,size*0.95,5),this.mats.rock);
        rock.position.set(x,size*0.25,z); rock.rotation.y=random()*5; rock.castShadow=true;rock.visible=!track.model; this.trackGroup.add(rock);
      } else for(let j=0;j<3;j++) {
        const tx=x+(random()-.5)*size,tz=z+(random()-.5)*size;
        const tree=new THREE.Mesh(new THREE.ConeGeometry(3+random()*2,12+random()*7,5),this.mats.leaf);
        tree.position.set(tx,5,tz); tree.castShadow=true;tree.visible=!track.model; this.trackGroup.add(tree);
        this.box(0.7,6,0.7,new THREE.Vector3(tx,1.5,tz),new THREE.Quaternion(),this.mats.navy);
      }
    }
    for(let i=0;i<12;i++) {
      const mountain = new THREE.Mesh(new THREE.ConeGeometry(80+random()*60,90+random()*130,5),material(i%2?0x94b9c0:0xabc8c9));
      const angle=i/12*Math.PI*2; mountain.position.set(this.center.x+Math.cos(angle)*650,20,this.center.z+Math.sin(angle)*650);
      mountain.rotation.y = i;mountain.visible=!track.model; this.trackGroup.add(mountain);
    }
    for(const [mat,geometries] of this.staticBatches) {
      const merged=mergeGeometries(geometries); const mesh=new THREE.Mesh(merged,mat);
      mesh.castShadow=true; mesh.receiveShadow=true;mesh.visible=!track.model; this.trackGroup.add(mesh); geometries.forEach(g=>g.dispose());
    }
    this.staticBatches.clear();
    const spawn = spawnGate(track);
    this.car.position.copy(spawn.position);this.car.position.y+=0.82;this.car.quaternion.copy(spawn.rotation);
    this.garageGroup.position.set(0,0,0);
    this.ghost.visible=false;
    this.overview(0, true);
  }
  private buildPlaceholder(group: THREE.Group, ghost: boolean) {
    const paint = new THREE.MeshStandardMaterial({color:ghost?0x61e7e0:0xff683b,roughness:.5,metalness:.15,transparent:ghost,opacity:ghost?.32:1,depthWrite:!ghost});
    const dark=new THREE.MeshStandardMaterial({color:0x172934,roughness:.7,transparent:ghost,opacity:ghost?.2:1,depthWrite:!ghost});
    const cream=new THREE.MeshStandardMaterial({color:0xf0edda,roughness:.6,transparent:ghost,opacity:ghost?.3:1,depthWrite:!ghost});
    const part=(w:number,h:number,l:number,x:number,y:number,z:number,mat:THREE.Material)=>{
      const mesh=new THREE.Mesh(new THREE.BoxGeometry(w,h,l),mat);mesh.position.set(x,y,z);mesh.castShadow=!ghost;group.add(mesh);return mesh;
    };
    part(1.45,.4,2.9,0,0,0,paint);part(.78,.33,1.5,0,.25,-.2,paint);
    const glass=part(.66,.24,.8,0,.42,-.1,dark);glass.rotation.x=-.13;
    part(.18,.025,3.0,0,.22,0,cream);part(.55,.22,1.05,0,-.04,1.65,paint);
    part(2.25,.12,.4,0,-.15,1.8,dark);part(2.25,.16,.5,0,.5,-1.5,paint);
    for(const x of [-.65,.65])part(.12,.6,.15,x,.19,-1.45,dark);
    for(let i=0;i<4;i++) {
      const wheel=new THREE.Group();wheel.position.set(i%2?.99:-.99,-.28,i<2?1.15:-1.1);
      const tire=new THREE.Mesh(new THREE.CylinderGeometry(.4,.4,.37,12),dark);tire.rotation.z=Math.PI/2;tire.castShadow=!ghost;wheel.add(tire);
      const rim=new THREE.Mesh(new THREE.CylinderGeometry(.21,.21,.385,8),cream);rim.rotation.z=Math.PI/2;wheel.add(rim);
      group.add(wheel);if(!ghost)this.wheelGroups.push(wheel);
    }
  }
  async partyModel(carId: CarId) {
    return (await this.loadModel(carId)).clone(true);
  }
  private loadModel(carId: CarId) {
    const cached = this.modelCache.get(carId);
    if (cached) return cached;
    const definition = carById(carId);
    // Runtime copies (design/build-car-runtime.ts) carry 2048 px WebP textures; fall back to the supplied file.
    const loading = this.loader.loadAsync(assetUrl(`models/cars/runtime/${definition.model}`)).catch(()=>this.loader.loadAsync(assetUrl(`models/cars/${definition.model}`))).then(gltf => {
      const materials=new Set<THREE.Material>();
      gltf.scene.traverse(object=>{if(object instanceof THREE.Mesh)(Array.isArray(object.material)?object.material:[object.material]).forEach(m=>materials.add(m));});
      for(const item of materials){
        if(!(item instanceof THREE.MeshStandardMaterial))continue;
        if(/tire|tyre|rubber/i.test(item.name)){item.roughness=Math.max(.85,item.roughness);item.metalness=0;}
        if(/paint|body|carrosserie/i.test(item.name)&&!item.transparent){item.roughness=Math.min(.32,item.roughness);item.envMapIntensity=1.2;}
        if(/glass|window|windscreen/i.test(item.name)&&item.transparent){item.roughness=Math.min(.12,item.roughness);item.depthWrite=false;item.opacity=Math.min(item.opacity,.24);}
        if(definition.id==='porsche-911-gt3'&&/INT_Glass/i.test(item.name)){item.transparent=true;item.opacity=.08;item.depthWrite=false;item.roughness=.12;item.metalness=0;}
      }
      return prepareCarModel(gltf.scene, definition, this.cinematicActors);
    }).catch(error=>{this.modelCache.delete(carId);throw error;});
    this.modelCache.set(carId, loading); return loading;
  }
  loadGarage() {
    if (this.garageLoad) return this.garageLoad;
    this.garageLoad = this.loader.loadAsync(assetUrl('models/garage/car_garage.glb')).then(({scene})=>{
      scene.traverse(object=>{
        if(object.name.toLowerCase()==='car')object.visible=false;
        if(object instanceof THREE.Mesh){object.castShadow=false;object.receiveShadow=false;}
      });
      scene.scale.setScalar(1.3);
      scene.position.set(1.158,0,-.744);
      this.garageGroup.add(scene);
    }).catch(error=>{this.garageLoad=undefined;console.warn('Could not load garage.',error);});
    return this.garageLoad;
  }
  async setCar(carId: CarId) {
    const token = ++this.carLoadToken; this.currentCarId = carId; this.wheelGroups = [];this.cockpitEye=undefined;this.legacyCockpitEye=undefined;
    this.carRig?.dispose();this.carRig=undefined;this.visualCarReady=false;this.contactTick=-1;this.visibleWheelFloors=[];
    this.car.clear();
    try {
      const prepared = await this.loadModel(carId);
      if (token !== this.carLoadToken) return false;
      const model=prepared.clone(true),eye=model.userData.cockpitEye;this.cockpitEye=eye?new THREE.Vector3(eye.x,eye.y,eye.z):undefined;
      this.tuneTextures(model);
      const legacy=model.userData.legacyCockpitEye;this.legacyCockpitEye=legacy?new THREE.Vector3(legacy.x,legacy.y,legacy.z):undefined;
      model.traverse(object=>{if(object instanceof THREE.Mesh){const materials=Array.isArray(object.material)?object.material:[object.material];object.castShadow=materials.some(m=>!m.transparent);object.receiveShadow=true;}});
      this.car.clear();this.car.add(model);this.carRig=new CarRig(model,carById(carId));this.wheelGroups=this.carRig.wheels;this.visualCarReady=false;this.prewarm([this.car]);return true;
    } catch (error) {
      console.warn(`Could not load ${carById(carId).name}.`, error); return false;
    }
  }
  private ghostCarId?: CarId;
  async setGhostCar(carId: CarId) {
    // Restarts reuse the prepared ghost; rebuilding its materials stalled each retry.
    if (this.ghostCarId === carId) { this.ghostLoadToken++; return true; }
    const token = ++this.ghostLoadToken; const wasVisible = this.ghost.visible;
    try {
      const prepared = await this.loadModel(carId);
      if (token !== this.ghostLoadToken) return false;
      const ghostModel = prepared.clone(true);
      ghostModel.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        const ghostMaterial = (source: THREE.Material) => {
          const next = source.clone(); next.transparent = true; next.opacity = .28; next.depthWrite = false;
          if ('color' in next && next.color instanceof THREE.Color) next.color.lerp(new THREE.Color(0x61e7e0), .62);
          return next;
        };
        object.material = Array.isArray(object.material) ? object.material.map(ghostMaterial) : ghostMaterial(object.material);
        object.castShadow = false;
      });
      this.ghost.clear(); this.ghost.add(ghostModel); this.ghostCarId = carId; this.prewarm([this.ghost]); this.ghost.visible = wasVisible; return true;
    } catch (error) {
      console.warn(`Could not load the ${carById(carId).name} ghost model.`, error); return false;
    }
  }
  overview(dt:number,snap=false) {
    this.wideView=true;
    this.camera.up.set(0,1,0); this.camera.near = .2;
    this.trackGroup.visible = true; this.venueGroup.visible = true; this.garageGroup.visible = false; this.car.visible = true;
    this.clock+=dt;
    const wobble=this.reducedMotion?0:Math.sin(this.clock*.09)*.055;
    const distance=Math.max(innerWidth<900?1.5:1.28,this.trackRadius/230);
    const target = this.center.clone().add(new THREE.Vector3(-115,190,-260).multiplyScalar(distance));
    target.x+=wobble*150;
    if(snap)this.camera.position.copy(target);else this.camera.position.lerp(target,1-Math.exp(-dt*3));
    this.cameraTarget.copy(this.center).add(new THREE.Vector3(-45,-18,0));
    this.camera.lookAt(this.cameraTarget); this.camera.fov=46;this.camera.filmOffset=innerWidth>900?-5.5:0;this.camera.updateProjectionMatrix();
  }
  editor(dt:number,snap=false) {
    this.wideView=true;
    this.trackGroup.visible = false; this.venueGroup.visible = true; this.garageGroup.visible = false; this.car.visible = false; this.ghost.visible = false;
    const radius = Math.max(420, this.trackRadius * 1.45) * this.editorZoom;
    const panX = Number(this.editorPanKeys.has('d')) - Number(this.editorPanKeys.has('a'));
    const panZ = Number(this.editorPanKeys.has('s')) - Number(this.editorPanKeys.has('w'));
    if (panX || panZ) {
      const length = Math.hypot(panX, panZ);
      const speed = radius * .72;
      this.editorPan.add(new THREE.Vector2(panX / length * speed * dt, panZ / length * speed * dt));
    }
    const focus = this.center.clone().add(new THREE.Vector3(this.editorPan.x, 0, this.editorPan.y));
    const target = focus.clone().add(new THREE.Vector3(0, radius * 1.22, radius * .16));
    if (snap) { this.camera.position.copy(target); this.cameraTarget.copy(focus); }
    else { this.camera.position.lerp(target, 1 - Math.exp(-dt * 5)); this.cameraTarget.lerp(focus, 1 - Math.exp(-dt * 5)); }
    this.camera.lookAt(this.cameraTarget); this.camera.fov = 44; this.camera.filmOffset = 0; this.camera.updateProjectionMatrix();
  }
  garage(dt:number,snap=false) {
    this.wideView=false;
    this.camera.up.set(0,1,0); this.camera.near = .2;
    this.clock += dt; this.trackGroup.visible = false; this.venueGroup.visible = false; this.garageGroup.visible = true; this.car.visible = true; this.ghost.visible = false;
    this.carRig?.wheels.forEach(wheel=>wheel.position.fromArray(wheel.userData.rest));
    this.carRig?.animate(0,0,0);
    const definition=carById(this.currentCarId);
    this.car.position.set(-3.86,.61+definition.dimensions.wheelRadiusM,2.48);
    this.car.quaternion.setFromAxisAngle(new THREE.Vector3(0,1,0),-Math.PI/2);
    const angle = this.garageAngle;
    const focus = this.car.position.clone().add(new THREE.Vector3(0,.28,-.5));
    const offset = new THREE.Vector3(Math.cos(angle)*7,2.55,-Math.sin(angle)*7);
    const target = focus.clone().add(offset);
    if (snap) this.camera.position.copy(target); else this.camera.position.lerp(target, 1 - Math.exp(-dt * 4));
    this.cameraTarget.lerp(focus, snap ? 1 : 1 - Math.exp(-dt * 7));
    this.camera.lookAt(this.cameraTarget); this.camera.fov = 48; this.camera.filmOffset = innerWidth > 900 ? 2 : 0; this.camera.updateProjectionMatrix();
  }
  chase(sim: Simulation,dt:number,snap=false,frame?:Frame,updateCamera=true) {
    this.wideView=false;
    this.trackGroup.visible = true; this.venueGroup.visible = true; this.garageGroup.visible = false; this.car.visible = true; this.camera.filmOffset=0;
    const f=frame??sim.frame();
    const physicalPosition = new THREE.Vector3(f.p.x,f.p.y,f.p.z);
    const physicalQuaternion = new THREE.Quaternion(f.q.x,f.q.y,f.q.z,f.q.w);
    const travel=snap||!this.visualCarReady?0:physicalPosition.clone().sub(this.lastWheelPosition).dot(new THREE.Vector3(0,0,1).applyQuaternion(physicalQuaternion));
    this.lastWheelPosition.copy(physicalPosition);
    // Downloaded car models have static wheel meshes, while the simulation has
    // live suspension. Lift the visual body by the current compression so tire
    // geometry stays on top of the asphalt, but filter that correction on its
    // own—using raw wheel travel directly is what previously created jitter.
    // A suspension ray can still reach the road after the spring unloads at
    // takeoff. Only load-bearing contacts may fit the model to that road.
    const loadedWheels=[0,1,2,3].filter(i=>sim.vehicle.wheelIsInContact(i)&&(sim.vehicle.wheelSuspensionForce(i)??0)>0);
    const lengths=loadedWheels.map(i=>sim.vehicle.wheelSuspensionLength(i)??.58);
    const targetLift=lengths.length>=3?.58-lengths.reduce((sum,length)=>sum+length,0)/lengths.length:0;
    if(snap||!this.visualCarReady)this.visualSuspensionLift=targetLift;
    else this.visualSuspensionLift=THREE.MathUtils.lerp(this.visualSuspensionLift,targetLift,1-Math.exp(-dt*(sim.grounded?3.2:16)));
    physicalPosition.add(new THREE.Vector3(0,this.visualSuspensionLift,0).applyQuaternion(physicalQuaternion));
    if (snap || !this.visualCarReady) {
      this.visualCarPosition.copy(physicalPosition); this.visualCarQuaternion.copy(physicalQuaternion); this.visualCarReady=true;
    } else {
      // Keep horizontal placement tight while filtering the small vertical,
      // pitch and roll changes created by dense imported asphalt triangles.
      const verticalAlpha=1-Math.exp(-dt*(sim.grounded?4.5:16));
      // The game already interpolates fixed physics ticks. A second horizontal
      // filter put the model metres behind its contacts at racing speeds.
      this.visualCarPosition.x=physicalPosition.x;
      this.visualCarPosition.z=physicalPosition.z;
      this.visualCarPosition.y=THREE.MathUtils.lerp(this.visualCarPosition.y,physicalPosition.y,verticalAlpha);
      this.visualCarQuaternion.slerp(physicalQuaternion,1-Math.exp(-dt*(sim.grounded?4:20)));
      // Pitch/roll may be filtered, but delaying yaw hides the real rear slip
      // and makes the visual nose point away from the tire forces during turns.
      if(sim.grounded){
        const visual=new THREE.Euler().setFromQuaternion(this.visualCarQuaternion,'YXZ');
        visual.y=new THREE.Euler().setFromQuaternion(physicalQuaternion,'YXZ').y;
        this.visualCarQuaternion.setFromEuler(visual);
      }
    }
    this.car.position.copy(this.visualCarPosition);this.car.quaternion.copy(this.visualCarQuaternion);
    if(this.carRig){
      const wheelContacts=this.carRig.wheels.map(w=>sim.track.id==='daytona'?sim.vehicle.wheelIsInContact(w.userData.index):loadedWheels.includes(w.userData.index));
      const supportedBody=loadedWheels.length>=3;
      // Four accelerated physics rays, once per physics tick (also in a static
      // preview). They sample the visible mesh, not the lower smoothed skin.
      if(snap||this.contactTick!==sim.ticks+sim.finishTicks||!this.visibleWheelFloors.length){
        this.visibleWheelFloors=this.carRig.wheels.map((w,i)=>{
          // Visual road fitting must not invent support under an unloaded tire.
          if(!wheelContacts[i])return undefined;
          const p=new THREE.Vector3().fromArray(w.userData.rest).applyQuaternion(this.car.quaternion).add(this.car.position);
          return sim.visibleGroundAt(p);
        });this.contactTick=sim.ticks+sim.finishTicks;
      }
      const up=new THREE.Vector3(0,1,0).applyQuaternion(this.car.quaternion);
      if(up.y>.65){
        let clearance=-Infinity;
        this.carRig.wheels.forEach((wheel,i)=>{
          const floor=this.visibleWheelFloors[i];if(!wheelContacts[i]||floor===undefined)return;
          const bottom=new THREE.Vector3().fromArray(wheel.userData.rest).applyQuaternion(this.car.quaternion).add(this.car.position).y-wheel.userData.radius;
          clearance=Math.max(clearance,floor+.012-bottom);
        });
        // Fit the body and wheels as one assembly. The old upward-only body
        // correction left it hovering while each tire extended up to 42 cm to
        // reach the road. Only a body supported by at least three real tire
        // contacts is fitted to the visible skin. With fewer contacts, keep the
        // physical trajectory so a curb, crest or jump can lift the car.
        if(supportedBody&&Number.isFinite(clearance)){
          // The physics rolls on a smoothed surface; the visible venue mesh still has seams,
          // kerbs and triangle steps. Follow only sustained differences (slow filter, bounded),
          // so tyres stay on the asphalt without the body picking up every visible blip.
          const target=THREE.MathUtils.clamp(clearance,-.12,.12);
          this.visualClearance=snap?target:this.visualClearance+(target-this.visualClearance)*(1-Math.exp(-dt*1.6));
          this.car.position.y+=this.visualClearance;
        }else this.visualClearance*=Math.exp(-dt*3);
        this.carRig.wheels.forEach((wheel,i)=>{
          const floor=this.visibleWheelFloors[i],rest=new THREE.Vector3().fromArray(wheel.userData.rest);
          if(wheelContacts[i]&&floor!==undefined){
            const center=rest.clone().applyQuaternion(this.car.quaternion).add(this.car.position);
            const travel=sim.track.id==='daytona'?Math.min(.22,wheel.userData.radius*.6):Math.min(.045,wheel.userData.radius*.12);
            // Wheels ease toward the visible floor instead of snapping, so mesh texture does not rattle them.
            const fitted=rest.y+THREE.MathUtils.clamp((floor+.012+wheel.userData.radius-center.y)/up.y,-travel,travel);
            wheel.position.y=snap?fitted:THREE.MathUtils.lerp(wheel.position.y,fitted,1-Math.exp(-dt*9));
          }else wheel.position.y=THREE.MathUtils.lerp(wheel.position.y,rest.y,1-Math.exp(-dt*10));
        });
      }else this.carRig.wheels.forEach(w=>{w.position.y=THREE.MathUtils.lerp(w.position.y,w.userData.rest[1],1-Math.exp(-dt*10));});
      // Update before the cockpit-camera branch so interior and exterior views
      // share the same animations; signed travel spins backward in reverse.
      this.carRig.animate(sim.steering,Math.abs(travel)<10?travel:0,sim.brake,sim.track.id==='daytona'?.22:.045);
      this.carRig.instruments.update(sim,dt,this.firstPerson);
    }
    if(!updateCamera)return;
    this.updateCamera(sim,dt,snap);
  }
  /** Positions the race camera for the current view. Exterior views use car-relative springs, so they never trail behind at speed. */
  private updateCamera(sim:Simulation,dt:number,snap:boolean) {
    const rig=this.rig,options=this.cameraOptions,still=this.reducedMotion,now=performance.now();
    rig.time+=dt;
    // Motion cues shared by every view: smoothed velocity and acceleration of the car.
    const linear=sim.car.linvel(),velocity=new THREE.Vector3(linear.x,linear.y,linear.z);
    if(snap||!rig.ready||dt<=0){rig.velocity.copy(velocity);rig.accel.set(0,0,0);}
    else{
      // Respawns and kerb strikes produce huge one-frame spikes; clamp to what tyres can do, then filter slowly.
      const accel=velocity.clone().sub(rig.velocity).divideScalar(Math.max(dt,1/240)).clampLength(0,25);
      rig.accel.lerp(accel,1-Math.exp(-dt*2.2));rig.velocity.copy(velocity);
    }
    // Stabilised anchor: follows the car exactly across the ground, but filters vertical bob from suspension and kerbs.
    if(snap||!rig.stable||dt>.1){rig.anchor.copy(this.car.position);rig.carQ.copy(this.car.quaternion);rig.stable=true;}
    else{
      rig.anchor.x=this.car.position.x;rig.anchor.z=this.car.position.z;
      rig.anchor.y+=(this.car.position.y-rig.anchor.y)*(1-Math.exp(-dt*5));
      rig.carQ.slerp(this.car.quaternion,1-Math.exp(-dt*14));
    }
    const speedMps=sim.speed*sim.track.metersPerUnit;
    // Bumps and wall hits shake the exterior views; reduced motion and the shake setting turn it off.
    if(sim.hitCount!==rig.hits){rig.hits=sim.hitCount;rig.shake=Math.min(1.2,rig.shake+sim.lastHitSpeed/18);}
    rig.shake=Math.min(1.2,rig.shake+Math.min(.12,Math.max(0,sim.suspensionJolt-.02)*1.5))*Math.exp(-dt*6.5);
    // Mouse look drifts back to centre a moment after the mouse stops.
    if(options.recenter&&this.cameraMode!=='cockpit'&&now-this.lookInputAt>1400){const k=1-Math.exp(-dt*2.4);this.lookYaw-=this.lookYaw*k;this.lookPitch-=this.lookPitch*k;}
    if(this.cameraMode==='cockpit'){
      const dimensions = sim.carSpec.dimensions;
      const seat=this.useDetectedSeat?this.cockpitEye:this.legacyCockpitEye;
      const eye = (seat?.clone()??new THREE.Vector3(dimensions.bodyWidthM*.21,-(.58+dimensions.wheelRadiusM)+dimensions.heightM*.78,-dimensions.wheelbaseM*.1)).add(this.cockpitOffset).applyQuaternion(this.car.quaternion).add(this.car.position);
      const yaw=this.lookYaw+(this.lookBack?Math.PI*.82:0),cosPitch = Math.cos(this.lookPitch);
      // Look direction uses the smoothed body orientation, and the horizon is levelled part way, so road texture does not rattle the view.
      const ahead = new THREE.Vector3(Math.sin(yaw)*cosPitch,Math.sin(this.lookPitch),Math.cos(yaw)*cosPitch).applyQuaternion(rig.carQ);
      this.camera.position.copy(eye); this.camera.up.set(0,1,0).applyQuaternion(rig.carQ).lerp(new THREE.Vector3(0,1,0),.35).normalize();
      this.camera.lookAt(eye.clone().addScaledVector(ahead,30));this.camera.near=.025;this.camera.fov=options.fov+14;this.camera.updateProjectionMatrix();
      rig.ready=false;return;
    }
    this.camera.near=.2;
    const up=new THREE.Vector3(0,1,0);
    const forward=new THREE.Vector3(0,0,1).applyQuaternion(this.car.quaternion);forward.y=0;forward.normalize();
    // During oversteer, follow the direction of travel more than the chassis, so the slide shows.
    const travel=new THREE.Vector3(velocity.x,0,velocity.z),driftBlend=THREE.MathUtils.clamp(sim.autoDrift*1.65,0,.88);
    const rawHeading=travel.lengthSq()>.5?forward.clone().lerp(travel.normalize(),driftBlend).normalize():forward.clone();
    // Smooth the heading so slides, wobbles and slow-speed velocity noise do not twitch the view.
    if(snap||!rig.ready)rig.heading.copy(rawHeading);else rig.heading.lerp(rawHeading,1-Math.exp(-dt*7)).normalize();
    const heading=rig.heading.clone();
    if(this.lookBack)heading.negate();
    const right=new THREE.Vector3(heading.z,0,-heading.x);
    if(this.cameraMode==='bumper'){
      const d=sim.carSpec.dimensions,eye=new THREE.Vector3(0,-(.58+d.wheelRadiusM)+.62,d.lengthM*.5+.15).applyQuaternion(this.car.quaternion).add(this.car.position);
      const yaw=this.lookYaw+(this.lookBack?Math.PI:0),look=new THREE.Vector3(Math.sin(yaw),Math.sin(this.lookPitch)-.02,Math.cos(yaw)).applyQuaternion(rig.carQ);
      // Half-level the horizon: the camera rolls with the car, but only part way.
      const carUp=new THREE.Vector3(0,1,0).applyQuaternion(rig.carQ);
      this.camera.position.copy(eye);this.camera.up.copy(carUp.lerp(up,.55).normalize());this.camera.lookAt(eye.clone().addScaledVector(look,40));
      this.applyShake(.35);this.setFov(options.fov+10+(still?0:Math.min(speedMps*.1,10)),dt,snap);this.camera.near=.05;this.camera.updateProjectionMatrix();
      rig.ready=false;return;
    }
    if(this.cameraMode==='tv'){this.tvCamera(sim,dt,snap,heading,right,speedMps);rig.ready=false;return;}
    // Chase, far chase and drone: a camera offset held on a spring in the car's frame.
    const preset=this.cameraMode==='far'?{distance:15,height:6.4,look:9,stiffness:3.6,aim:7}:this.cameraMode==='drone'?{distance:15,height:21,look:10,stiffness:1.9,aim:3.2}:{distance:9.2,height:3.2,look:6.5,stiffness:5.2,aim:9};
    const zoom=options.distance,pull=still?0:Math.min(speedMps*.032,2.4);
    const distance=(preset.distance+pull)*zoom,height=Math.max(1.2,(preset.height-Math.min(speedMps*.01,.6))*zoom);
    const yaw=this.lookYaw,pitch=this.lookPitch;
    // Accelerating lets the car pull away a little; braking lets the camera close in. Bounded, so it never loses the car.
    const surge=still?0:THREE.MathUtils.clamp(-rig.accel.dot(heading)*.09,-1.6,1.4);
    const desired=new THREE.Vector3().addScaledVector(heading,-Math.cos(yaw)*(distance+surge)).addScaledVector(right,-Math.sin(yaw)*distance).addScaledVector(up,height-Math.sin(pitch)*distance*.6);
    const aim=new THREE.Vector3().addScaledVector(heading,preset.look+Math.min(speedMps*.08,5)).addScaledVector(up,1.15);
    if(snap||!rig.ready||dt>.1){rig.offset.copy(desired);rig.aim.copy(aim);rig.offsetVelocity.set(0,0,0);rig.aimVelocity.set(0,0,0);rig.ready=true;}
    else{
      // Critically damped springs: the offset swings wide through corners and settles without overshoot.
      const spring=(value:THREE.Vector3,velocityState:THREE.Vector3,target:THREE.Vector3,omega:number)=>{
        const steps=Math.ceil(dt/(1/120)),h=dt/steps;
        for(let i=0;i<steps;i++){velocityState.addScaledVector(target.clone().sub(value),omega*omega*h).multiplyScalar(Math.max(0,1-2*omega*h));value.addScaledVector(velocityState,h);}
      };
      spring(rig.offset,rig.offsetVelocity,desired,preset.stiffness+Math.min(speedMps*.04,2.5));
      spring(rig.aim,rig.aimVelocity,aim,preset.aim);
    }
    this.camera.position.copy(rig.anchor).add(rig.offset);
    // Keep the camera above the ground it is looking across.
    this.camera.position.y=Math.max(this.camera.position.y,this.car.position.y+.9);
    this.cameraTarget.copy(rig.anchor).add(rig.aim);
    this.camera.up.copy(up);this.camera.lookAt(this.cameraTarget);
    // Lean slightly into the turn, from the car's sideways acceleration.
    const lean=still||this.cameraMode==='drone'?0:THREE.MathUtils.clamp(rig.accel.dot(right)*-.003,-.035,.035);
    rig.roll+=(lean-rig.roll)*(1-Math.exp(-dt*2));this.camera.rotateZ(rig.roll);
    this.applyShake(this.cameraMode==='drone'?.15:1);
    const boost=sim.boosting?3:0,launch=still?0:THREE.MathUtils.clamp(rig.accel.dot(heading)*.25,-1.5,3);
    this.setFov(this.cameraMode==='drone'?options.fov-6:options.fov+(still?0:Math.min(speedMps*.13,13))+boost+launch,dt,snap);
  }
  private setFov(target:number,dt:number,snap:boolean) {
    this.rig.fov=snap?target:this.rig.fov+(target-this.rig.fov)*Math.min(1,dt*3.5);
    this.camera.fov=this.rig.fov;this.camera.updateProjectionMatrix();
  }
  /** Small, layered sine shake: road texture at speed plus decaying impact energy. */
  private applyShake(scale:number) {
    if(!this.cameraOptions.shake||this.reducedMotion)return;
    const t=this.rig.time,e=this.rig.shake*scale;if(e<.002)return;
    const n=(a:number,b:number,c:number)=>Math.sin(t*a)*.5+Math.sin(t*b+1.7)*.3+Math.sin(t*c+4.1)*.2;
    this.camera.rotateX(n(31,47,73)*.012*e);this.camera.rotateY(n(29,53,67)*.012*e);this.camera.rotateZ(n(23,41,59)*.008*e);
  }
  /**
   * Trackside TV camera: a long lens planted ahead of the car, beside its line.
   * It holds still and pans as the car passes, then cuts to the next spot ahead.
   */
  private tvCamera(sim:Simulation,dt:number,snap:boolean,heading:THREE.Vector3,right:THREE.Vector3,speedMps:number) {
    const car=this.car.position,mpu=sim.track.metersPerUnit;
    const behind=this.tv?this.tv.position.clone().sub(car).dot(heading)<0:false,distance=this.tv?this.tv.position.distanceTo(car):Infinity;
    if(snap||!this.tv||distance>110/mpu||(behind&&distance>38/mpu)){
      const ahead=(42+Math.min(speedMps*1.6,95))/mpu,side=this.tv?-this.tv.side:1;
      let placed:THREE.Vector3|undefined;
      for(const s of [side,-side]){
        const spot=car.clone().addScaledVector(heading,ahead).addScaledVector(right,s*(11+Math.random()*6)/mpu);
        // Ground near the car's own level; fall back to the car's height on open run-off.
        const ground=sim.visibleGroundAt({x:spot.x,y:car.y+1.15,z:spot.z});
        spot.y=(ground??car.y-.7)+(3.5+Math.random()*3)/mpu;
        if(sim.lineOfSight(spot,{x:car.x,y:car.y+1,z:car.z})){placed=spot;this.tv={position:spot,side:s};break;}
      }
      if(!placed){const spot=car.clone().addScaledVector(heading,ahead*.6).addScaledVector(new THREE.Vector3(0,1,0),12/mpu);this.tv={position:spot,side};}
      this.cameraTarget.copy(car);
    }
    this.camera.position.copy(this.tv!.position);this.camera.up.set(0,1,0);
    this.cameraTarget.lerp(car.clone().add(new THREE.Vector3(0,.8,0)),snap?1:1-Math.exp(-dt*9));this.camera.lookAt(this.cameraTarget);
    // Zoom so the car fills a steady part of the frame, like a broadcast camera operator.
    const span=this.camera.position.distanceTo(car)*mpu,fov=THREE.MathUtils.clamp(2*Math.atan(5.2/Math.max(span,1))*180/Math.PI,4,50);
    this.applyShake(.2);this.setFov(fov,dt,snap);
  }
  private followLast=new THREE.Vector3();
  /** Spectator chase camera behind another driver's car (party races), same framing as the player's own chase view. */
  follow(target:THREE.Object3D,dt:number,snap=false) {
    this.wideView=false;this.camera.up.set(0,1,0);this.camera.near=.2;this.camera.filmOffset=0;
    const forward=new THREE.Vector3(0,0,1).applyQuaternion(target.quaternion);forward.y=0;forward.normalize();
    const speed=snap||dt<=0?0:target.position.distanceTo(this.followLast)/dt;this.followLast.copy(target.position);
    const right=new THREE.Vector3(forward.z,0,-forward.x),up=new THREE.Vector3(0,1,0),distance=10.5+Math.min(speed*.018,1.5);
    const eye=target.position.clone().addScaledVector(forward,-Math.cos(this.lookYaw)*distance).addScaledVector(right,-Math.sin(this.lookYaw)*distance).addScaledVector(up,5.1-Math.sin(this.lookPitch)*distance*.55);
    const look=target.position.clone().addScaledVector(forward,7).addScaledVector(up,1.3);
    if(snap){this.camera.position.copy(eye);this.cameraTarget.copy(look);}
    else{this.camera.position.lerp(eye,1-Math.exp(-dt*7));this.cameraTarget.lerp(look,1-Math.exp(-dt*10));}
    this.camera.lookAt(this.cameraTarget);
    this.camera.fov+=((this.reducedMotion?60:58+Math.min(speed/8,10))-this.camera.fov)*Math.min(1,dt*4);this.camera.updateProjectionMatrix();
  }
  ghostFrame(frame?:Frame) { this.ghost.visible=!!frame;if(frame){this.ghost.position.copy(frame.p);this.ghost.quaternion.copy(frame.q);} }
  beginFinish(sim:Simulation) {
    this.finishCameraOffset.copy(this.camera.position).sub(this.car.position);
    this.camera.getWorldDirection(this.finishLookOffset).multiplyScalar(8).add(this.finishCameraOffset);
    const inverse=this.car.quaternion.clone().invert();this.finishCameraOffset.applyQuaternion(inverse);this.finishLookOffset.applyQuaternion(inverse);
    this.finishFov=this.camera.fov;
    this.firstPerson=false;this.resetMouseLook();this.finishElapsed=0;this.ghost.visible=false;
    const forward=new THREE.Vector3(0,0,1).applyQuaternion(this.car.quaternion);forward.y=0;forward.normalize();
    this.finishConfetti.burst(this.car.position.clone().addScaledVector(forward,4).add(new THREE.Vector3(0,1.5,0)),this.car.quaternion,this.reducedMotion);
  }
  celebrateFinish(dt:number) {
    this.finishElapsed+=dt;
    this.finishConfetti.update(dt);
    const forward=new THREE.Vector3(0,0,1).applyQuaternion(this.car.quaternion);forward.y=0;forward.normalize();
    const right=new THREE.Vector3(forward.z,0,-forward.x),up=new THREE.Vector3(0,1,0);
    const progress=THREE.MathUtils.clamp(this.finishElapsed/2.6,0,1),eased=this.reducedMotion?0:progress*progress*(3-2*progress);
    const target=forward.clone().multiplyScalar(-21).addScaledVector(right,3.2).addScaledVector(up,9);
    const look=forward.clone().multiplyScalar(8).addScaledVector(up,1.2);
    this.camera.position.copy(this.finishCameraOffset).applyQuaternion(this.car.quaternion).lerp(target,eased).add(this.car.position);
    this.cameraTarget.copy(this.finishLookOffset).applyQuaternion(this.car.quaternion).lerp(look,eased).add(this.car.position);
    this.camera.up.set(0,1,0);this.camera.lookAt(this.cameraTarget);this.camera.near=.025;this.camera.fov=THREE.MathUtils.lerp(this.finishFov,52,eased);this.camera.updateProjectionMatrix();
  }
  endFinish() { this.finishConfetti.clear(); }
  /** Confetti over the line without the finish camera, for runs that roll straight back into free roam. */
  confettiBurst() {
    const forward=new THREE.Vector3(0,0,1).applyQuaternion(this.car.quaternion);forward.y=0;forward.normalize();
    this.finishConfetti.burst(this.car.position.clone().addScaledVector(forward,6).add(new THREE.Vector3(0,2,0)),this.car.quaternion,this.reducedMotion);
  }
  updateConfetti(dt:number) { this.finishConfetti.update(dt); }
  setCinematicBloom(strength:number) {
    const bloom=this.composer?.passes.find(pass=>pass instanceof UnrealBloomPass);
    if(bloom instanceof UnrealBloomPass)bloom.strength=THREE.MathUtils.clamp(strength,0,1);
  }
  render(sunDirection?: THREE.Vector3, fogFar?:number) {
    const track=this.currentTrack;
    if(track&&(this.markedGates?.track!==track||this.markedGates.checkpoints!==track.checkpoints||this.markedGates.finish!==track.finish))this.markGates(track);
    // Aerial cameras sit kilometres away; driving fog must not erase the course preview.
    const weather=this.fogRange(this.weather.preset),fog=this.scene.fog as THREE.Fog;
    const wideView=this.wideView&&!sunDirection;
    const distance=wideView?this.camera.position.distanceTo(this.center):0;
    fog.near=wideView?Math.max(weather.near,distance-this.trackRadius*.7):weather.near;
    fog.far=wideView?Math.max(weather.far,distance+this.trackRadius*3):weather.far;
    if(fogFar!==undefined){fog.far=fogFar;fog.near=fogFar*.2;}
    this.cullVenue(wideView||this.editorActive?Infinity:fog.far);
    this.shadow.target.position.copy(this.car.position);
    this.shadow.position.set(this.car.position.x-16,this.car.position.y+30,this.car.position.z+8);
    if(sunDirection)this.shadow.position.copy(this.car.position).addScaledVector(sunDirection,35);
    if(this.composer)this.composer.render();else this.renderer.render(this.scene,this.camera);
  }
}
