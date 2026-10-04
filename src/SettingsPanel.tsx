import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion, type Transition } from 'framer-motion';
import type { Game } from './game';
import { DEFAULT_SETTINGS, type WeatherPreset } from './settings';
import { GRAPHICS_PRESETS, PRESET_HELP, PRESET_LABELS, isPreset, type GraphicsOptions, type GraphicsQuality } from './graphics';
import { ACTION_LABELS, bindingChange, bindingConflicts, keyLabel, type Action } from './controls';
import { CAMERA_HELP, CAMERA_LABELS, CAMERA_MODES } from './camera-modes';

// One motion vocabulary for the whole panel: springs for things that arrive, a short ease-in for things that leave.
const ARRIVE: Transition = { type: 'spring', stiffness: 520, damping: 40, mass: .9 };
const SLIDE: Transition = { type: 'spring', stiffness: 380, damping: 36 };
const LEAVE: Transition = { duration: .14, ease: [.4, 0, 1, 1] };
const TABS = ['Driving', 'Camera', 'Graphics', 'Sound', 'Controls'] as const;
type Tab = typeof TABS[number];

/** Rows cascade in 24 ms apart (kept under 200 ms in total) when a tab opens. */
function Rows({ children, still }: { children: ReactNode; still: boolean }) {
  return <motion.div className="settings-rows" initial="hidden" animate="shown" variants={{ shown: { transition: { staggerChildren: still ? 0 : .024, delayChildren: still ? 0 : .04 } } }}>{children}</motion.div>;
}
const rowMotion = { variants: { hidden: { opacity: 0, y: 8 }, shown: { opacity: 1, y: 0, transition: ARRIVE } } };

