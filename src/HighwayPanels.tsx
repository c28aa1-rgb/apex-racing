import { motion } from 'framer-motion';
import { useSyncExternalStore } from 'react';
import { DENSITY_STEPS, SURVIVAL_END, SURVIVAL_START, survivalDensity, type HighwayMode, type HighwayTrafficSettings } from '../shared/highway-traffic';
import { formatTime } from '../shared/tracks';
import { clockLabel } from './city-time';
import type { Game, GameState } from './game';
import type { WeatherPreset } from './settings';

/** Distances on the highway read in miles, like the speedometer. */
const MILE = 1609.344, KPH_PER_MPH = 1.609344;
export const miles = (metres: number, digits = 1) => `${(metres / MILE).toFixed(digits)} mi`;
const ease = [.2, .8, .2, 1] as const;
const nearestStep = (density: number) => DENSITY_STEPS.reduce((best, step) => Math.abs(step.value - density) < Math.abs(best.value - density) ? step : best, DENSITY_STEPS[0]);
const WEATHERS: { value: WeatherPreset; label: string }[] = [{ value: 'clear', label: 'Clear' }, { value: 'rain', label: 'Rain' }, { value: 'fog', label: 'Fog' }, { value: 'snow', label: 'Snow' }];

type SetupProps = {
  setup: GameState['highwaySetup']; onSetup: (patch: { mode?: HighwayMode; traffic?: Partial<HighwayTrafficSettings> }) => void;
  time: GameState['cityTime']; onTime: (patch: Partial<GameState['cityTime']>) => void;
  weather: WeatherPreset; onWeather: (weather: WeatherPreset) => void;
  best: number;
};
/**
 * The highway's setup, on the Free roam card and in the pause menu: Cruise or Survival; Cruise's traffic (how much,
 * how fast); and, for either, the time of day and the weather.
 */
export function HighwaySetup({ setup, onSetup, time, onTime, weather, onWeather, best }: SetupProps) {
  const cruise = setup.mode === 'cruise', step = nearestStep(setup.traffic.density), mph = Math.round(setup.traffic.speedKph / KPH_PER_MPH);
  return <div className="highway-setup">
    <div className="highway-modes" role="radiogroup" aria-label="Mode">
      {(['cruise', 'survival'] as const).map(mode => <button key={mode} role="radio" aria-checked={setup.mode === mode} aria-label={mode === 'cruise' ? 'Cruise' : 'Survival'} className={setup.mode === mode ? 'active' : ''} onClick={() => onSetup({ mode })}>
        <strong>{mode === 'cruise' ? 'Cruise' : 'Survival'}</strong>
        <small>{mode === 'cruise' ? 'No end, no score. Set the traffic.' : 'Distance until you crash. Traffic builds.'}</small>
      </button>)}
    </div>
    {cruise ? <>
      <fieldset className="highway-field"><legend>Traffic</legend>
        <div className="highway-steps">{DENSITY_STEPS.map(option => <button key={option.label} className={option === step ? 'active' : ''} aria-pressed={option === step} onClick={() => onSetup({ traffic: { density: option.value } })}>{option.label}</button>)}</div>
      </fieldset>
      <label className="highway-field"><span>Traffic speed <b>{mph} mph</b></span>
        <input type="range" min="35" max="160" step="5" value={mph} disabled={setup.traffic.density === 0} aria-valuetext={`${mph} miles per hour`} onChange={event => onSetup({ traffic: { speedKph: +event.target.value * KPH_PER_MPH } })} />
      </label>
    </> : <p className="highway-rule">Keep above 40 mph and in the lanes: five seconds slower ends the run, and the shoulder does not count. A scrape off a rail or another car is fine; a hit that really slows you, a spin or a roll ends the run. {best > 0 ? <>Your best: <b>{miles(best)}</b>.</> : 'No run yet with this car.'}</p>}
    <label className="highway-field"><span>Time of day <b>{clockLabel(time.hour)}</b></span>
      <input type="range" min="0" max="23.75" step=".25" value={time.hour} aria-valuetext={clockLabel(time.hour)} onChange={event => onTime({ hour: +event.target.value })} />
    </label>
    <button className={`ghost-toggle highway-cycle ${time.cycle ? 'selected' : ''}`} aria-pressed={time.cycle} onClick={() => onTime({ cycle: !time.cycle })}><span>Clock runs (a day every 24 minutes)</span><span className="switch"><i /></span></button>
    <fieldset className="highway-field"><legend>Weather {weather === 'rain' || weather === 'snow' ? <small>· less grip</small> : null}</legend>
      <div className="highway-steps">{WEATHERS.map(option => <button key={option.value} className={option.value === weather ? 'active' : ''} aria-pressed={option.value === weather} onClick={() => onWeather(option.value)}>{option.label}</button>)}</div>
    </fieldset>
  </div>;
}

