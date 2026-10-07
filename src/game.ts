import { DT, initPhysics, Input, MAX_TICKS, PHYSICS_VERSION, rotate, Simulation, type Frame, type RunOrigin } from '../shared/physics';
import { CONE_TRACK, TRACKS, TRAINING_GROUNDS, medalFor, type Track, type Vec3 } from '../shared/tracks';
import { carById, DEFAULT_CAR, type CarDefinition, type CarId } from '../shared/cars';
import { stepReplay, type Run } from '../shared/replay';
import { CAMERA_LABELS, CAMERA_MODES, RaceWorld, type CameraMode, type CockpitOffset } from './world';
import { bestRun, read, saveBestRun, write } from './storage';
import { loadCockpitOffsets, hasLocalStartPlacement } from './dev-spawns';
import { RaceAudio } from './race-audio';
import { loadSettings, type Settings } from './settings';
import { GRAPHICS_PRESETS, PRESET_LABELS, isPreset, sanitizeGraphics, type GraphicsOptions, type GraphicsPreset, type GraphicsQuality } from './graphics';
import { CAR_ACCENT, awardFinish, buyCar, loadCareer, saveCareer, unlocked, type Career } from './progression';
import { keyLabel, type Action } from './controls';
import { Quaternion, Vector3 } from 'three';
import { FinishDriver } from './finish-driver';
import { CarRig } from './car-rig';
import type { PartyLobby, PartyPose, PartyRace, PartyWeather } from '../shared/party';
import { Group, CanvasTexture, Sprite, SpriteMaterial } from 'three';

export type Mode='menu'|'countdown'|'racing'|'paused'|'celebrating'|'finished'|'replay'|'party-loading'|'party-finished';
const LIVE_KEYS=new Set<keyof GameState>(['time','speed','boost','drifting','driftCombo']);
export type GameState={mode:Mode;track:Track;trackReady:boolean;trackLoading?:boolean;car:CarDefinition;modelReady:boolean;time:number;speed:number;checkpoint:number;countdown:number;boost:boolean;drifting:boolean;ghost:boolean;muted:boolean;steeringStrength:number;driftStrength:number;run?:Run;personalBest?:number;newBest:boolean;notice:string;fps:number;worstFrame:number;
  /** Training Grounds: cones touched this cone run, the live drift combo and the session's best combo. */
  penalties:number;driftCombo:number;driftBest:number;
  /** Free roam: the car is inside the Cone Attack start box, so Enter can start the run. */
  atStart:boolean;
  /** Low frame rate notice: the preset in use, the lighter one suggested, and the measured average. */
  perfTip?:{from:GraphicsQuality;to:GraphicsPreset;fps:number;target:number};
  /** The last finished Cone Attack run, shown while the driver keeps rolling in free roam. `at` makes repeat results distinct. */
  coneResult?:{run:Run;timeMs:number;medal:string;newBest:boolean;previousBest?:number;penalties:number;offCourse:number;at:number}};