export function SettingsPanel({ game }: { game: Game }) {
  const [tab, setTab] = useState<Tab>('Driving'), s = game.settings, g = s.graphics;
  const still = Boolean(useReducedMotion() || s.reducedMotion);
  // Direction of the last tab change, so content slides in from the side it came from.
  const previous = useRef(0), [direction, setDirection] = useState(1);
  const choose = (next: Tab) => { const index = TABS.indexOf(next); setDirection(index >= previous.current ? 1 : -1); previous.current = index; setTab(next); };
  const [armed, setArmed] = useState<{ action: Action; index: number }>(), [message, setMessage] = useState('');
  const conflicts = useMemo(() => bindingConflicts(s.bindings), [s.bindings]);
  useEffect(() => {
    if (!armed) return;
    const listen = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopImmediatePropagation(); if (e.repeat) return;
      if (e.code === 'Escape') { setArmed(undefined); setMessage('Rebinding cancelled.'); return; }
      if (e.altKey || e.ctrlKey || e.metaKey) { setMessage('Use one key without Ctrl, Alt or Command.'); return; }
      const result = bindingChange(game.settings.bindings, armed.action, armed.index, e.code);
      if (result.error) { setMessage(result.error); return; }
      game.setSettings({ bindings: result.bindings! }); setArmed(undefined);
      const shared = result.shared ?? [];
      setMessage(shared.length ? `${keyLabel(e.code)} now does two jobs: ${[armed.action, ...shared].map(a => ACTION_LABELS[a]).join(' and ')}.` : `${ACTION_LABELS[armed.action]} bound to ${keyLabel(e.code)}.`);
    };
    addEventListener('keydown', listen, true); return () => removeEventListener('keydown', listen, true);
  }, [armed, game]);
  const sharedWith = (action: Action, code: string) => (conflicts.get(code) ?? []).filter(other => other !== action);
  const row = (key: string, label: ReactNode, control: ReactNode, className = '') => <motion.label key={key} className={`setting-row ${className}`} {...rowMotion}>{label}{control}</motion.label>;

  return <div className="settings-panel">
    <nav aria-label="Settings categories">{TABS.map(item => <button key={item} className={tab === item ? 'selected' : ''} aria-current={tab === item} onClick={() => choose(item)}>
      {item}{tab === item && <motion.span className="tab-marker" layoutId="settings-tab-marker" transition={still ? { duration: 0 } : SLIDE} />}
    </button>)}</nav>
    <div className="settings-stage">
      {/* Both tabs share one fixed-height stage and cross over each other, so switching never changes the panel height or reflows mid-slide. */}
      <AnimatePresence initial={false} custom={direction}>
        <motion.section key={tab} aria-label={`${tab} settings`} custom={direction}
          variants={{ enter: (d: number) => ({ opacity: 0, x: still ? 0 : 22 * d }), center: { opacity: 1, x: 0 }, exit: (d: number) => ({ opacity: 0, x: still ? 0 : -14 * d, transition: { duration: .14, ease: [.4, 0, 1, 1] } }) }}
          initial="enter" animate="center" exit="exit" transition={still ? { duration: 0 } : { x: { type: 'spring', stiffness: 420, damping: 42 }, opacity: { duration: .16, ease: [.2, .8, .2, 1] } }}>
          {tab === 'Driving' && <Rows still={still}>
            <motion.p className="settings-intro" {...rowMotion}>Set your view. Keep your line.</motion.p>
            {row('advanced', <span>Advanced driving<small>Manual gears · +100 REP for completing a race. Takes effect on your next start or restart.</small></span>, <input type="checkbox" checked={s.advancedDriving} onChange={e => game.setSettings({ advancedDriving: e.target.checked })} />, 'advanced-setting')}
            <AnimatePresence initial={false}>{s.advancedDriving && <motion.p key="manual-help" className="muted-text" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0, transition: LEAVE }} transition={ARRIVE}>Shift up with {game.keyHint('shiftUp')}, down with {game.keyHint('shiftDown')}. Shift near the red line; a low gear limits your speed. Unsafe downshifts are blocked. No clutch required.</motion.p>}</AnimatePresence>
            {([['pointerLock', 'Lock mouse while driving', 'Escape releases the pointer and pauses.'], ['skidMarks', 'Tire marks', 'Rubber trails follow loaded tires and slides.'], ['reducedMotion', 'Reduced motion', 'Steadier cameras, previews and a still start-light drone.']] as const).map(([key, label, help]) => row(key, <span>{label}<small>{help}</small></span>, <input type="checkbox" checked={s[key]} onChange={e => game.setSettings({ [key]: e.target.checked })} />))}
            {row('steering', <span>Steering strength</span>, <><input type="range" min=".7" max="2" step=".01" value={game.state.steeringStrength} onChange={e => game.setSteeringStrength(+e.target.value)} /><output>{Math.round(game.state.steeringStrength * 100)}%</output></>)}
            {row('drift', <span>Drift amount</span>, <><input type="range" min="0" max="2" step=".01" value={game.state.driftStrength} onChange={e => game.setDriftStrength(+e.target.value)} /><output>{Math.round(game.state.driftStrength * 100)}%</output></>)}
          </Rows>}
          {tab === 'Camera' && <Rows still={still}>
            <motion.p className="settings-intro" {...rowMotion}>Frame the drive.</motion.p>
            <motion.div className="camera-modes" role="radiogroup" aria-label="Camera view" {...rowMotion}>
              {CAMERA_MODES.map(mode => <button key={mode} role="radio" aria-checked={s.cameraMode === mode} className={s.cameraMode === mode ? 'selected' : ''} onClick={() => game.setCamera(mode)}>
                {s.cameraMode === mode && <motion.span className="camera-mode-marker" layoutId="camera-mode-marker" transition={still ? { duration: 0 } : SLIDE} />}
                <strong>{CAMERA_LABELS[mode]}</strong><small>{CAMERA_HELP[mode]}</small>
              </button>)}
            </motion.div>
            <motion.p className="camera-keys muted-text" {...rowMotion}><kbd>{game.keyHint('camera')}</kbd> cycles views · <kbd>Wheel</kbd> zooms chase views · hold <kbd>{game.keyHint('lookBack')}</kbd> to look behind · move the mouse to look around</motion.p>
            {row('fov', <span>Field of view<small>Speed widens it further in exterior views.</small></span>, <><input type="range" min="45" max="80" step="1" value={s.cameraFov} onChange={e => game.setSettings({ cameraFov: +e.target.value })} /><output>{s.cameraFov}°</output></>)}
            {row('distance', <span>Camera distance<small>Chase, far chase and drone. The mouse wheel changes it too.</small></span>, <><input type="range" min=".6" max="1.8" step=".02" value={s.cameraDistance} onChange={e => game.setSettings({ cameraDistance: +e.target.value })} /><output>{Math.round(s.cameraDistance * 100)}%</output></>)}
            {row('sensitivity', <span>Mouse sensitivity<small>Looking around in every view.</small></span>, <><input type="range" min=".25" max="2.5" step=".05" value={s.sensitivity} onChange={e => game.setSettings({ sensitivity: +e.target.value })} /><output>{s.sensitivity.toFixed(2)}×</output></>)}
            {row('recenter', <span>Auto re-centre<small>After you look around, the view eases back behind the car.</small></span>, <input type="checkbox" checked={s.cameraRecenter} onChange={e => game.setSettings({ cameraRecenter: e.target.checked })} />)}
            {row('shake', <span>Camera shake<small>Kerbs, bumps and impacts. Off with reduced motion.</small></span>, <input type="checkbox" checked={s.cameraShake} onChange={e => game.setSettings({ cameraShake: e.target.checked })} />)}
          </Rows>}
          {tab === 'Graphics' && <Rows still={still}>
            {row('weather', <span>Weather</span>, <select aria-label="Weather" value={s.weather} onChange={e => game.setSettings({ weather: e.target.value as WeatherPreset })}>{(['clear', 'rain', 'snow', 'fog'] as const).map(preset => <option key={preset} value={preset}>{preset[0].toUpperCase() + preset.slice(1)}</option>)}</select>)}
            {row('preset', <span>Preset<small>{isPreset(s.graphicsQuality) ? PRESET_HELP[s.graphicsQuality] : 'Your own mix. Pick a preset to start over from it.'}</small></span>, <select aria-label="Graphics quality" value={s.graphicsQuality} onChange={e => game.setSettings({ graphicsQuality: e.target.value as GraphicsQuality })}>{([...Object.keys(GRAPHICS_PRESETS), 'custom'] as GraphicsQuality[]).map(id => <option key={id} value={id}>{PRESET_LABELS[id]}</option>)}</select>)}
            {row('fps', <span>Show FPS<small>Frame rate, slowest frame and resolution during races.</small></span>, <input type="checkbox" aria-label="Show FPS" checked={s.showFps} onChange={e => game.setSettings({ showFps: e.target.checked })} />)}
            <motion.p className="settings-intro graphics-subhead" {...rowMotion}>Fine tune</motion.p>
            {row('scale', <span>Resolution<small>Lower is faster. Capped by your screen's pixel density.</small></span>, <><input type="range" aria-label="Resolution" min=".5" max="2" step=".05" value={g.renderScale} onChange={e => game.setGraphics({ renderScale: +e.target.value })} /><output>{Math.round(g.renderScale * 100)}%</output></>)}
            {row('adaptive', <span>Auto resolution<small>Lowers resolution when the frame rate drops, then recovers.</small></span>, <input type="checkbox" aria-label="Auto resolution" checked={g.adaptive} onChange={e => game.setGraphics({ adaptive: e.target.checked })} />)}
            {g.adaptive && row('target', <span>Target frame rate</span>, <select aria-label="Target frame rate" value={g.targetFps} onChange={e => game.setGraphics({ targetFps: +e.target.value as GraphicsOptions['targetFps'] })}>{[30, 45, 60].map(v => <option key={v} value={v}>{v} fps</option>)}</select>)}
            {row('cap', <span>Frame rate limit<small>Cap rendering to save heat and battery. Driving physics is unaffected.</small></span>, <select aria-label="Frame rate limit" value={g.fpsCap} onChange={e => game.setGraphics({ fpsCap: +e.target.value as GraphicsOptions['fpsCap'] })}>{[[0, 'Unlimited'], [30, '30 fps'], [60, '60 fps'], [120, '120 fps']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>)}
            {row('shadows', <span>Shadows<small>Car shadow on the road. Biggest cost on weak GPUs.</small></span>, <select aria-label="Shadows" value={g.shadows} onChange={e => game.setGraphics({ shadows: +e.target.value as GraphicsOptions['shadows'] })}>{[[0, 'Off'], [512, 'Low'], [1024, 'Medium'], [2048, 'High']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>)}
            {row('draw', <span>View distance<small>How far scenery is drawn before fog hides it.</small></span>, <><input type="range" aria-label="View distance" min="800" max="8000" step="100" value={g.drawDistance} onChange={e => game.setGraphics({ drawDistance: +e.target.value })} /><output>{(g.drawDistance / 1000).toFixed(1)} km</output></>)}
            {row('lod', <span>Distant detail<small>Where far scenery switches to simpler meshes.</small></span>, <select aria-label="Distant detail" value={g.lodDistance} onChange={e => game.setGraphics({ lodDistance: +e.target.value })}>{[[0, 'Full detail everywhere'], [800, 'Far'], [500, 'Normal'], [350, 'Near'], [250, 'Closest']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>)}
            {row('aniso', <span>Texture sharpness<small>Anisotropic filtering on road and ground at shallow angles.</small></span>, <select aria-label="Texture sharpness" value={g.anisotropy} onChange={e => game.setGraphics({ anisotropy: +e.target.value as GraphicsOptions['anisotropy'] })}>{[1, 2, 4, 8, 16].map(v => <option key={v} value={v}>{v}×</option>)}</select>)}
            {row('smoothing', <span>Edge smoothing<small>Post-process anti-aliasing.</small></span>, <input type="checkbox" aria-label="Edge smoothing" checked={g.smoothing} onChange={e => game.setGraphics({ smoothing: e.target.checked })} />)}
            {row('bloom', <span>Bloom<small>Soft glow around bright lights.</small></span>, <input type="checkbox" aria-label="Bloom" checked={g.bloom} onChange={e => game.setGraphics({ bloom: e.target.checked })} />)}
            {row('density', <span>Rain and snow amount</span>, <><input type="range" aria-label="Rain and snow amount" min=".1" max="1" step=".05" value={g.weatherDensity} onChange={e => game.setGraphics({ weatherDensity: +e.target.value })} /><output>{Math.round(g.weatherDensity * 100)}%</output></>)}
          </Rows>}
          {tab === 'Sound' && <Rows still={still}>
            <motion.p className="settings-intro" {...rowMotion}>Engine, tires, track.</motion.p>
            {([['volume', 'Master volume'], ['engineVolume', 'Engine & exhaust'], ['effectsVolume', 'Tires, brakes & race signals'], ['musicVolume', 'Menu music']] as const).map(([key, label]) => row(key, <span>{label}</span>, <><input type="range" min="0" max="1" step=".01" value={s[key]} onChange={e => game.setSettings({ [key]: +e.target.value })} /><output>{Math.round(s[key] * 100)}%</output></>))}
            {row('mute', <span>Mute all sound</span>, <input type="checkbox" checked={game.state.muted} onChange={() => game.toggleMute()} />)}
            <motion.p className="muted-text" {...rowMotion}>Each car has its own engine voice, rev range and gear sequence. Low-rev idle uses short recordings; the rest of the engine, shifts and exhaust pops are synthesized, not recordings of these cars.</motion.p>
          </Rows>}
          {tab === 'Controls' && <Rows still={still}>
            <motion.p className="settings-intro" {...rowMotion}>Your keys. Your line.</motion.p>
            <motion.p className="muted-text" {...rowMotion}>Select a key, then press its replacement. A key can do two jobs; when it does, both happen together, and it is marked below. Escape cancels rebinding and always releases the mouse.</motion.p>
            <AnimatePresence initial={false}>{conflicts.size > 0 && <motion.div key="conflicts" className="binding-conflicts" role="alert"
              initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0, transition: LEAVE }} transition={ARRIVE}>
              <strong>{conflicts.size === 1 ? 'One key does two jobs' : `${conflicts.size} keys do two jobs`}</strong>
              <ul>{[...conflicts].map(([code, actions]) => <motion.li key={code} layout={!still} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={ARRIVE}><kbd>{keyLabel(code)}</kbd>{actions.map(a => ACTION_LABELS[a]).join(' + ')}</motion.li>)}</ul>
            </motion.div>}</AnimatePresence>
            <motion.div className="binding-list" {...rowMotion}>{(Object.keys(ACTION_LABELS) as Action[]).map(action => {
              const shared = [...new Set(s.bindings[action].flatMap(code => sharedWith(action, code)))];
              return <div key={action} className={shared.length ? 'has-conflict' : ''}>
                <span>{ACTION_LABELS[action]}<AnimatePresence initial={false}>{shared.length > 0 && <motion.small key="shared" className="binding-shared" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0, transition: LEAVE }} transition={ARRIVE}>Also {shared.map(a => ACTION_LABELS[a].toLowerCase()).join(', ')}</motion.small>}</AnimatePresence></span>
                <div>{s.bindings[action].map((code, index) => {
                  const listening = armed?.action === action && armed.index === index, clash = sharedWith(action, code).length > 0;
                  return <motion.button key={index} layout={!still} whileTap={still ? undefined : { scale: .94 }} transition={ARRIVE}
                    className={`${listening ? 'listening' : ''} ${clash ? 'is-shared' : ''}`} aria-label={`Rebind ${ACTION_LABELS[action]} ${index === 0 ? 'primary' : 'alternate'}${clash ? `, also used by ${sharedWith(action, code).map(a => ACTION_LABELS[a]).join(' and ')}` : ''}`}
                    onClick={() => { setArmed({ action, index }); setMessage('Press a new key. Escape cancels.'); }}>
                    {listening ? 'Press a key…' : keyLabel(code)}
                  </motion.button>;
                })}</div>
              </div>;
            })}</motion.div>
            <p role="status" className="binding-message"><AnimatePresence mode="wait" initial={false}><motion.span key={message} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4, transition: LEAVE }} transition={ARRIVE}>{message}</motion.span></AnimatePresence></p>
            <motion.p className="muted-text" {...rowMotion}>Mouse: look around. Enter: join, resume, or start Cone Attack from its box. Restart waits for your accelerator or brake binding before starting the clock.</motion.p>
          </Rows>}
        </motion.section>
      </AnimatePresence>
    </div>
    <footer><span>Saved on this device</span><button className="text-button" onClick={() => { setArmed(undefined); setMessage('Defaults restored.'); game.setSettings(structuredClone(DEFAULT_SETTINGS)); game.setCamera(DEFAULT_SETTINGS.cameraMode); game.setSteeringStrength(1.5); game.setDriftStrength(1.2); }}>Restore defaults</button></footer>
  </div>;
}