/** The highway readout at the top of the screen: distance this run, and Survival's best and traffic level or Cruise's traffic. */
export function HighwayHud({ game, state }: { game: Game; state: GameState }) {
  const distance = useSyncExternalStore(game.subscribe, () => game.snapshot().highwayDistance ?? 0);
  const shoulder = useSyncExternalStore(game.subscribe, () => !!game.snapshot().highwayShoulder);
  const slow = useSyncExternalStore(game.subscribe, () => game.snapshot().highwaySlow);
  const survival = state.highwaySetup.mode === 'survival' && game.sim.highway?.survival;
  const level = survival ? (survivalDensity(distance) - SURVIVAL_START) / (SURVIVAL_END - SURVIVAL_START) : 0;
  const best = state.highwayBest ?? 0;
  const warn = survival && slow !== undefined;
  return <div className={`highway-panel ${survival ? 'is-survival' : ''} ${shoulder || warn ? 'is-shoulder' : ''}`}>
    <span>{survival ? 'Survival' : 'Cruise'} · Endless Highway</span>
    <strong>{miles(distance, distance < 16093 ? 2 : 1)}</strong>
    {warn ? <b className="highway-shoulder" role="alert">Too slow · speed up past 40 mph · {slow} s</b> : survival && shoulder ? <b className="highway-shoulder" role="status">On the shoulder · not counting</b> : survival ? <div className="highway-level">
      <small>{best > 0 ? distance > best ? 'New best!' : `Best ${miles(best)}` : 'First run'}</small>
      <i aria-label={`Traffic ${Math.round(level * 100)}%`}><b style={{ transform: `scaleX(${Math.max(.04, level)})` }} /></i>
      <small>Traffic</small>
    </div> : <small>{state.highwaySetup.traffic.density === 0 ? 'Empty road' : `${nearestStep(state.highwaySetup.traffic.density).label} traffic · ${Math.round(state.highwaySetup.traffic.speedKph / KPH_PER_MPH)} mph`} · <kbd>Esc</kbd> to change</small>}
  </div>;
}

const REASONS: Record<NonNullable<GameState['highwayResult']>['reason'], string> = { impact: 'Hard impact', spin: 'Spun out', roll: 'Rolled over', slow: 'Too slow' };
/** Survival's end: the distance, how it ended, and the way back on (a new run, Cruise, or out). */
export function HighwayResult({ game, result, still, onLeave }: { game: Game; result: NonNullable<GameState['highwayResult']>; still: boolean; onLeave: () => void }) {
  return <motion.div className="overlay highway-result" key={result.at} initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { delay: still ? 0 : 1.1, duration: still ? 0 : .35 } }} exit={{ opacity: 0 }}>
    <motion.section className="result-card" initial={{ y: still ? 0 : 20, scale: still ? 1 : .97 }} animate={{ y: 0, scale: 1, transition: { delay: still ? 0 : 1.1, duration: still ? 0 : .4, ease } }}>
      <p className="result-eyebrow">Survival · {REASONS[result.reason]}</p>
      <h2>{result.newBest ? 'New best distance' : 'Run over'}</h2>
      <strong className="finish-time">{miles(result.distance, 2)}</strong>
      <p className="finish-detail">{formatTime(result.timeMs)}<span> / </span>top {Math.round(result.topSpeedKph / KPH_PER_MPH)} mph<span> / </span>{result.newBest ? result.previousBest > 0 ? `${miles(result.distance - result.previousBest, 2)} further than before` : 'First run with this car' : `Best ${miles(result.previousBest)}`}</p>
      <div className="result-actions">
        <button className="start-button" onClick={() => game.restart()}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="M3 10a9 9 0 1 1 1 8M3 4v6h6" /></svg>Try again<kbd>{game.keyHint('restart')}</kbd></button>
        <button className="secondary-button" onClick={() => game.setHighwaySetup({ mode: 'cruise' })}>Switch to Cruise</button>
      </div>
      <button className="text-button" onClick={onLeave}>Leave the highway</button>
    </motion.section>
  </motion.div>;
}