export class Game {
  world:RaceWorld;sim:Simulation;state:GameState;private coarse!:GameState;
  settings=loadSettings();career:Career=loadCareer();reward?:ReturnType<typeof awardFinish>;
  modelError='';
  awaitingPedal=false;authoring=false;
  /** The camera stays locked this long after the green light. */
  static readonly LOOK_LOCK_AFTER_GO_MS=3000;private lookUnlockAt=0;
  private sound=new RaceAudio();private goAt=-Infinity;private finishRevealAt=0;
  private finishDriver?:FinishDriver;
  /** Drives the car on along the course after a party finish, so it rolls through the line instead of freezing. */
  private partyFinishDriver?:FinishDriver;
  /** Party racer the camera follows after you finish; undefined follows your own car. */
  spectating?:string;private spectateSnap=false;
  /** Current step while joining a party race, shown on the loading screen. */
  partyLoadStep='';
  /** Shift presses not yet sent to the gearbox: positive = upshifts, negative = downshifts. Taps during a shift wait instead of being lost. */
  private pendingShifts=0;private seenBlockedShifts=0;private runManual=false;
  /** performance.now() of the last refused downshift, for the tachometer warning. */
  shiftBlockedAt=-Infinity;
  listeners=new Set<()=>void>();inputs:number[]=[];ghostSim?:Simulation;ghostRun?:Run;
  private steeringInputs:number[]=[];private driftInputs:number[]=[];
  private keys=new Set<string>();private lastRender=performance.now();private worstFrame=0;private previous=performance.now();private accumulator=0;private countdownUntil=0;private lastUI=0;private frameCount=0;private fpsTime=performance.now();private replayInput?:Run;
  private noticeUntil=0;private lastCheckpoint=0;private lastRespawns=0;private previousFrame?:Frame;private previousGhostFrame?:Frame;
  private queuedRespawn=false;private queuedFlip=false;private pausedMode:Mode='racing';private pausedCountdown=0;
  private garageView=false;
  /** Frame-rate watch while driving: recent per-second samples, when driving began, and presets the player declined this session. */
  private fpsSamples:number[]=[];private drivingSince=0;private perfDeclined=new Map<GraphicsQuality,number>();private perfShownAt=0;
  /** Circuit to show again when leaving the Training Grounds. */
  private lastCircuit:Track=TRACKS[0];
  /** Where the current Cone Attack run began; reused by restart, replay and ghosts. */
  private runOrigin?:RunOrigin;
  private lastPenalties=0;private driftCalm=0;private lastHits=0;
  get freeRoam(){return this.state.track.kind==='lot';}
  partyView=false;
  /** Called when the player leaves the Training Grounds, so the interface can switch to the Garage it was opened from. */
  onLeaveTraining?:()=>void;
  /** Your finishing position in the current party race, once the server confirms it. */
  partyPlace?:number;
  partyRace?: { id: string; lap: number; laps: number; ready: boolean; started: boolean; finished: boolean };
  private partySequence=0;
  private partySelf='';
  /** performance.now() when you crossed the line in a party race, for the finish callout. */
  partyFinishedAt=0;
  private partyWeather?:PartyWeather;
  private partyOriginalTrack?:Track;
  /** Other party drivers. finishedAt starts their fade-out; fadeMaterials are private copies so fading one car leaves the others opaque. */
  private remoteCars=new Map<string,RemoteCar>();
  private editorView=false;
  private cockpitPreview=false;
  private routeRecording=false;
  private routePoints:{x:number;y:number;z:number}[]=[];
  private selectionToken=0; private carToken=0;
  // Keep the current preferred race feel as the baseline; the in-race tuner
  // remains available for temporary adjustment.
  private steeringStrength=Math.max(.7,Math.min(2,Number(read('steeringStrength',1.5))||1.5));
  private driftStrength=Math.max(0,Math.min(2,Number(read('driftStrength',1))));
  constructor(canvas:HTMLCanvasElement) {
    const preferred=carById(read<CarId>('car',DEFAULT_CAR.id));
    const selectedCar=unlocked(this.career,preferred.id)?preferred:DEFAULT_CAR;
    this.world=new RaceWorld(canvas);this.sim=new Simulation(location.pathname.startsWith('/dev')?TRACKS[0]:TRAINING_GROUNDS,selectedCar.id);
    if(location.pathname.startsWith('/dev'))this.world.setTrack(TRACKS[0]);
    this.world.setCockpitOffset(loadCockpitOffsets()[selectedCar.id]);
    this.applySettings();
    this.sim.steeringStrength=this.steeringStrength;
    this.state={mode:'menu',track:TRACKS[0],trackReady:location.pathname.startsWith('/dev'),car:selectedCar,modelReady:false,time:0,speed:0,checkpoint:0,countdown:3,boost:false,drifting:false,ghost:read('ghost',true),muted:read('muted',false),steeringStrength:this.steeringStrength,driftStrength:this.driftStrength,personalBest:bestRun(TRACKS[0])?.timeMs,newBest:false,notice:'',worstFrame:0,fps:60,penalties:0,driftCombo:0,driftBest:0,atStart:false};
    this.coarse=this.state;
    void this.world.setCar(selectedCar.id).then(modelReady=>{if(this.carToken!==0)return;this.modelError=modelReady?'':'Car could not load. Check your connection and retry.';this.emit({modelReady});});
    addEventListener('keydown',this.keyDown);addEventListener('keyup',event=>this.keys.delete(event.code));
    addEventListener('blur',()=>this.pause());document.addEventListener('visibilitychange',()=>{if(document.hidden)this.pause();});
    document.addEventListener('pointerlockchange',()=>{if(!document.pointerLockElement)this.pause();});
    // Browsers keep audio locked until the first gesture; unlock it and give every button a click/hover sound.
    addEventListener('pointerdown',this.interfacePointer,true);addEventListener('pointerover',this.interfaceHover,true);
    addEventListener('keydown',()=>this.prepareAudio(),{once:true,capture:true});
    requestAnimationFrame(this.frame);
    const idle=window.requestIdleCallback??((callback:()=>void)=>setTimeout(callback,1500));
    idle(()=>this.sound.prepare());
  }
  private interfaceButton(event:Event) {
    const target=event.target;return target instanceof Element?target.closest('button,[role="tab"],summary,a[href]'):null;
  }
  private interfacePointer=(event:PointerEvent)=>{
    this.prepareAudio();
    const button=this.interfaceButton(event);if(button&&!(button as HTMLButtonElement).disabled&&this.state.mode!=='racing')this.sound.ui('click');
  };
  private hovered:Element|null=null;private hoverTimer?:number;
  /** Hover sound only once the pointer settles on a button, so sweeping across a row of buttons stays quiet. */
  private interfaceHover=(event:PointerEvent)=>{
    const button=this.interfaceButton(event);if(button===this.hovered)return;this.hovered=button;
    clearTimeout(this.hoverTimer);
    if(button&&!(button as HTMLButtonElement).disabled&&event.pointerType==='mouse'&&this.state.mode!=='racing')
      this.hoverTimer=window.setTimeout(()=>{if(this.hovered===button)this.sound.ui('hover');},140);
  };
  subscribe=(callback:()=>void)=>{this.listeners.add(callback);return()=>this.listeners.delete(callback);};
  snapshot=()=>this.state;
  /** Same as snapshot, except it ignores the per-tick race readouts (time, speed, boost, drift) while driving, so large UI trees do not re-render at 15 Hz. */
  coarseSnapshot=()=>this.coarse;
  emit(patch:Partial<GameState>={}) {
    const previous=this.state;this.state={...previous,...patch};
    const keys=Object.keys(patch) as (keyof GameState)[];
    if(!keys.length||!['racing','replay','countdown'].includes(previous.mode)||keys.some(key=>!LIVE_KEYS.has(key)&&patch[key]!==previous[key]))this.coarse=this.state;
    this.listeners.forEach(l=>l());
  }
  private keyDown=(event:KeyboardEvent)=>{
    if((event.target as HTMLElement).closest('input,textarea,select,dialog'))return;
    // While the frame-rate notice is up, Y switches and N dismisses (unless the player has bound those keys).
    if(this.state.perfTip&&!event.repeat&&(event.code==='KeyY'||event.code==='KeyN')&&!Object.values(this.settings.bindings).some(codes=>codes.includes(event.code))){
      event.preventDefault();if(event.code==='KeyY')this.acceptPerfTip();else this.declinePerfTip();return;
    }
    // A key may be bound to several actions; every one of them fires.
    const actions=(Object.keys(this.settings.bindings) as Action[]).filter(a=>this.settings.bindings[a].includes(event.code)),has=(a:Action)=>actions.includes(a);
    if(!actions.length&&event.code!=='Escape'&&event.code!=='Enter')return;
    // Enter on a focused button normally presses that button. Menu tabs and track cards are the exception:
    // after clicking one, focus stays on it, and pressing it again does nothing, so Enter starts the race instead.
    if(event.code==='Enter'&&(event.target as HTMLElement).closest('button')&&!(event.target as HTMLElement).closest('.topbar nav button,.track-card'))return;
    event.preventDefault();this.keys.add(event.code);if(event.repeat)return;
    if(has('mute'))this.toggleMute();
    if(has('camera'))this.toggleCamera();
    if(has('ghost'))this.toggleGhost();
    if(has('recover'))this.recover();
    if(has('flip'))this.flip();
    if(has('restart')&&this.state.mode!=='menu')this.restart();
    if(has('shiftUp')&&this.state.mode==='racing')this.pendingShifts=Math.min(8,Math.max(0,this.pendingShifts)+1);
    if(has('shiftDown')&&this.state.mode==='racing')this.pendingShifts=Math.max(-8,Math.min(0,this.pendingShifts)-1);
    if(event.code==='Escape'||has('pause'))this.state.mode==='paused'?this.resume():this.pause();
    if(event.code==='Enter'){if(this.state.mode==='menu'||this.state.mode==='finished')this.start();else if(this.state.mode==='paused')this.resume();else this.requestConeRun();}
  };
  private input() {
    const respawn=this.queuedRespawn,flip=this.queuedFlip;this.queuedRespawn=false;this.queuedFlip=false;
    // A refused downshift cancels the rest of the queue so the driver can react.
    if(this.sim.blockedShifts!==this.seenBlockedShifts){if(this.sim.blockedShifts>this.seenBlockedShifts){this.pendingShifts=0;this.shiftBlockedAt=performance.now();}this.seenBlockedShifts=this.sim.blockedShifts;}
    // Send one queued shift per gearbox-ready tick, with a released tick between presses.
    let shift=0;
    if(this.pendingShifts&&this.sim.shiftReady&&!(this.sim.previousInput&(Input.ShiftUp|Input.ShiftDown))){shift=this.pendingShifts>0?Input.ShiftUp:Input.ShiftDown;this.pendingShifts-=Math.sign(this.pendingShifts);}
    return (this.held('throttle')&&(performance.now()>=this.bogUntil||this.sim.ticks%3===0)?Input.Throttle:0)|(this.held('brake')?Input.Brake:0)|(this.held('left')?Input.Left:0)|(this.held('right')?Input.Right:0)|(this.held('drift')?Input.Drift:0)|(respawn?Input.Respawn:0)|(flip?Input.Flip:0)|shift;
  }
  /** When the throttle was last pressed (continuously held since), and until when a false start keeps the engine bogged down. */
  private throttleDownAt=-1;private bogUntil=0;
  private held(action:Action){return this.settings.bindings[action].some(code=>this.keys.has(code));}
  keyHint(action:Action){return this.settings.bindings[action].map(keyLabel).join(' / ');}
  async select(track:Track,prepare=location.pathname.startsWith('/dev')) {
    const token=++this.selectionToken;if(!track.lot)this.lastCircuit=track;this.keys.clear();this.garageView=false;this.world.setMouseLook(false);this.ghostSim?.dispose();this.ghostSim=undefined;
    this.emit({mode:'menu',track,trackReady:false,trackLoading:prepare,time:0,speed:0,checkpoint:0,personalBest:bestRun(track)?.timeMs,run:undefined,newBest:false,notice:''});
    if(!prepare)return;
    this.world.setTrack(track);
    try {
      await Promise.all([initPhysics(track),this.world.venueReady]);
      if(token!==this.selectionToken)return;
      if(this.world.venueLoadError)throw new Error(this.world.venueLoadError);
      this.sim.dispose();this.sim=new Simulation(track,this.state.car.id);this.sim.steeringStrength=this.steeringStrength;this.sim.driftStrength=this.driftStrength;
      this.emit({trackReady:true,trackLoading:false,notice:''});
    }catch(error){console.error(error);if(token===this.selectionToken)this.emit({trackLoading:false,notice:'This circuit could not be prepared. Try racing again.'});}
  }
  /** Spends REP on a car. Returns false when it is owned, too expensive or the save failed. */
  buyCar(carId:CarId) {
    const next=buyCar(this.career,carId);if(!next)return false;
    if(!saveCareer(next)){this.emit({notice:'Purchase could not be saved: device storage is full.'});return false;}
    this.career=next;this.sound.unlock(carId);if(!this.settings.reducedMotion)this.world.unveilGarage(CAR_ACCENT[carId]);this.emit({});return true;
  }
  async selectCar(carId:CarId) {
    const token=++this.carToken,car=carById(carId);write('car',car.id);this.keys.clear();
    this.modelError='';
    this.world.setCockpitOffset(loadCockpitOffsets()[car.id]);
    if(this.state.trackReady){this.sim.dispose();this.sim=new Simulation(this.state.track,car.id);this.sim.steeringStrength=this.steeringStrength;this.sim.driftStrength=this.driftStrength;}this.ghostSim?.dispose();this.ghostSim=undefined;
    this.emit({car,modelReady:false,time:0,speed:0,checkpoint:0,run:undefined,newBest:false,notice:''});
    await this.world.setCar(car.id).then(modelReady=>{if(token!==this.carToken)return;this.modelError=modelReady?'':'Car could not load. Check your connection and retry.';this.emit({modelReady});});
  }
  setGarage(active:boolean) {this.garageView=active;this.world.setMouseLook(false);if(active){void this.world.loadGarage();this.world.garage(0,true);}else this.world.overview(0,true);}
  /** Steps to the next race camera and remembers it. */
  toggleCamera() {
    const next=CAMERA_MODES[(CAMERA_MODES.indexOf(this.world.cameraMode)+1)%CAMERA_MODES.length];
    this.setCamera(next);
  }
  setCamera(mode:CameraMode) {
    this.world.cameraMode=mode;this.world.resetMouseLook();this.setSettings({cameraMode:mode});
    if(['racing','countdown','replay'].includes(this.state.mode)){this.emit({notice:`Camera · ${CAMERA_LABELS[mode]}`});this.noticeUntil=performance.now()+1100;}
  }
  setEditor(active:boolean) { this.editorView=active; this.cockpitPreview=false; this.keys.clear(); this.world.setMouseLook(false); if(active)this.world.editor(0,true); else this.world.endStartEditor(); }
  setCockpitOffset(offset?: CockpitOffset) { this.world.setCockpitOffset(offset); }
  setCockpitPreview(active:boolean) {
    this.cockpitPreview=active;this.editorView=false;this.garageView=false;this.keys.clear();this.world.endStartEditor();
    this.world.firstPerson=active;this.world.resetMouseLook();this.world.setMouseLook(active);
    if(active)this.world.chase(this.sim,0,true);else this.world.overview(0,true);
  }
  beginRouteRecording() { this.routePoints=[]; this.routeRecording=true; this.start(false); this.emit({notice:'Recording route — drive the centre of the asphalt, then stop recording.'}); }
  finishRouteRecording() { this.routeRecording=false; this.menu(); return smoothRoute(this.routePoints); }
  start(countdown=true,replay=false) {
    if(this.partyView||this.partyRace)return;
        if(!replay&&!this.state.track.lot&&!location.pathname.startsWith('/dev')&&!unlocked(this.career,this.state.car.id)){this.emit({notice:'This car is locked. Buy it in the garage with REP.'});return;}
    if(!this.state.modelReady){this.emit({notice:'The car is still loading.'});return;}
    if(!this.state.trackReady){
      if(this.state.trackLoading)return;
      const loading=this.select(this.state.track,true),token=this.selectionToken;
      void loading.then(()=>{if(token===this.selectionToken&&this.state.trackReady)this.start(countdown,replay);});
      return;
    }
    this.world.applyPendingGraphics();
    this.awaitingPedal=!countdown;this.bogUntil=0;this.reward=undefined;this.goAt=-Infinity;this.finishRevealAt=0;this.world.endFinish();this.world.skidMarks.clear();this.world.carDamage.reset();this.pendingShifts=0;this.seenBlockedShifts=0;this.runManual=this.settings.advancedDriving;
    this.keys.clear();this.garageView=false;this.cockpitPreview=false;this.inputs=[];this.steeringInputs=[];this.driftInputs=[];this.accumulator=0;this.lastCheckpoint=0;this.lastRespawns=0;this.previousFrame=undefined;this.queuedRespawn=false;this.queuedFlip=false;this.replayInput=undefined;
    if(this.state.track.kind!=='cones')this.runOrigin=undefined;
    this.sim.dispose();this.sim=new Simulation(this.state.track,this.state.car.id,this.runOrigin);this.sim.steeringStrength=this.steeringStrength;this.sim.driftStrength=this.driftStrength;
    this.ghostSim?.dispose();this.ghostSim=undefined;
    this.ghostRun=bestRun(this.state.track);this.previousGhostFrame=undefined;if(this.state.ghost&&this.ghostRun){this.ghostSim=new Simulation(this.state.track,this.ghostRun.carId,this.ghostRun.origin);void this.world.setGhostCar(this.ghostRun.carId);}
    this.world.resetMouseLook();this.world.setMouseLook(true);
    // Locked for the countdown and a few seconds after the green light, so the opening framing is steady.
    this.world.lookLocked=countdown&&!this.state.track.lot;this.lookUnlockAt=Infinity;
    this.world.lockMouse();
    this.world.chase(this.sim,0,true);this.world.ghostFrame(undefined);
    this.sim.manual=this.runManual;
    this.finishDriver=new FinishDriver(this.state.track);
    this.countdownUntil=performance.now()+(countdown?6500:0);this.prepareAudio();
    this.lastPenalties=0;this.driftCalm=0;this.lastHits=this.sim.hitCount;
    if(this.freeRoam){
      // Free roam has no clock to start and no five-minute limit.
      this.sim.maxTicks=Infinity;this.awaitingPedal=false;
      this.emit({mode:'racing',countdown:6,time:0,speed:0,checkpoint:0,newBest:false,run:undefined,penalties:0,driftCombo:0,notice:'Free roam · no clock, no limits'});this.noticeUntil=performance.now()+2600;
      return;
    }
    this.emit({mode:countdown?'countdown':'racing',countdown:6,time:0,speed:0,checkpoint:0,newBest:false,run:undefined,penalties:0,driftCombo:0,notice:countdown?'':`Press ${this.keyHint('throttle')} or ${this.keyHint('brake')} to start the clock`});
  }
  restart() {this.start(this.state.track.kind==='cones');}
  /** Opens the Training Grounds in free roam with the current car, locked or not. */
  async enterTraining() {
    if(this.partyView||this.partyRace)return;
    const token=++this.selectionToken;this.keys.clear();this.garageView=false;this.runOrigin=undefined;
    this.ghostSim?.dispose();this.ghostSim=undefined;this.ghostRun=undefined;this.world.ghostFrame(undefined);
    this.world.setTrack(TRAINING_GROUNDS);
    this.emit({track:TRAINING_GROUNDS,trackReady:false,run:undefined,newBest:false,personalBest:undefined,penalties:0,atStart:false,coneResult:undefined,notice:''});
    await initPhysics(TRAINING_GROUNDS);if(token!==this.selectionToken)return;
    this.emit({trackReady:true});this.start(false);
  }
  /**
   * Enter inside the orange box starts the hidden cone course from exactly where the car sits:
   * the pose becomes the run's origin, so the server replays it from the same spot.
   */
  requestConeRun() {
    if(!this.freeRoam||this.state.mode!=='racing'||!this.state.atStart)return;
    if(this.sim.speed>2){this.emit({notice:'Stop the car in the box first'});this.noticeUntil=performance.now()+1400;return;}
    const p=this.sim.car.translation(),forward=rotate(this.sim.car.rotation(),{x:0,y:0,z:1}),round=(value:number)=>Math.round(value*1000)/1000;
    void this.startConeRun({x:round(p.x),z:round(p.z),heading:round(Math.atan2(forward.x,forward.z))});
  }
  private async startConeRun(origin:RunOrigin) {
    const token=++this.selectionToken;write('conesFound',true);this.runOrigin=origin;
    this.world.setTrack(CONE_TRACK);
    this.emit({track:CONE_TRACK,trackReady:false,personalBest:bestRun(CONE_TRACK)?.timeMs,run:undefined,newBest:false,penalties:0,atStart:false,coneResult:undefined,notice:''});
    await initPhysics(CONE_TRACK);if(token!==this.selectionToken)return;
    this.emit({trackReady:true});this.start(true);
  }
  menu() {if(this.partyRace)return;
    // Leaving the Training Grounds goes back to the Garage, where it is opened from.
    if(this.state.track.lot){this.cockpitPreview=false;this.world.firstPerson=false;this.world.endFinish();this.world.setMouseLook(false);this.onLeaveTraining?.();void this.select(this.lastCircuit).then(()=>this.setGarage(true));return;}this.keys.clear();this.finishRevealAt=0;this.world.endFinish();this.cockpitPreview=false;this.world.firstPerson=false;this.world.setMouseLook(false);this.emit({mode:'menu',notice:''});this.world.ghostFrame(undefined);}
  pause() {this.keys.clear();this.world.applyPendingGraphics();if(this.partyRace)return;if(['racing','countdown','replay'].includes(this.state.mode)){this.pausedMode=this.state.mode;this.pausedCountdown=Math.max(0,this.countdownUntil-performance.now());this.emit({mode:'paused'});this.world.setMouseLook(false);}}
  resume() {this.keys.clear();this.accumulator=0;if(!this.freeRoam&&this.sim.ticks>=MAX_TICKS){this.restart();return;}if(this.pausedMode==='countdown')this.countdownUntil=performance.now()+this.pausedCountdown;this.emit({mode:this.pausedMode});this.world.setMouseLook(true);this.world.lockMouse();this.prepareAudio();}
  recover() {if(this.state.mode==='racing')this.queuedRespawn=true;}
  flip() {
    if(this.state.mode!=='racing')return;
    if(this.sim.speed*this.state.track.metersPerUnit*2.23694>15.5){this.emit({notice:'Slow below 15 mph to flip'});this.noticeUntil=performance.now()+1300;return;}
    this.queuedFlip=true;this.emit({notice:'Righting the car'});this.noticeUntil=performance.now()+1000;
  }
  toggleGhost() {
    if(this.partyRace)return;
    const ghost=!this.state.ghost;write('ghost',ghost);this.emit({ghost});
    if(!ghost){this.ghostSim?.dispose();this.ghostSim=undefined;this.world.ghostFrame(undefined);}
    else if(this.ghostRun&&this.state.mode!=='menu'&&this.state.mode!=='replay'){
      this.ghostSim=new Simulation(this.state.track,this.ghostRun.carId,this.ghostRun.origin);void this.world.setGhostCar(this.ghostRun.carId);for(let i=0;i<this.sim.ticks;i++)stepReplay(this.ghostSim,this.ghostRun);
    }
  }
  toggleMute() {const muted=!this.state.muted;write('muted',muted);this.emit({muted});if(!muted)this.prepareAudio();}
  setSteeringStrength(value:number) {this.steeringStrength=Math.max(.7,Math.min(2,value));this.sim.steeringStrength=this.steeringStrength;write('steeringStrength',this.steeringStrength);this.emit({steeringStrength:this.steeringStrength});}
  setDriftStrength(value:number) {this.driftStrength=Math.max(0,Math.min(2,value));this.sim.driftStrength=this.driftStrength;write('driftStrength',this.driftStrength);this.emit({driftStrength:this.driftStrength});}
  async watch(run:Run) {if(this.state.car.id!==run.carId)await this.selectCar(run.carId);this.runOrigin=run.origin;this.start(false,true);this.awaitingPedal=false;this.replayInput=run;this.ghostSim?.dispose();this.ghostSim=undefined;this.emit({mode:'replay'});}
  /** Free-roam drift combo: slip angle times speed while sliding; a pause banks it, a wall hit loses it. */
  private trackDrift() {
    const sim=this.sim,v=sim.car.linvel(),right=rotate(sim.car.rotation(),{x:1,y:0,z:0});
    const speed=Math.hypot(v.x,v.z),slip=Math.atan2(Math.abs(v.x*right.x+v.z*right.z),Math.max(1,Math.abs(sim.forwardSpeed)));
    let combo=this.state.driftCombo,best=this.state.driftBest;
    if(sim.hitCount!==this.lastHits){this.lastHits=sim.hitCount;if(combo>0&&sim.lastHitSpeed>4){combo=0;this.emit({notice:'Combo lost'});this.noticeUntil=performance.now()+900;}}
    if(sim.drifting){combo+=slip*57.3*speed*DT*.6;this.driftCalm=0;}
    else if(combo>0&&(this.driftCalm+=DT)>.9){if(combo>best){best=combo;this.emit({notice:`Best drift · ${Math.round(combo).toLocaleString()}`});this.noticeUntil=performance.now()+1500;}combo=0;}
    if(Math.round(combo)!==Math.round(this.state.driftCombo)||best!==this.state.driftBest)this.emit({driftCombo:combo,driftBest:best});
  }
  private finish() {
    const run:Run={trackId:this.state.track.id,trackVersion:this.state.track.version,physicsVersion:PHYSICS_VERSION,carId:this.state.car.id,timeMs:this.sim.timeMs,inputs:[...this.inputs],steering:[...this.steeringInputs],drift:[...this.driftInputs],...(this.runManual?{manual:true}:{}),...(this.runOrigin&&this.state.track.kind==='cones'?{origin:this.runOrigin}:{})};
    const custom=hasLocalStartPlacement(this.state.track);
    const best=bestRun(this.state.track);const newBest=!best||run.timeMs<best.timeMs;
    if(this.state.track.kind==='cones'){this.finishConeRun(run,newBest,best?.timeMs);return;}
    // Custom layouts keep their own personal best and ghost on this device.
    let notice=custom?'Custom layout — personal best and ghost saved here; online ranking unavailable.':'';
    if(newBest&&!saveBestRun(this.state.track,run))notice=custom?'Device storage is full; this ghost was not saved.':'Device storage is full. Submit this run before leaving.';
    else if(newBest)void this.world.setGhostCar(run.carId);
    if(!location.pathname.startsWith('/dev')&&!this.state.track.lot){this.reward=awardFinish(this.career,this.state.track,run.timeMs,this.runManual);this.career=this.reward.career;if(!saveCareer(this.career))notice='Career could not be saved: device storage is full.';}
    this.keys.clear();this.finishRevealAt=performance.now()+(this.world.reducedMotion?1200:3200);this.world.beginFinish(this.sim);
    this.finishDriver??=new FinishDriver(this.state.track);this.finishDriver.begin(this.sim);this.accumulator=0;
    this.emit({mode:'celebrating',time:run.timeMs,checkpoint:this.sim.checkpoint,run,newBest,personalBest:newBest?run.timeMs:best?.timeMs,notice});
    this.sound.cue('finish',this.settings.effectsVolume);this.world.setMouseLook(false);
  }
  /**
   * Cone Attack never stops the car: the run is saved, the course packs away and the
   * same car, at the same speed, carries on in free roam with a results card on screen.
   */
  private finishConeRun(run:Run,newBest:boolean,previousBest?:number) {
    const track=this.state.track,old=this.sim,frame=old.frame(),linear=old.car.linvel(),angular=old.car.angvel();
    if(newBest&&saveBestRun(track,run))void this.world.setGhostCar(run.carId);
    const result={run,timeMs:run.timeMs,medal:medalFor(track,run.timeMs),newBest,previousBest,penalties:old.penalties,offCourse:old.offCourse,at:performance.now()};
    this.world.setTrack(TRAINING_GROUNDS);
    const forward=rotate(frame.q,{x:0,y:0,z:1});
    this.sim=new Simulation(TRAINING_GROUNDS,this.state.car.id,{x:frame.p.x,z:frame.p.z,heading:Math.atan2(forward.x,forward.z)});
    this.sim.car.setTranslation(frame.p,true);this.sim.car.setRotation(frame.q,true);this.sim.car.setLinvel(linear,true);this.sim.car.setAngvel(angular,true);
    Object.assign(this.sim,{steering:old.steering,throttle:old.throttle,brake:old.brake,autoDrift:old.autoDrift,gear:old.gear,manual:old.manual});
    this.sim.maxTicks=Infinity;this.sim.steeringStrength=this.steeringStrength;this.sim.driftStrength=this.driftStrength;
    old.dispose();
    this.runOrigin=undefined;this.previousFrame=undefined;this.inputs=[];this.steeringInputs=[];this.driftInputs=[];this.lastPenalties=0;this.lastHits=this.sim.hitCount;
    this.ghostSim?.dispose();this.ghostSim=undefined;this.ghostRun=undefined;this.world.ghostFrame(undefined);
    this.world.confettiBurst();this.sound.cue('finish',this.settings.effectsVolume);
    this.emit({track:TRAINING_GROUNDS,trackReady:true,mode:'racing',run,newBest,personalBest:undefined,penalties:0,checkpoint:0,driftCombo:0,coneResult:result,notice:''});
  }
  private prepareAudio() {
    if(!this.state.muted)this.sound.start();
  }
  async prepareParty(lobby:PartyLobby,selfId:string) {
    this.selectionToken++;this.carToken++;
    const race=lobby.race!,me=race.racers.find(r=>r.id===selfId)!;
    this.partyOriginalTrack=this.state.track;this.partySelf=selfId;this.partyPlace=undefined;
    const track=structuredClone(TRACKS.find(t=>t.id===lobby.settings.trackId)!);
    track.spawn=structuredClone(race.grid[me.slot]);track.checkpoints=structuredClone(race.checkpoints);track.finish=structuredClone(race.finish);
    this.partyFinishDriver=undefined;this.spectating=undefined;
    this.partyRace={id:race.id,lap:me.pose?.lap??1,laps:lobby.settings.laps,ready:false,started:false,finished:!!(me.finishedAt||me.disconnected||race.ended)};
    this.partySequence=me.pose?.sequence??0;this.partyView=false;this.keys.clear();this.garageView=false;this.reward=undefined;this.awaitingPedal=false;
    this.inputs=[];this.steeringInputs=[];this.driftInputs=[];this.accumulator=0;this.previousFrame=undefined;
    this.lastCheckpoint=0;this.lastRespawns=0;this.queuedRespawn=false;this.queuedFlip=false;this.pendingShifts=0;this.seenBlockedShifts=0;
    this.ghostSim?.dispose();this.ghostSim=undefined;this.ghostRun=undefined;this.world.ghostFrame(undefined);this.world.endFinish();
    this.partyWeather=lobby.settings.weather;this.world.setTrack(track);this.world.setWeather(lobby.settings.weather);
    this.partyLoadStep='Loading circuit';
    this.emit({mode:'party-loading',track,car:carById(me.carId),trackReady:false,modelReady:false,time:0,speed:0,checkpoint:0,run:undefined,newBest:false,notice:''});
    await initPhysics(track);
    if(this.partyRace?.id!==race.id)return;
    this.sim.dispose();this.sim=new Simulation(track,me.carId);this.sim.maxTicks=60*3600;this.sim.steeringStrength=this.steeringStrength;this.sim.driftStrength=this.driftStrength;this.sim.manual=this.settings.advancedDriving;
    if(me.pose){this.sim.car.setTranslation(me.pose.p,true);this.sim.car.setRotation(me.pose.q,true);this.sim.car.setLinvel({x:0,y:0,z:0},true);this.sim.car.setAngvel({x:0,y:0,z:0},true);this.sim.checkpoint=me.pose.checkpoint;this.sim.ticks=Math.max(0,Math.round((Date.now()-(race.startAt??Date.now()))/1000/DT));this.sim.finished=this.partyRace.finished;}
    this.world.setCockpitOffset(loadCockpitOffsets()[me.carId]);
    this.partyLoadStep='Loading your car';this.emit();
    const loaded=await this.world.setCar(me.carId);this.partyLoadStep='Loading the circuit scenery';this.emit();await this.world.venueReady;
    if(this.partyRace?.id!==race.id)return;
    if(!loaded)throw new Error('Your car could not load. Return to lobby and retry.');
    if(this.world.venueLoadError)throw new Error(this.world.venueLoadError);
    this.partyLoadStep='Loading other drivers\' cars';this.emit();
    for(const racer of race.racers.filter(r=>r.id!==selfId)) {
      const model=await this.world.partyModel(racer.carId);
      if(this.partyRace?.id!==race.id)return;
      const group=new Group();group.add(model);const rig=new CarRig(model,carById(racer.carId));
      const label=document.createElement('canvas');label.width=512;label.height=64;
      const context=label.getContext('2d')!;context.fillStyle='#132127';context.fillRect(0,0,512,64);context.font='bold 32px sans-serif';context.textAlign='center';context.fillStyle='#ffffff';context.fillText(racer.nickname,256,44,480);
      const sprite=new Sprite(new SpriteMaterial({map:new CanvasTexture(label),depthTest:false}));sprite.scale.set(4,.5,1);sprite.position.y=2.4;group.add(sprite);
      const gate=race.grid[racer.slot];group.position.copy(gate.position);group.position.y+=.8;group.quaternion.copy(gate.rotation);
      this.world.scene.add(group);this.remoteCars.set(racer.id,{group,rig,wheels:{speed:0,steer:0,brake:0},carId:racer.carId,sequence:-1,samples:[],offset:Infinity,interval:120,spread:120});
    }
    // Ready means this screen can show the grid: compile every shader and upload every mesh first,
    // then let two frames draw. The server holds the lights until every driver reports ready.
    this.partyLoadStep='Warming up the track';this.emit();
    this.world.chase(this.sim,0,true);
    await this.world.prewarm([this.world.venueGroup,this.world.trackGroup,this.world.car,this.world.startLight,...[...this.remoteCars.values()].map(remote=>remote.group)]);
    await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
    if(this.partyRace?.id!==race.id)return;
    this.partyRace.ready=true;this.partyLoadStep='';this.world.skidMarks.clear();this.world.carDamage.reset();this.world.chase(this.sim,0,true);
    this.emit({trackReady:true,modelReady:true,time:me.finishedAt&&race.startAt?me.finishedAt-race.startAt:0});
  }
  syncParty(race:PartyRace,serverNow:number) {
    const local=this.partyRace;if(!local||local.id!==race.id)return;
    for(const racer of race.racers){const remote=this.remoteCars.get(racer.id);if(remote){
      if(racer.pose&&racer.pose.sequence>remote.sequence){remote.sequence=racer.pose.sequence;remote.target=racer.pose;addSample(remote,racer.pose,performance.now());}
      if(racer.finishedAt||racer.pose?.finished)remote.finishedAt??=performance.now();
      if(racer.disconnected)remote.group.visible=false;else if(!remote.finishedAt)remote.group.visible=true;
    }}
    const mine=race.racers.find(racer=>racer.id===this.partySelf);
    if(mine?.finishedAt){const place=race.racers.filter(racer=>racer.finishedAt&&racer.finishedAt<=mine.finishedAt!).length;if(place!==this.partyPlace){this.partyPlace=place;this.emit();}}
    if(local.ready&&local.finished&&this.state.mode!=='party-finished')this.emit({mode:'party-finished'});
    if(local.ready&&race.startAt&&!local.started&&!race.ended&&!local.finished){
      local.started=true;this.countdownUntil=performance.now()+race.startAt-serverNow;this.goAt=-Infinity;
      this.prepareAudio();this.world.setMouseLook(true);this.emit({mode:'countdown',countdown:6});
    }
    if(race.ended&&!local.finished){local.finished=true;this.keys.clear();this.emit({mode:'party-finished'});}
  }
  partyPose():PartyPose|undefined {
    const race=this.partyRace;if(!race?.ready||!race.started)return;
    return {...this.sim.frame(),sequence:++this.partySequence,lap:race.lap,checkpoint:this.sim.checkpoint,finished:race.finished,t:+(performance.now()-this.accumulator*1000).toFixed(1)};  // time of the physics tick the pose came from
  }
  /** Drivers you can watch: still racing, connected and visible. */
  spectateCandidates(){
    return [...this.remoteCars].filter(([,remote])=>remote.group.visible&&remote.finishedAt===undefined).map(([id])=>id);
  }
  private spectatedCar(){const remote=this.spectating?this.remoteCars.get(this.spectating):undefined;return remote&&remote.group.visible&&remote.finishedAt===undefined?remote:undefined;}
  /** Cycle the spectator camera through drivers still racing; step 0 returns to your own car. */
  spectate(step:-1|0|1){
    const ids=this.spectateCandidates();
    if(!step||!ids.length)this.spectating=undefined;
    else{const at=this.spectating?ids.indexOf(this.spectating):-1;this.spectating=ids[((at<0?(step>0?-1:0):at)+step+ids.length)%ids.length];}
    this.spectateSnap=true;this.world.resetMouseLook();this.emit();
  }
  /**
   * Spins, steers and lights another driver's car from its drawn motion: wheel spin from forward travel,
   * steering from turn rate (bicycle model, as in the physics), brake lamps from hard deceleration.
   */
  private animateRemoteWheels(remote:RemoteCar,dt:number) {
    const {group,rig,wheels}=remote,spec=carById(remote.carId),mpu=this.state.track.metersPerUnit;
    const forward=remoteForward.set(0,0,1).applyQuaternion(group.quaternion);
    let travel=0,steer=0;
    if(wheels.last&&wheels.heading){
      const moved=remoteDelta.subVectors(group.position,wheels.last);
      travel=moved.dot(forward);if(Math.abs(travel)*mpu>8)travel=0; // a respawn teleport, not driving
      const before=wheels.speed;wheels.speed+=(Math.abs(travel)*mpu/dt-wheels.speed)*(1-Math.exp(-dt*8));
      const turn=remoteTurnDelta.copy(wheels.heading).invert().multiply(group.quaternion),yawRate=2*Math.atan2(turn.y,turn.w)/dt;
      if(wheels.speed>1)steer=Math.max(-spec.physics.steerAngle,Math.min(spec.physics.steerAngle,Math.atan(yawRate*spec.dimensions.wheelbaseM/wheels.speed)*Math.sign(travel||1)));
      const decel=(before-wheels.speed)/dt;wheels.brake+=((decel>6&&travel>0?1:0)-wheels.brake)*(1-Math.exp(-dt*10));
    }
    wheels.steer+=(steer-wheels.steer)*(1-Math.exp(-dt*9));
    (wheels.last??=new Vector3()).copy(group.position);(wheels.heading??=new Quaternion()).copy(group.quaternion);
    rig.animate(wheels.steer,travel,wheels.brake);
  }
  endParty() {
    this.sound.update(this.sim,false,this.state.muted,this.settings);this.partyPlace=undefined;this.partyFinishedAt=0;this.world.endFinish();
    this.spectating=undefined;
    for(const [id,remote] of this.remoteCars)this.sim.setObstacle(id,remote.carId,undefined);this.partyFinishDriver=undefined;
    this.partyRace=undefined;this.partyWeather=undefined;this.keys.clear();
    for(const {group,rig} of this.remoteCars.values()){rig.dispose();this.world.scene.remove(group);group.traverse(object=>{if(object instanceof Sprite){object.material.map?.dispose();object.material.dispose();}});}
    this.remoteCars.clear();this.world.setWeather(this.settings.weather);
    const original=this.partyOriginalTrack;this.partyOriginalTrack=undefined;this.menu();
    if(original)void this.select(original);
  }
  /** Changes individual graphics options. The result is labelled with a preset name if it matches one, otherwise Custom. */
  setGraphics(patch:Partial<GraphicsOptions>){
    const graphics=sanitizeGraphics({...this.settings.graphics,...patch},this.settings.graphics);
    const match=(Object.keys(GRAPHICS_PRESETS) as GraphicsPreset[]).find(id=>JSON.stringify(GRAPHICS_PRESETS[id])===JSON.stringify(graphics));
    this.setSettings({graphics,graphicsQuality:match??'custom'});
  }
  private cameraSave?:number;
  private applySettings(){
    const s=this.settings;this.world.cameraOptions={fov:s.cameraFov,distance:s.cameraDistance,shake:s.cameraShake,recenter:s.cameraRecenter};
    // The cockpit preview in /dev drives the camera itself; otherwise follow the saved view.
    if(!this.cockpitPreview)this.world.cameraMode=s.cameraMode;
    // Wheel zoom is saved a moment after the wheel stops, not on every notch.
    this.world.onCameraDistance=distance=>{clearTimeout(this.cameraSave);this.cameraSave=window.setTimeout(()=>{this.settings={...this.settings,cameraDistance:distance};write('settings',this.settings);this.emit();},400);};
    this.world.setGraphics(this.settings.graphics,this.driving);this.world.setWeather(this.partyWeather??this.settings.weather);this.world.sensitivity=this.settings.sensitivity;this.world.pointerLockEnabled=this.settings.pointerLock;this.world.reducedMotion=this.settings.reducedMotion||matchMedia('(prefers-reduced-motion: reduce)').matches;}
  /** The car is moving under the player's control: no frame may stall now. */
  private get driving(){return !!this.state&&['racing','countdown','replay'].includes(this.state.mode)&&!this.partyView;}
  setSettings(patch:Partial<Settings>){
    // Picking a named preset loads its values; Custom keeps whatever is set now.
    if(patch.graphicsQuality&&!patch.graphics&&isPreset(patch.graphicsQuality))patch={...patch,graphics:{...GRAPHICS_PRESETS[patch.graphicsQuality]}};
    this.settings={...this.settings,...patch};write('settings',this.settings);this.applySettings();this.emit();}
  /** Lighter preset to suggest from each one; custom mixes are pointed at Normal. */
  private static LIGHTER:Record<GraphicsQuality,GraphicsPreset|undefined>={cinematic:'high',high:'balanced',balanced:'performance',performance:'lowest',lowest:undefined,custom:'balanced'};
  /**
   * Once a second while driving: if the average over the last 8 s sits well under the
   * target (75% of 60 fps, or of the frame cap), suggest the next lighter preset.
   * Loading and shader warm-up (first 6 s), hidden tabs and declined presets are ignored.
   */
  /** The finish run-off pose between the last two physics ticks. */
  private finishFrame(){return this.previousFrame?interpolateFrame(this.previousFrame,this.sim.frame(),this.accumulator/DT):undefined;}
  private watchFrameRate(now:number) {
    const driving=['racing','countdown'].includes(this.state.mode)&&!document.hidden&&!this.partyView;
    if(!driving){this.fpsSamples=[];this.drivingSince=now;return;}
    if(now-this.drivingSince<6000)return;
    this.fpsSamples.push(this.state.fps);if(this.fpsSamples.length>8)this.fpsSamples.shift();
    if(this.state.perfTip){if(now-this.perfShownAt>14000)this.declinePerfTip(180000);return;}
    const quality=this.settings.graphicsQuality,to=Game.LIGHTER[quality];
    if(!to||this.fpsSamples.length<8||(this.perfDeclined.get(quality)??0)>now)return;
    const cap=this.settings.graphics.fpsCap,target=Math.round((cap&&cap<60?cap:60)*.75);
    const average=this.fpsSamples.reduce((sum,fps)=>sum+fps,0)/this.fpsSamples.length;
    if(average<target){this.perfShownAt=now;this.emit({perfTip:{from:quality,to,fps:Math.round(average),target}});}
  }
  acceptPerfTip() {
    const tip=this.state.perfTip;if(!tip)return;
    this.fpsSamples=[];this.drivingSince=performance.now();
    this.setSettings({graphicsQuality:tip.to});this.emit({perfTip:undefined});
    if(this.world.hasPendingGraphics){this.emit({notice:`${PRESET_LABELS[tip.to]} graphics on · shadows and filtering switch at your next pause or restart`});this.noticeUntil=performance.now()+3500;}
  }
  /** Not now: stop suggesting a change from this preset for the rest of the session (or a few minutes if it timed out). */
  declinePerfTip(snooze=Infinity) {
    const tip=this.state.perfTip;if(!tip)return;
    this.perfDeclined.set(tip.from,performance.now()+snooze);this.fpsSamples=[];this.emit({perfTip:undefined});
  }
  private frame=(now:number)=>{
    requestAnimationFrame(this.frame);this.worstFrame=Math.max(this.worstFrame,now-this.previous);const elapsed=Math.min((now-this.previous)/1000,.05);this.previous=now;
    this.sound.frame(this.state.mode==='menu',this.state.muted,this.settings);
    // Static home previews do not need a WebGL render loop. Garage and the editor still render in 3D.
    // The engine is still told it is idle, or leaving a race from the pause menu leaves it droning.
    if(this.state.mode==='menu'&&!this.garageView&&!this.editorView&&!this.cockpitPreview&&!this.authoring){this.fpsTime=now;this.frameCount=0;this.sound.update(this.sim,false,this.state.muted,this.settings);return;}
    if(this.partyView){this.fpsTime=now;this.frameCount=0;this.sound.update(this.sim,false,this.state.muted,this.settings);return;}
    if(this.world.lookLocked&&now>=this.lookUnlockAt)this.world.lookLocked=false;
    if(now-this.fpsTime>1000){this.state={...this.state,fps:Math.round(this.frameCount*1000/(now-this.fpsTime)),worstFrame:Math.round(this.worstFrame)};this.worstFrame=0;this.world.adaptResolution(this.state.fps);this.frameCount=0;this.fpsTime=now;this.watchFrameRate(now);}
    // Track how long the throttle has been held, for false-start detection at the lights.
    if(this.held('throttle')){if(this.throttleDownAt<0)this.throttleDownAt=now;}else this.throttleDownAt=-1;
    if(this.state.mode==='countdown'){
      const count=Math.min(6,Math.ceil((this.countdownUntil-now)/900));if(count!==this.state.countdown){this.emit({countdown:Math.max(0,count)});if(count>0&&count<6)this.sound.cue('light',this.settings.effectsVolume);}
      if(now>=this.countdownUntil){
        // Online, holding the throttle through the lights is a jump start: the engine bogs down for a moment. Pressing right as they go out is fine.
        const jumped=!!this.partyRace&&this.throttleDownAt>=0&&this.throttleDownAt<this.countdownUntil-150;
        this.bogUntil=jumped?now+2500:0;
        this.accumulator=0;this.goAt=now;this.lookUnlockAt=now+Game.LOOK_LOCK_AFTER_GO_MS;this.sound.cue('go',this.settings.effectsVolume);this.emit({mode:'racing',notice:jumped?'False start! Engine bogged down':'Go!'});this.noticeUntil=now+(jumped?2500:800);
      }
    }
    if(this.state.mode==='celebrating'&&now>=this.finishRevealAt)this.emit({mode:'finished'});
    if(this.state.mode==='racing'||this.state.mode==='replay') {
      if(this.awaitingPedal&&(this.held('throttle')||this.held('brake'))){this.awaitingPedal=false;this.emit({notice:''});}
      if(!this.awaitingPedal||this.state.mode==='replay')this.accumulator+=elapsed;
      while(this.accumulator>=DT){
        this.previousFrame=this.sim.frame();const input=this.state.mode==='replay'?(this.replayInput?.inputs[this.sim.ticks]??0):this.input();
        if(!this.freeRoam)this.inputs.push(input);
        if(this.state.mode==='replay'&&this.replayInput)stepReplay(this.sim,this.replayInput);else this.sim.step(input);
        if(!this.freeRoam){this.steeringInputs.push(this.sim.steeringStrength);this.driftInputs.push(this.sim.driftStrength);}this.accumulator-=DT;
        if(this.sim.penalties!==this.lastPenalties){this.lastPenalties=this.sim.penalties;this.sound.cue('impact',this.settings.effectsVolume*.5);this.emit({penalties:this.sim.penalties});}
        if(this.freeRoam&&this.state.mode==='racing')this.trackDrift();
        if(this.routeRecording){const p=this.sim.car.translation(), last=this.routePoints.at(-1);if(!last||Math.hypot(p.x-last.x,p.z-last.z)>4)this.routePoints.push({x:p.x,y:p.y,z:p.z});}
        if(this.ghostSim&&this.ghostRun){this.previousGhostFrame=this.ghostSim.frame();stepReplay(this.ghostSim,this.ghostRun);}
        if(this.sim.checkpoint!==this.lastCheckpoint){this.lastCheckpoint=this.sim.checkpoint;this.sound.cue('checkpoint',this.settings.effectsVolume);this.emit({notice:`Checkpoint ${this.lastCheckpoint} / ${this.state.track.checkpoints.length}`});this.noticeUntil=now+1600;}
        if(this.sim.respawns!==this.lastRespawns){this.lastRespawns=this.sim.respawns;this.world.chase(this.sim,0,true);this.previousFrame=undefined;this.emit({notice:'Back on track'});this.noticeUntil=now+1100;}
        if(this.authoring||this.routeRecording)this.sim.finished=false;
        if(this.sim.finished){
          if(this.partyRace){
            if(this.partyRace.lap<this.partyRace.laps){this.partyRace.lap++;this.sim.finished=false;this.sim.checkpoint=0;this.lastCheckpoint=0;this.emit({checkpoint:0,notice:`Lap ${this.partyRace.lap} / ${this.partyRace.laps}`});}
            else {this.partyRace.finished=true;this.keys.clear();this.world.confettiBurst();this.sound.cue('finish',this.settings.effectsVolume);this.partyFinishedAt=now;this.partyFinishDriver=new FinishDriver(this.state.track);this.partyFinishDriver.begin(this.sim);this.partyFinishDriver.speed=Math.max(this.partyFinishDriver.speed,14/this.state.track.metersPerUnit);this.accumulator=0;this.emit({mode:'party-finished',time:Math.max(0,Math.round(now-this.countdownUntil))});break;}
          }else {if(this.state.mode==='replay'){this.replayInput=undefined;this.menu();}else this.finish();break;}
        }
        if(!this.partyRace&&!this.freeRoam&&this.sim.ticks>=MAX_TICKS){this.emit({mode:'paused',notice:'Five-minute limit reached. Restart to try again.'});break;}
      }
    }
    if(this.freeRoam&&this.state.mode==='racing'&&this.state.trackReady){
      const zone=this.state.track.lot!.startZone,p=this.sim.car.translation();
      const inside=Math.abs(p.x-zone.x)<zone.w/2&&Math.abs(p.z-zone.z)<zone.l/2;
      if(inside!==this.state.atStart)this.emit({atStart:inside});
    }else if(this.state.atStart)this.emit({atStart:false});
    if(this.state.track.lot){this.world.updateLot(this.state.mode==='menu'?undefined:this.sim,elapsed,this.freeRoam);if(this.state.mode==='racing')this.world.updateConfetti(elapsed);}
    if(this.state.mode==='menu'){if(this.cockpitPreview)this.world.chase(this.sim,elapsed);else if(this.editorView)this.world.editor(elapsed);else if(this.garageView)this.world.garage(elapsed);else this.world.overview(elapsed);this.world.ghostFrame(undefined);}else if(this.state.mode==='party-finished'&&this.partyFinishDriver){
      this.accumulator+=elapsed;
      while(this.accumulator>=DT){this.previousFrame=this.sim.frame();this.partyFinishDriver.step(this.sim);this.accumulator-=DT;}
      this.world.updateConfetti(elapsed);
      // Keep following your own car through the run-off unless you chose a driver to watch (camera set after remotes move).
      this.world.chase(this.sim,elapsed,false,this.finishFrame(),!this.spectatedCar());
    }else if(this.state.mode==='celebrating'||this.state.mode==='finished'){
      this.accumulator+=elapsed;
      while(this.accumulator>=DT){this.previousFrame=this.sim.frame();this.finishDriver?.step(this.sim);this.accumulator-=DT;}
      // Drawn between ticks exactly as while racing: the raw tick pose judders through the line on uneven frames.
      this.world.chase(this.sim,elapsed,false,this.finishFrame(),false);
      this.world.celebrateFinish(elapsed);
    }else{
      // Physics runs at 60 Hz; draw both cars between their last two ticks so
      // high-refresh displays and uneven frames stay smooth.
      const a=this.accumulator/DT,racing=this.state.mode==='racing'||this.state.mode==='replay';
      const display=racing&&this.previousFrame?interpolateFrame(this.previousFrame,this.sim.frame(),a):this.sim.frame();
      const ghost=this.ghostSim&&!this.ghostSim.finished?(racing&&this.previousGhostFrame?interpolateFrame(this.previousGhostFrame,this.ghostSim.frame(),a):this.ghostSim.frame()):undefined;
      this.world.lookBack=this.held('lookBack')&&racing;this.world.chase(this.sim,elapsed,false,display);this.world.ghostFrame(ghost);
    }
    this.sound.update(this.sim,['racing','replay','countdown','celebrating','finished'].includes(this.state.mode)||(this.state.mode==='party-finished'&&!!this.partyRace?.ready),this.state.muted,this.settings,!['celebrating','finished','party-finished'].includes(this.state.mode));
    this.world.skidMarks.update(this.sim,this.settings.skidMarks&&['racing','replay','paused','celebrating','finished'].includes(this.state.mode));
    this.world.carDamage.reducedMotion=this.world.reducedMotion;
    this.world.carDamage.update(this.sim,this.world.car,this.state.mode==='paused'?0:elapsed,this.settings.carDamage&&['racing','replay','paused','celebrating','finished','party-finished'].includes(this.state.mode));
    this.world.startLight.update(this.world.camera,this.state.mode==='countdown'?this.state.countdown:0,this.state.mode==='racing'?(now-this.goAt)/1000:Infinity,now/1000,this.world.reducedMotion,this.state.mode==='countdown'?(now-(this.countdownUntil-6500))/1000:Infinity);
    if(now-this.lastUI>65&&!['celebrating','finished'].includes(this.state.mode)){this.lastUI=now;const live:Partial<GameState>={time:this.partyRace?(this.state.mode==='party-finished'?this.state.time:this.partyRace.started?Math.max(0,Math.round(now-this.countdownUntil)):0):this.sim.timeMs,speed:Math.round(this.sim.speed*this.state.track.metersPerUnit*2.23694),checkpoint:this.sim.checkpoint,boost:this.sim.boosting,drifting:this.sim.drifting,...(this.noticeUntil&&now>this.noticeUntil&&this.state.mode==='racing'?{notice:''}:{})};
      // Menus and pauses re-render the whole interface; only do it when a shown value moved. Live driving modes always refresh for the RPM gauge.
      if(['countdown','racing','replay'].includes(this.state.mode)||(Object.keys(live) as (keyof GameState)[]).some(key=>live[key]!==this.state[key]))this.emit(live);}
    const solid=this.partyRace?.ready&&['countdown','racing','party-finished'].includes(this.state.mode);
    for(const [id,remote] of this.remoteCars){
      const {group,target}=remote;
      // Drawn slightly in the past on a smooth curve through the sender's timed poses, instead of chasing each 10 Hz update.
      const pose=target&&sampleRemote(remote,now);
      // Prediction is corrected as new poses arrive; ease into the corrected spot instead of jumping. Big jumps (respawns) snap.
      if(pose){
        const jump=Math.hypot(pose.p.x-group.position.x,pose.p.y-group.position.y,pose.p.z-group.position.z),blend=jump>8?1:1-Math.exp(-elapsed*20);
        group.position.lerp(remoteTarget.set(pose.p.x,pose.p.y,pose.p.z),blend);group.quaternion.slerp(remoteTurn.set(pose.q.x,pose.q.y,pose.q.z,pose.q.w),blend);
      }
      if(group.visible&&elapsed>0)this.animateRemoteWheels(remote,elapsed);
      // Finished drivers keep rolling for a moment on their screens, then fade out here and stop being solid.
      if(remote.finishedAt!==undefined&&group.visible){
        const opacity=1-Math.min(1,Math.max(0,((now-remote.finishedAt)/1000-2.5)/1.5));
        if(opacity<1){
          remote.fadeMaterials??=cloneMaterialsForFade(group);
          for(const material of remote.fadeMaterials){material.transparent=true;material.depthWrite=opacity>.6;material.opacity=opacity;}
        }
        if(opacity<=0)group.visible=false;
      }
      this.sim.setObstacle(id,remote.carId,solid&&group.visible&&remote.finishedAt===undefined&&target?{p:group.position,q:group.quaternion}:undefined,elapsed);
    }
    const watched=this.state.mode==='party-finished'?this.spectatedCar():undefined;
    if(watched){this.world.follow(watched.group,elapsed,this.spectateSnap);this.spectateSnap=false;}
    else if(this.spectating&&this.state.mode==='party-finished'){this.spectating=undefined;this.emit();}
    // The frame cap throttles drawing only; physics above already ran at its fixed rate.
    const sinceRender=(now-this.lastRender)/1000,cap=this.world.fpsCap;
    if(!cap||sinceRender*1000>=1000/cap-2){this.frameCount++;this.lastRender=now;this.world.updateWeather(Math.min(sinceRender,.1));this.world.render();}
  };
}
const fromQuaternion=new Quaternion(),toQuaternion=new Quaternion();
type PoseSample={t:number;p:Vec3;q:{x:number;y:number;z:number;w:number}};
type RemoteCar={group:Group;carId:CarId;target?:Frame;sequence:number;samples:PoseSample[];
  /** Wheel, steering and brake-lamp rig; poses carry no inputs, so these are inferred from the drawn motion. */
  rig:CarRig;wheels:{last?:Vector3;heading?:Quaternion;speed:number;steer:number;brake:number};
  /** Smallest (receipt time - sender time) seen: maps the sender's clock onto ours with the least network delay. */
  offset:number;
  /** Smoothed spacing between the sender's poses, in ms. */
  interval:number;
  /** Recent peak of extra delivery delay beyond the fastest packet, in ms; both sides poll, so poses arrive in uneven bursts. */
  spread:number;
  /** Sender-clock time currently drawn; advances with our frames and drifts gently toward the target so packets never make it jump. */
  clock?:number;lastFrame?:number;
  finishedAt?:number;fadeMaterials?:{opacity:number;transparent:boolean;depthWrite:boolean}[]};
