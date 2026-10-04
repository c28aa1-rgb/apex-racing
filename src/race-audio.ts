import type { CarId } from '../shared/cars';
import { rotate, type Simulation } from '../shared/physics';
import type { Settings } from './settings';
import { assetUrl } from '../shared/assets';
import { loadSample, loadSamples } from './audio/loader';

// Synthesized engine voices: firing order harmonics, rev range and intake color.
// Low-rev character comes from short idle recordings (see public/audio/CREDITS.txt); the rest of
// the rev range, shifts and exhaust pops are synthesized, not recordings of the licensed vehicles.
export const ENGINE_VOICES: Record<CarId,{cylinders:number;harmonics:number[];filter:number;turbo:number}> = {
  'ferrari-488-gt3':{cylinders:8,harmonics:[1,.15,.7,.1,.35],filter:1900,turbo:.11},
  'mclaren-720s-gt3':{cylinders:8,harmonics:[1,.25,.48,.3,.18],filter:2300,turbo:.17},
  'bugatti-bolide':{cylinders:16,harmonics:[1,.55,.2,.13,.08],filter:1200,turbo:.24},
  'peugeot-9x8':{cylinders:6,harmonics:[1,.44,.6,.1,.24],filter:2100,turbo:.15},
  'celica-gt4':{cylinders:4,harmonics:[1,.8,.3,.2,.2],filter:1350,turbo:.2},
  'porsche-911-gt3':{cylinders:6,harmonics:[1,.28,.8,.15,.4],filter:2700,turbo:0},
  'porsche-963':{cylinders:8,harmonics:[1,.6,.35,.4,.1],filter:1850,turbo:.13},
  'mazda-787b':{cylinders:4,harmonics:[1,.3,.95,.25,.65,.22,.4],filter:3600,turbo:0},
  'skyline-r34':{cylinders:6,harmonics:[1,.5,.27,.35,.12],filter:1700,turbo:.28},
  'red-bull-rb19':{cylinders:6,harmonics:[1,.12,.62,.26,.42,.2],filter:3900,turbo:.19},
  'nascar-camry':{cylinders:8,harmonics:[1,.95,.48,.65,.25,.3],filter:1500,turbo:0},
};

/** Shared tire stress drives both audio and marks, without changing physics. */
export function tireStress(sim:Simulation) {
  if(!sim.grounded||sim.offRoad||sim.speed*sim.track.metersPerUnit<4)return 0;
  const side=rotate(sim.car.rotation(),{x:1,y:0,z:0}),v=sim.car.linvel();
  const lateral=Math.abs(v.x*side.x+v.y*side.y+v.z*side.z)*sim.track.metersPerUnit;
  return Math.min(1,Math.max(0,(lateral-.65)/6,sim.autoDrift*.9,sim.brake*.75-.2));
}

