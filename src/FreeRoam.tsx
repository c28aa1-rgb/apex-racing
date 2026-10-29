import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useState, type ComponentProps, type CSSProperties, type ReactNode } from 'react';
import { assetUrl } from '../shared/assets';
import type { CarDefinition } from '../shared/cars';
import { CITY, HIGHWAY, TRAINING_GROUNDS, type Track } from '../shared/tracks';
import { HighwaySetup } from './HighwayPanels';

const ease = [.2, 0, 0, 1] as const;
type Destination = { track: Track; art: ReactNode; facts: [string, string][] };
const DESTINATIONS: Destination[] = [
  // Card art is rendered in the game itself (work/art capture): the night skyline from above the Founders Loop,
  // and the car park from its corner, so the cards show exactly what the player drives into.
  { track: CITY, facts: [['Districts', '5'], ['Traffic', 'Live'], ['Online', 'Up to 8']], art: <img src={assetUrl('art/free-roam-city.jpg')} alt="" /> },
  { track: HIGHWAY, facts: [['Length', 'Endless'], ['Lanes', '3 + 3'], ['Modes', '2']], art: <img src={assetUrl('art/free-roam-highway.jpg')} alt="" onError={event => { event.currentTarget.style.display = 'none'; }} /> },
  { track: TRAINING_GROUNDS, facts: [['Surface', 'Flat'], ['Cones', 'Yes'], ['Secret', '1']], art: <img src={assetUrl('art/free-roam-training.jpg')} alt="" /> },
];

/** Free-roam hub: the current car on the garage stage, and the untimed places to take it. */
export function FreeRoam({ car, modelReady, onDrive, onChangeCar, reduced, highway, openSetup = false, onSetupShown }: { car: CarDefinition; modelReady: boolean; onDrive: (track: Track) => void; onChangeCar: () => void; reduced: boolean; highway: ComponentProps<typeof HighwaySetup>; openSetup?: boolean; onSetupShown?: () => void }) {
  // The highway's card opens its setup (mode, traffic, time of day, weather) before driving off; so does the what's-new card.
  const [setup, setSetup] = useState(openSetup);
  useEffect(() => { if (openSetup) { setSetup(true); onSetupShown?.(); } }, [openSetup]);
  return <motion.main key="roam" className="garage roam" initial={{ opacity: 0, x: reduced ? 0 : 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: reduced ? 0 : 16, transition: { duration: reduced ? 0 : .18, ease: [.4, 0, 1, 1] } }} transition={{ duration: reduced ? 0 : .38, ease }}>
    <div className="garage-shade" aria-hidden="true" />
    <motion.aside className="roam-intro" initial={{ opacity: 0, x: reduced ? 0 : -14 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: reduced ? 0 : .34, delay: reduced ? 0 : .06, ease }}>
      <p>No clock · no limits</p><h1>Free<br />roam.</h1>
      <span className="roam-copy">Drift, explore and learn a car. Nothing here is timed or ranked, and every car is welcome.</span>
      <div className="roam-car"><small>Driving</small><strong>{car.name}</strong><button onClick={onChangeCar}>Change car</button></div>
      {/* The city's traffic and police cars are CC BY 4.0: credited here, where the city is entered. */}
      <a className="roam-credit" href={assetUrl('models/traffic/CREDITS.txt')} target="_blank" rel="noreferrer">City vehicle credits</a>{' · '}
      <a className="roam-credit" href={assetUrl('models/highway/CREDITS.txt')} target="_blank" rel="noreferrer">Highway scenery credits</a>
    </motion.aside>
    <AnimatePresence mode="wait" initial={false}>{setup ? <motion.section key="highway-setup" className="roam-destinations roam-setup" style={{ '--roam-accent': HIGHWAY.accent } as CSSProperties} aria-label="Endless Highway setup" initial={{ opacity: 0, x: reduced ? 0 : 18 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: reduced ? 0 : 12, transition: { duration: reduced ? 0 : .15 } }} transition={{ duration: reduced ? 0 : .28, ease }}>
      <header><button className="text-button" onClick={() => setSetup(false)}>← All destinations</button><small>{HIGHWAY.subtitle}</small><strong>{HIGHWAY.name}</strong></header>
      <HighwaySetup {...highway} />
      <button className="start-button" disabled={!modelReady} onClick={() => onDrive(HIGHWAY)}><span>{modelReady ? `Drive the ${car.shortName}` : 'Loading car…'}</span><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
    </motion.section> : <motion.section key="destinations" className="roam-destinations" aria-label="Choose where to drive" initial={{ opacity: 0, x: reduced ? 0 : 18 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: reduced ? 0 : 12, transition: { duration: reduced ? 0 : .15 } }} transition={{ duration: reduced ? 0 : .3, delay: reduced ? 0 : .1, ease }}>
      {DESTINATIONS.map(({ track, art, facts }) => <button key={track.id} className="roam-card" style={{ '--roam-accent': track.accent } as CSSProperties} disabled={!modelReady} onClick={() => track.id === HIGHWAY.id ? setSetup(true) : onDrive(track)}>
        <span className="roam-art">{art}</span>
        <span className="roam-body">
          <small>{track.subtitle}</small><strong>{track.name}</strong><span>{track.description}</span>
          <dl>{facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
          <b>{!modelReady ? 'Loading car…' : track.id === HIGHWAY.id ? 'Choose mode & traffic' : `Drive the ${car.shortName}`}<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg></b>
        </span>
      </button>)}
    </motion.section>}</AnimatePresence>
  </motion.main>;
}