function addSample(remote:RemoteCar,pose:{p:Vec3;q:{x:number;y:number;z:number;w:number};t?:number},receivedAt:number){
  const t=pose.t??receivedAt,last=remote.samples.at(-1);
  // A jump of more than 15 m (respawn, recovery) restarts the curve instead of drawing a streak across the track.
  if(last&&(t<=last.t||Math.hypot(pose.p.x-last.p.x,pose.p.y-last.p.y,pose.p.z-last.p.z)>15)){remote.samples.length=0;remote.clock=undefined;}
  if(last&&remote.samples.length)remote.interval+=(Math.min(500,t-last.t)-remote.interval)*.2;
  // Let the clock offset creep upward slowly so a one-off fast packet cannot pin it forever.
  remote.offset=Math.min(remote.offset+.5,receivedAt-t);
  remote.spread=Math.max(remote.spread*.97,receivedAt-t-remote.offset);
  remote.samples.push({t,p:pose.p,q:pose.q});if(remote.samples.length>12)remote.samples.shift();
}
const sampleQuaternionA=new Quaternion(),sampleQuaternionB=new Quaternion(),remoteTurn=new Quaternion();
const remoteTarget=new Vector3(),remoteForward=new Vector3(),remoteDelta=new Vector3(),remoteTurnDelta=new Quaternion();
/** Catmull-Rom position and slerped rotation at (now - delay) on the sender's clock; brief extrapolation if packets are late. */
function sampleRemote(remote:RemoteCar,now:number):PoseSample|undefined{
  const samples=remote.samples;if(!samples.length)return;
  if(samples.length===1||!Number.isFinite(remote.offset))return samples[0];
  // Draw where the car is now, not where it was: keep only a small buffer for network jitter and
  // extrapolate past the newest pose. The old 150-700 ms buffer left cars 10-30 m behind at speed,
  // so one driver could be on your bumper while you saw empty road.
  const delay=Math.max(40,Math.min(160,remote.spread*.6+20)),target=now-remote.offset-delay;
  const step=remote.lastFrame===undefined?0:now-remote.lastFrame;remote.lastFrame=now;
  if(remote.clock===undefined||Math.abs(target-remote.clock)>500)remote.clock=target;
  else remote.clock+=step*(1+Math.max(-.1,Math.min(.1,(target-remote.clock)/500)));
  const t=remote.clock;
  let i=samples.findIndex(sample=>sample.t>t);
  if(i===0)return samples[0];
  if(i<0){
    // Past the newest pose: carry on along the last motion (position and turn rate) for up to 450 ms, then hold.
    const a=samples.at(-2)!,b=samples.at(-1)!,span=Math.max(1,b.t-a.t),k=Math.min(450,t-b.t)/span;
    const q=sampleQuaternionA.set(a.q.x,a.q.y,a.q.z,a.q.w).slerp(sampleQuaternionB.set(b.q.x,b.q.y,b.q.z,b.q.w),1+Math.min(k,1.5));
    return {t,p:{x:b.p.x+(b.p.x-a.p.x)*k,y:b.p.y+(b.p.y-a.p.y)*k,z:b.p.z+(b.p.z-a.p.z)*k},q:{x:q.x,y:q.y,z:q.z,w:q.w}};
  }
  const p0=samples[Math.max(0,i-2)],p1=samples[i-1],p2=samples[i],p3=samples[Math.min(samples.length-1,i+1)];
  // Cubic Hermite with time-based tangents: speed stays continuous across poses even when they arrive unevenly spaced.
  const span=Math.max(1,p2.t-p1.t),u=(t-p1.t)/span,u2=u*u,u3=u2*u;
  const h00=2*u3-3*u2+1,h10=u3-2*u2+u,h01=-2*u3+3*u2,h11=u3-u2;
  const tangent=(a:PoseSample,b:PoseSample,k:'x'|'y'|'z')=>(b.p[k]-a.p[k])/Math.max(1,b.t-a.t)*span;
  const axis=(k:'x'|'y'|'z')=>h00*p1.p[k]+h10*tangent(p0===p1?p1:p0,p2,k)+h01*p2.p[k]+h11*tangent(p1,p3===p2?p2:p3,k);
  const q=sampleQuaternionA.set(p1.q.x,p1.q.y,p1.q.z,p1.q.w).slerp(sampleQuaternionB.set(p2.q.x,p2.q.y,p2.q.z,p2.q.w),u);
  return {t,p:{x:axis('x'),y:axis('y'),z:axis('z')},q:{x:q.x,y:q.y,z:q.z,w:q.w}};
}
/** Gives one remote car its own material copies (models share materials through the cache) and returns them for fading. */
function cloneMaterialsForFade(root:Group){
  const out:{opacity:number;transparent:boolean;depthWrite:boolean}[]=[];
  root.traverse(object=>{
    const holder=object as unknown as {material?:import('three').Material|import('three').Material[]};
    if(!holder.material)return;
    const copy=(m:import('three').Material)=>{const c=m.clone();out.push(c);return c;};
    holder.material=Array.isArray(holder.material)?holder.material.map(copy):copy(holder.material);
  });
  return out;
}
function interpolateFrame(from:Frame,to:Frame,amount:number):Frame {
  const q=fromQuaternion.set(from.q.x,from.q.y,from.q.z,from.q.w).slerp(toQuaternion.set(to.q.x,to.q.y,to.q.z,to.q.w),amount);
  return {p:{x:from.p.x+(to.p.x-from.p.x)*amount,y:from.p.y+(to.p.y-from.p.y)*amount,z:from.p.z+(to.p.z-from.p.z)*amount},q:{x:q.x,y:q.y,z:q.z,w:q.w}};
}
function smoothRoute(points:{x:number;y:number;z:number}[]) {
  if(points.length<3)return points;
  const result:{x:number;y:number;z:number}[]=[];
  for(let index=0;index<points.length;index+=2){const from=Math.max(0,index-2),to=Math.min(points.length-1,index+2),count=to-from+1;let x=0,y=0,z=0;for(let i=from;i<=to;i++){x+=points[i].x;y+=points[i].y;z+=points[i].z;}const point={x:x/count,y:y/count,z:z/count},last=result.at(-1);if(!last||Math.hypot(point.x-last.x,point.z-last.z)>7)result.push(point);}
  return result;
}