const SAMPLES={idleGt3:'idle-porsche-gt3',idleRally:'idle-rally',squeal:'tire-squeal',impact:'impact-hard',impactFast:'impact-fast',crash:'crash',light:'light',go:'go',click:'ui-click',hover:'ui-hover',confirm:'ui-confirm',back:'ui-back',select:'ui-select',shiftUp:'shift-up',shiftDown:'shift-down'} as const;
type SampleKey=keyof typeof SAMPLES;
export type UiCue='click'|'hover'|'confirm'|'back'|'select';
// Safari before 14.1 cannot play Ogg Vorbis, so every sample also ships as AAC (.m4a).
const AUDIO_EXT=(()=>{try{return document.createElement('audio').canPlayType('audio/ogg; codecs="vorbis"')?'ogg':'m4a';}catch{return 'ogg';}})();
const MUSIC_DIR='audio/music/';
const smooth=(x:number,a:number,b:number)=>{const t=Math.min(1,Math.max(0,(x-a)/(b-a)));return t*t*(3-2*t);};
export class RaceAudio {
  private context?:AudioContext;
  private engine?:OscillatorNode;
  private exhaust?:OscillatorNode;
  private master?:GainNode;private limiter?:DynamicsCompressorNode;
  private uiBus?:GainNode;private musicBus?:GainNode;
  private engineGain?:GainNode;
  private tireGain?:GainNode;
  private brakeGain?:GainNode;
  private windGain?:GainNode;
  private rainGain?:GainNode;
  private offRoadGain?:GainNode;private gravelGain?:GainNode;private kerbGain?:GainNode;private scrapeGain?:GainNode;private scrapeFilter?:BiquadFilterNode;
  private engineFilter?:BiquadFilterNode;
  private turbo?:OscillatorNode;private turboGain?:GainNode;
  private intakeGain?:GainNode;private tireTone?:OscillatorNode;private tireToneGain?:GainNode;
  private tireFilter?:BiquadFilterNode;
  private noise?:AudioBuffer;
  private samples:Partial<Record<SampleKey,AudioBuffer>>={};
  private idleSource?:AudioBufferSourceNode;private idleGain?:GainNode;private idleKey?:SampleKey;
  private squealSource?:AudioBufferSourceNode;private squealGain?:GainNode;
  /** Menu playlist, streamed from public/audio/music/playlist.json (optional; the menu is silent without it). */
  private musicEl?:HTMLAudioElement;private playlist:{file:string;title:string}[]=[];private playlistLoad?:Promise<void>;private trackIndex=0;private trackErrors=0;
  /** Title of the track now playing in the menu, for display. */
  nowPlaying='';
  private carId?:CarId;
  private lastGear=0;
  private lastHitCount=-1;
  private lastImpact=0;
  private shiftUntil=0;private blipUntil=0;
  private lastThrottle=0;private airSince=-1;private wasBoosting=false;
  private muted=false;
  /**
   * Opening the audio device takes hundreds of milliseconds on some systems.
   * Build the graph while the menu is idle; it stays suspended until start()
   * resumes it from the player's first race input.
   */
  prepare() {
    try { this.build(); } catch { /* Audio is optional on devices without Web Audio. */ }
  }
  start() {
    try {
      this.build();
      void this.context!.resume().catch(()=>{});
    } catch { /* Audio is optional on devices without Web Audio. */ }
  }
  private build() {
      if(!this.context){
        const c=this.context=new AudioContext();
        this.master=c.createGain();this.master.gain.value=0;
        const limiter=this.limiter=c.createDynamicsCompressor();limiter.threshold.value=-18;limiter.ratio.value=4;limiter.attack.value=.01;limiter.release.value=.18;this.master.connect(limiter).connect(c.destination);
        // Menu sounds and music bypass the race master, which is silent outside racing modes.
        this.uiBus=c.createGain();this.uiBus.gain.value=0;this.uiBus.connect(limiter);
        this.musicBus=c.createGain();this.musicBus.gain.value=0;this.musicBus.connect(limiter);
        this.engineFilter=c.createBiquadFilter();this.engineFilter.type='lowpass';
        this.engineGain=c.createGain();this.engineGain.gain.value=0;this.engineGain.connect(this.engineFilter).connect(this.master);
        this.engine=c.createOscillator();this.exhaust=c.createOscillator();this.exhaust.type='triangle';
        const bass=c.createGain();bass.gain.value=.26;this.exhaust.connect(bass).connect(this.engineGain);this.engine.connect(this.engineGain);
        this.engine.start();this.exhaust.start();
        const flutter=c.createOscillator(),depth=c.createGain();flutter.frequency.value=7;depth.gain.value=3;flutter.connect(depth).connect(this.engine.detune);flutter.start();
        this.turbo=c.createOscillator();this.turboGain=c.createGain();this.turboGain.gain.value=0;this.turbo.connect(this.turboGain).connect(this.master);this.turbo.start();
        const buffer=this.noise=c.createBuffer(1,c.sampleRate*2,c.sampleRate),data=buffer.getChannelData(0);
        for(let i=0;i<data.length;i++)data[i]=Math.random()*2-1;
        const noise=c.createBufferSource();noise.buffer=buffer;noise.loop=true;
        const intake=c.createBiquadFilter();intake.type='lowpass';intake.frequency.value=350;this.intakeGain=c.createGain();this.intakeGain.gain.value=0;noise.connect(intake).connect(this.intakeGain).connect(this.master);
        this.tireFilter=c.createBiquadFilter();this.tireFilter.type='bandpass';this.tireFilter.Q.value=1.2;
        this.tireGain=c.createGain();this.tireGain.gain.value=0;noise.connect(this.tireFilter).connect(this.tireGain).connect(this.master);
        this.tireTone=c.createOscillator();this.tireToneGain=c.createGain();this.tireToneGain.gain.value=0;this.tireTone.connect(this.tireToneGain).connect(this.master);this.tireTone.start();
        const brake=c.createBiquadFilter();brake.type='bandpass';brake.frequency.value=1400;brake.Q.value=2;
        this.brakeGain=c.createGain();this.brakeGain.gain.value=0;noise.connect(brake).connect(this.brakeGain).connect(this.master);
        const wind=c.createBiquadFilter();wind.type='lowpass';wind.frequency.value=750;
        const rain=c.createBiquadFilter();rain.type='lowpass';rain.frequency.value=2200;
        this.rainGain=c.createGain();this.rainGain.gain.value=0;noise.connect(rain).connect(this.rainGain).connect(this.master);
        this.windGain=c.createGain();this.windGain.gain.value=0;noise.connect(wind).connect(this.windGain).connect(this.master);
        // Grass hiss, gravel crunch, kerb rumble and a wall-rub scrape.
        const rumble=c.createBiquadFilter();rumble.type='lowpass';rumble.frequency.value=520;
        this.offRoadGain=c.createGain();this.offRoadGain.gain.value=0;noise.connect(rumble).connect(this.offRoadGain).connect(this.master);
        const crunch=c.createBiquadFilter();crunch.type='bandpass';crunch.frequency.value=2200;crunch.Q.value=.6;
        this.gravelGain=c.createGain();this.gravelGain.gain.value=0;noise.connect(crunch).connect(this.gravelGain).connect(this.master);
        const kerb=c.createBiquadFilter();kerb.type='lowpass';kerb.frequency.value=240;
        this.kerbGain=c.createGain();this.kerbGain.gain.value=0;noise.connect(kerb).connect(this.kerbGain).connect(this.master);
        this.scrapeFilter=c.createBiquadFilter();this.scrapeFilter.type='bandpass';this.scrapeFilter.frequency.value=1300;this.scrapeFilter.Q.value=.9;
        this.scrapeGain=c.createGain();this.scrapeGain.gain.value=0;noise.connect(this.scrapeFilter).connect(this.scrapeGain).connect(this.master);
        noise.start();
        // Samples are optional: every layer below falls back to the synthesized sound until they decode.
        const urls={} as Record<SampleKey,string>;for(const key of Object.keys(SAMPLES) as SampleKey[])urls[key]=assetUrl(`audio/${SAMPLES[key]}.${AUDIO_EXT}`);
        void loadSamples(c,urls).then(samples=>{this.samples=samples;});
      }
  }
  private play(key:SampleKey,volume:number,rate=1,bus:AudioNode|undefined=this.master) {
    const c=this.context,buffer=this.samples[key];if(!c||!bus||!buffer||volume<=0)return false;
    const source=c.createBufferSource(),gain=c.createGain();source.buffer=buffer;source.playbackRate.value=rate;gain.gain.value=volume;
    source.connect(gain).connect(bus);source.onended=()=>{source.disconnect();gain.disconnect();};source.start();return true;
  }
  /** Short filtered noise burst: exhaust pops, gear clunks and blow-off. */
  private burst(start:number,volume:number,frequency:number,duration:number,q=1.2,type:BiquadFilterType='bandpass') {
    const c=this.context;if(!c||!this.noise||!this.master||volume<=0)return;
    const source=c.createBufferSource(),filter=c.createBiquadFilter(),gain=c.createGain();
    source.buffer=this.noise;filter.type=type;filter.frequency.value=frequency;filter.Q.value=q;
    gain.gain.setValueAtTime(.0001,start);gain.gain.exponentialRampToValueAtTime(volume,start+.006);gain.gain.exponentialRampToValueAtTime(.0001,start+duration);
    source.connect(filter).connect(gain).connect(this.master);source.start(start,Math.random()*1.5,duration+.02);source.onended=()=>{source.disconnect();filter.disconnect();gain.disconnect();};
  }
  private pops(count:number,volume:number) {
    const c=this.context;if(!c)return;let at=c.currentTime+.02;
    for(let i=0;i<count;i++){at+=.04+Math.random()*.1;this.burst(at,volume*(.5+Math.random()*.5),160+Math.random()*320,.07+Math.random()*.05,1.4);this.burst(at,volume*.35,2400+Math.random()*900,.03,.8);}
  }
  cue(kind:'light'|'go'|'checkpoint'|'finish'|'impact',volume:number) {
    const c=this.context;if(!c||!this.master||volume<=0)return;
    if((kind==='light'||kind==='go')&&this.play(kind,Math.min(1,volume*1.6)))return;
    if(kind==='impact'&&this.play('impact',Math.min(1,volume*2)))return;
    if(kind==='finish'){
      [523.25,659.25,783.99].forEach((pitch,index)=>{
        const osc=c.createOscillator(),gain=c.createGain(),start=c.currentTime+index*.085;
        osc.type=index===1?'triangle':'sine';osc.frequency.setValueAtTime(pitch,start);osc.frequency.exponentialRampToValueAtTime(pitch*1.08,start+.72);
        gain.gain.setValueAtTime(.0001,start);gain.gain.exponentialRampToValueAtTime(.04*volume,start+.025);gain.gain.exponentialRampToValueAtTime(.0001,start+.9);
        osc.connect(gain).connect(this.master!);osc.start(start);osc.stop(start+.92);osc.onended=()=>{osc.disconnect();gain.disconnect();};
      });
      return;
    }
    const osc=c.createOscillator(),gain=c.createGain(),duration=kind==='impact'?.12:.18;
    osc.type=kind==='impact'?'triangle':'sine';const pitch={light:330,go:660,checkpoint:520,impact:65}[kind];
    osc.frequency.setValueAtTime(pitch,c.currentTime);osc.frequency.exponentialRampToValueAtTime(kind==='impact'?25:pitch*1.25,c.currentTime+duration);
    gain.gain.setValueAtTime(.0001,c.currentTime);gain.gain.exponentialRampToValueAtTime(.035*volume,c.currentTime+.018);gain.gain.exponentialRampToValueAtTime(.0001,c.currentTime+duration);
    osc.connect(gain).connect(this.master);osc.start();osc.stop(c.currentTime+duration+.02);osc.onended=()=>{osc.disconnect();gain.disconnect();};
  }
  /** Menu and interface sounds. They work outside race modes once the player has interacted with the page. */
  ui(kind:UiCue) {
    if(this.muted||!this.uiBus||this.context?.state!=='running')return;
    this.play(kind,kind==='hover'?.35:.7,kind==='hover'?1:.97+Math.random()*.06,this.uiBus);
  }
  /** Called every frame, including menus: keeps UI/music levels current and fades menu music in and out. */
  frame(menuMusic:boolean,muted:boolean,settings:Settings) {
    const c=this.context;this.muted=muted;if(!c||!this.uiBus||!this.musicBus)return;
    this.uiBus.gain.setTargetAtTime(muted?0:settings.volume*settings.effectsVolume*2.2,c.currentTime,.03);
    const wanted=menuMusic&&!muted&&settings.musicVolume>0&&c.state==='running';
    if(wanted)this.startMusic(c);
    this.musicBus.gain.setTargetAtTime(wanted?settings.volume*settings.musicVolume*.6:0,c.currentTime,wanted?.8:.35);
    if(!wanted&&this.musicEl&&!this.musicEl.paused&&this.musicBus.gain.value<.002)this.musicEl.pause();
  }
  /** Starts or resumes the shuffled menu playlist; each track streams, so memory stays small. */
  private startMusic(c:AudioContext) {
    if(!this.musicEl){
      this.playlistLoad??=fetch(assetUrl(`${MUSIC_DIR}playlist.json`)).then(r=>r.ok?r.json():[]).then((list:unknown)=>{
        const tracks=Array.isArray(list)?list.filter((t):t is {file:string;title:string}=>typeof t?.file==='string'&&typeof t?.title==='string'):[];
        for(let i=tracks.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[tracks[i],tracks[j]]=[tracks[j],tracks[i]];}
        this.playlist=tracks;
      }).catch(()=>{});
      if(!this.playlist.length)return;
      const el=this.musicEl=new Audio();el.preload='auto';
      c.createMediaElementSource(el).connect(this.musicBus!);
      el.addEventListener('ended',()=>{this.trackErrors=0;this.nextTrack();});
      // A missing or undecodable file skips to the next one; give up if several fail in a row.
      el.addEventListener('error',()=>{if(++this.trackErrors<4)this.nextTrack();});
      this.loadTrack();
    }
    if(this.musicEl.paused&&this.musicEl.src)void this.musicEl.play().catch(()=>{});
  }
  private loadTrack() {
    const el=this.musicEl,track=this.playlist[this.trackIndex%this.playlist.length];if(!el||!track)return;
    el.src=assetUrl(`${MUSIC_DIR}${track.file}.${AUDIO_EXT}`);this.nowPlaying=track.title;
  }
  private nextTrack() {
    this.trackIndex=(this.trackIndex+1)%Math.max(1,this.playlist.length);this.loadTrack();void this.musicEl?.play().catch(()=>{});
  }
  private setIdleSample(key:SampleKey) {
    const c=this.context,buffer=this.samples[key];if(!c||!buffer||this.idleKey===key)return;
    this.idleSource?.stop();this.idleKey=key;
    const source=this.idleSource=c.createBufferSource();source.buffer=buffer;source.loop=true;
    this.idleGain??=(()=>{const gain=c.createGain();gain.gain.value=0;gain.connect(this.master!);return gain;})();
    source.connect(this.idleGain);source.start(0,Math.random()*buffer.duration);
  }
  update(sim:Simulation,active:boolean,muted:boolean,settings:Settings,driving=true) {
    const c=this.context;if(!c||!this.master)return;
    this.master.gain.setTargetAtTime(active&&!muted?settings.volume:0,c.currentTime,.05);
    if(!active){this.lastHitCount=-1;this.airSince=-1;this.lastThrottle=0;return;}
    const effects=settings.effectsVolume,now=c.currentTime;
    this.rainGain?.gain.setTargetAtTime(settings.weather==='rain'?effects*.09:0,now,.4);
    const voice=ENGINE_VOICES[sim.carSpec.id],speed=sim.speed*sim.track.metersPerUnit;
    if(this.carId!==sim.carSpec.id){
      this.carId=sim.carSpec.id;this.lastGear=0;this.idleKey=undefined;
      this.engine!.setPeriodicWave(c.createPeriodicWave(new Float32Array(voice.harmonics.length+1),new Float32Array([0,...voice.harmonics])));
    }
    const gear=sim.gear,load=sim.throttle+sim.reverse,{rpm,redline,idle}=sim.engine,frac=Math.min(1,Math.max(0,(rpm-idle)/(redline-idle)));
    // Shifts: a brief cut and clunk going up; a throttle blip and crackle coming down.
    if(gear!==this.lastGear&&this.lastGear>0){
      if(gear>this.lastGear){
        this.shiftUntil=now+.15;if(!this.play('shiftUp',Math.min(1,effects*1.5),.95+Math.random()*.1))this.burst(now+.04,effects*.05,260,.09,.9);
        if(sim.throttle>.5&&frac>.55&&Math.random()<.5)this.pops(1,effects*.06);
      }else{
        this.blipUntil=now+.22;if(!this.play('shiftDown',Math.min(1,effects*1.5),.95+Math.random()*.1))this.burst(now+.03,effects*.06,200,.1,.9);
        if(frac>.3)this.pops(1+Math.floor(Math.random()*3),effects*.07);
      }
    }
    this.lastGear=gear;
    // Lifting off at high revs: crackle, plus turbo blow-off on boosted cars.
    if(this.lastThrottle>.7&&sim.throttle<.15&&frac>.5&&sim.grounded){
      this.pops(2+Math.floor(Math.random()*4),effects*.06*(.5+frac));
      if(voice.turbo>0)this.burst(now+.02,effects*.05*voice.turbo*4,3200,.28,.7,'highpass');
    }
    this.lastThrottle=sim.throttle;
    const frequency=rpm/60*voice.cylinders/2;
    this.engine!.frequency.setTargetAtTime(frequency,now,.07);this.exhaust!.frequency.setTargetAtTime(frequency/2,now,.07);
    const limiter=sim.manual&&rpm>redline*.98?.6+.25*Math.sin(now*42):1;
    // The recorded idle fades out as revs climb and the synthesized engine takes over.
    const idleKey:SampleKey=voice.cylinders<=4?'idleRally':'idleGt3';this.setIdleSample(idleKey);
    const sampled=!!this.idleSource,low=1-smooth(frac,.08,.4);
    if(this.idleSource){this.idleSource.playbackRate.setTargetAtTime(.8+frac*1.2,now,.08);this.idleGain!.gain.setTargetAtTime(settings.engineVolume*.9*low*(driving?1:.4),now,.1);}
    const blip=now<this.blipUntil?1.45:1;
    this.engineGain!.gain.setTargetAtTime(settings.engineVolume*(.015+load*.043)*(now<this.shiftUntil?.3:1)*blip*limiter*(driving?1:.4)*(sampled?.4+.6*smooth(frac,.05,.4):1),now,.035);
    this.engineFilter!.frequency.setTargetAtTime(voice.filter*(.38+load*.48),now,.12);
    this.intakeGain!.gain.setTargetAtTime(settings.engineVolume*load*.045,now,.1);
    this.turbo!.frequency.setTargetAtTime(900+rpm*.22,now,.28);this.turboGain!.gain.setTargetAtTime(settings.engineVolume*voice.turbo*load*.024,now,.2);
    // Tires: the recorded squeal carries slides and drifts; the synthesized layers remain as fallback and for braking.
    const stress=tireStress(sim),squeal=this.samples.squeal;
    if(squeal&&!this.squealSource){
      const source=this.squealSource=c.createBufferSource();source.buffer=squeal;source.loop=true;
      this.squealGain=c.createGain();this.squealGain.gain.value=0;source.connect(this.squealGain).connect(this.master);source.start(0,Math.random()*squeal.duration);
    }
    if(this.squealSource){
      const slide=smooth(stress,.3,.9);
      this.squealSource.playbackRate.setTargetAtTime(.85+stress*.4,now,.08);this.squealGain!.gain.setTargetAtTime(slide*slide*effects*1.3,now,.07);
    }
    const synthTires=squeal?.25:1;
    this.tireFilter!.frequency.setTargetAtTime(450+Math.min(speed,90)*7,now,.12);
    this.tireGain!.gain.setTargetAtTime(stress*effects*.06*synthTires,now,.12);
    this.tireTone!.frequency.setTargetAtTime(600+stress*210+Math.sin(now*19)*12,now,.08);this.tireToneGain!.gain.setTargetAtTime(stress*stress*effects*.006*synthTires,now,.12);
    this.brakeGain!.gain.setTargetAtTime(sim.grounded&&speed>3?sim.brake*effects*.012:0,now,.08);
    this.windGain!.gain.setTargetAtTime(effects*Math.min(speed/90,1)*.025,now,.15);
    // Surface under each wheel: grass hiss, gravel crunch and kerb/rough-ground rumble.
    let grass=0,gravel=0;for(const surface of sim.wheelSurface){if(surface===1)grass++;else if(surface===2)gravel++;}
    const surfaceSpeed=Math.min(speed/25,1);
    this.offRoadGain!.gain.setTargetAtTime(effects*surfaceSpeed*(grass+gravel*.5)/4*.18,now,.1);
    this.gravelGain!.gain.setTargetAtTime(effects*surfaceSpeed*gravel/4*.1,now,.1);
    this.kerbGain!.gain.setTargetAtTime(sim.grounded?effects*Math.min(speed/18,1)*smooth(sim.suspensionJolt,.006,.03)*.5:0,now,.04);
    // Boost pad whoosh on the rising edge.
    if(sim.boosting&&!this.wasBoosting){
      this.burst(now,effects*.12,500,.7,.8);this.burst(now+.12,effects*.08,1800,.55,.7);
      this.play('impactFast',effects*.6,.45);
    }
    this.wasBoosting=sim.boosting;
    // Landing thump after real air time.
    if(!sim.grounded){if(this.airSince<0)this.airSince=now;}
    else{
      if(this.airSince>=0&&now-this.airSince>.25){const air=Math.min(1.4,now-this.airSince);this.play('impactFast',Math.min(1,effects*air*1.5),.5+Math.random()*.1);this.burst(now,effects*.1*air,110,.25,.8,'lowpass');}
      this.airSince=-1;
    }
    // Real contact events from the physics world: a hit on the rising edge, a scrape while the chassis stays against something.
    if(this.lastHitCount<0)this.lastHitCount=sim.hitCount;
    if(sim.hitCount!==this.lastHitCount){
      this.lastHitCount=sim.hitCount;
      if(now-this.lastImpact>.15){
        this.lastImpact=now;const force=Math.min(1.6,sim.lastHitSpeed/12);
        if(sim.lastHitWithCar){this.play('impactFast',Math.min(1,effects*(.8+force)),1.1+Math.random()*.15);this.play('impact',Math.min(1,effects*force),1.2);}
        else{
          if(sim.lastHitSpeed>16)this.play('crash',Math.min(1,effects*1.8));
          if(!this.play('impact',Math.min(1,effects*(.6+force*1.1)),1.05-force*.15+Math.random()*.1))this.cue('impact',effects);
        }
      }
    }
    const rubbing=sim.wallContact&&sim.grounded&&speed>4;
    this.scrapeGain!.gain.setTargetAtTime(rubbing?Math.min(1,speed/30)*effects*.22:0,now,rubbing?.05:.12);
    this.scrapeFilter!.frequency.setTargetAtTime(900+Math.min(speed,80)*18,now,.1);
  }
}
