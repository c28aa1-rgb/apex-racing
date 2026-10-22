import { motion } from 'framer-motion';
import type { CSSProperties, ReactNode } from 'react';
import { assetUrl } from '../shared/assets';
import type { CarDefinition } from '../shared/cars';
import { CITY, TRAINING_GROUNDS, type Track } from '../shared/tracks';

const ease = [.2, 0, 0, 1] as const;
type Destination = { track: Track; art: ReactNode; facts: [string, string][] };
const DESTINATIONS: Destination[] = [
  { track: CITY, facts: [['Districts', '5'], ['Roads', '13'], ['Size', '3 km']], art: <svg className="roam-art-city" viewBox="0 0 320 120" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
    <path d="M0 96 Q80 70 160 88 T320 80 V120 H0Z" fill="#1e4152" />
    {[[18, 52, 26], [48, 30, 22], [74, 62, 18], [96, 18, 28], [128, 44, 20], [152, 8, 30], [186, 36, 24], [214, 56, 18], [236, 24, 26], [266, 48, 22], [292, 64, 24]].map(([x, y, w]) => <rect key={x} x={x} y={y} width={w} height={120 - y} fill={y < 30 ? '#7fd1ff' : '#3c6f86'} opacity={y < 30 ? .9 : .75} />)}
    <path d="M0 108 H320" stroke="#ff784c" strokeWidth="3" strokeDasharray="14 10" />
  </svg> },
  { track: TRAINING_GROUNDS, facts: [['Surface', 'Flat'], ['Cones', 'Yes'], ['Secret', '1']], art: <img src={assetUrl('art/training.png')} alt="" /> },
];

/** Free-roam hub: the current car on the garage stage, and the untimed places to take it. */
export function FreeRoam({ car, modelReady, onDrive, onChangeCar, reduced }: { car: CarDefinition; modelReady: boolean; onDrive: (track: Track) => void; onChangeCar: () => void; reduced: boolean }) {
  return <motion.main key="roam" className="garage roam" initial={{ opacity: 0, x: reduced ? 0 : 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: reduced ? 0 : 16, transition: { duration: reduced ? 0 : .18, ease: [.4, 0, 1, 1] } }} transition={{ duration: reduced ? 0 : .38, ease }}>
    <div className="garage-shade" aria-hidden="true" />
    <motion.aside className="roam-intro" initial={{ opacity: 0, x: reduced ? 0 : -14 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: reduced ? 0 : .34, delay: reduced ? 0 : .06, ease }}>
      <p>No clock · no limits</p><h1>Free<br />roam.</h1>
      <span className="roam-copy">Drift, explore and learn a car. Nothing here is timed or ranked, and every car is welcome.</span>
      <div className="roam-car"><small>Driving</small><strong>{car.name}</strong><button onClick={onChangeCar}>Change car</button></div>
    </motion.aside>
    <motion.section className="roam-destinations" aria-label="Choose where to drive" initial={{ opacity: 0, x: reduced ? 0 : 18 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: reduced ? 0 : .3, delay: reduced ? 0 : .1, ease }}>
      {DESTINATIONS.map(({ track, art, facts }) => <button key={track.id} className="roam-card" style={{ '--roam-accent': track.accent } as CSSProperties} disabled={!modelReady} onClick={() => onDrive(track)}>
        <span className="roam-art">{art}</span>
        <span className="roam-body">
          <small>{track.subtitle}</small><strong>{track.name}</strong><span>{track.description}</span>
          <dl>{facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
          <b>{modelReady ? `Drive the ${car.shortName}` : 'Loading car…'}<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg></b>
        </span>
      </button>)}
    </motion.section>
  </motion.main>;
}
