import { assetUrl } from '../shared/assets';
import { MULTIPLAYER_BACKEND } from './multiplayer-config';
import { PartyError, partyEvents } from './cloudflare-party';
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, type Variants } from 'framer-motion';

// Paddock entrance: the page settles in, then heading, lineup and settings arrive in a short cascade.
const SPRING = { type: 'spring', stiffness: 380, damping: 34, mass: .9 } as const;
const pageMotion: Variants = { hidden: { opacity: 0 }, shown: { opacity: 1, transition: { duration: .2, staggerChildren: .07, delayChildren: .04 } }, exit: { opacity: 0, scale: .985, transition: { duration: .2, ease: [.4, 0, 1, 1] } } };
const fromAbove: Variants = { hidden: { opacity: 0, y: -14 }, shown: { opacity: 1, y: 0, transition: SPRING } };
const settle: Variants = { hidden: { opacity: 0, scale: .965 }, shown: { opacity: 1, scale: 1, transition: { ...SPRING, stiffness: 260 } } };
const fromRight: Variants = { hidden: { opacity: 0, x: 32 }, shown: { opacity: 1, x: 0, transition: SPRING } };
const fade: Variants = { hidden: { opacity: 0 }, shown: { opacity: 1, transition: { duration: .3 } } };
const still: Variants = { hidden: { opacity: 0 }, shown: { opacity: 1, transition: { duration: 0 } }, exit: { opacity: 0, transition: { duration: 0 } } };
import { ArrowRight, Check, Copy, Crown, DoorOpen, Eye, Flag, Hash, ListOrdered, Minus, Plus, Sun, CloudRain, Snowflake, CloudFog, UsersRound, Wifi, WifiOff, X } from 'lucide-react';
import { CARS, DEFAULT_CAR, carById } from '../shared/cars';
import { CITY, CITY_RACES, HIGHWAY, TRACKS, formatTime } from '../shared/tracks';
import { DEFAULT_HIGHWAY_TRAFFIC, DENSITY_STEPS } from '../shared/highway-traffic';
import { DEFAULT_PARTY_SETTINGS, HIGHWAY_PARTY_TRACK, PARTY_WEATHER, isHighwayParty, isRoamParty, type PartyWeather, type PartyRace, type PartyTrafficPacket } from '../shared/party';
import { Game } from './game';
import { api, dressedCar, write, type Player } from './storage';
import { PartyStage } from './PartyStage';
import { useParty, requestParty } from './use-party';
import { PartyUpdates, POSE_INTERVAL_MS } from './party-network';
import './party.css';

const weatherIcons = { clear: Sun, rain: CloudRain, snow: Snowflake, fog: CloudFog };
const weatherNames: Record<PartyWeather, string> = { clear: 'Clear', rain: 'Rain', snow: 'Snow', fog: 'Fog' };

function Laps({ value, disabled, onChange }: { value: number; disabled: boolean; onChange: (laps: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const next = Number(draft);
    if (!Number.isInteger(next) || next < 1 || next > 99) { setDraft(String(value)); return; }
    if (next !== value) onChange(next);
  };
  return <div className="party-stepper">
    <button type="button" aria-label="Fewer laps" title="Fewer laps" disabled={disabled || value <= 1} onClick={() => onChange(value - 1)}><Minus size={16}/></button>
    <input id="party-laps" aria-label="Laps" type="number" min={1} max={99} value={draft} disabled={disabled} onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }}/>
    <button type="button" aria-label="More laps" title="More laps" disabled={disabled || value >= 99} onClick={() => onChange(value + 1)}><Plus size={16}/></button>
  </div>;
}

const ordinal = (n: number) => n % 10 === 1 && n % 100 !== 11 ? `${n}st` : n % 10 === 2 && n % 100 !== 12 ? `${n}nd` : n % 10 === 3 && n % 100 !== 13 ? `${n}rd` : `${n}th`;
type Racer = PartyRace['racers'][number];
/**
 * The party end screen: every driver in finishing order with their car, total time, gap to the winner and best lap.
 * Before everyone is home it is provisional, with the drivers still racing shown on their current lap.
 */
function PartyResults({ race, racers, selfId, bestLap, laps, host, hostName, busy, reduced, onClose, onLobby, onLeave }: {
  race: PartyRace; racers: Racer[]; selfId?: string; bestLap: (racer: Racer) => number | undefined; laps: number;
  host: boolean; hostName?: string; busy: boolean; reduced: boolean; onClose: () => void; onLobby: () => void; onLeave: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const node = dialog.current!; node.showModal(); return () => { if (node.open) node.close(); }; }, []);
  const time = (racer: Racer) => racer.finishedAt !== undefined ? racer.finishedAt - race.startAt! : undefined;
  const winner = racers.map(time).find(t => t !== undefined), fastest = Math.min(...racers.map(r => bestLap(r) ?? Infinity));
  const mine = racers.find(r => r.id === selfId), myPlace = mine && time(mine) !== undefined ? racers.indexOf(mine) + 1 : undefined;
  return <motion.dialog ref={dialog} className="party-results" aria-label="Race standings" onCancel={event => { event.preventDefault(); onClose(); }} initial={{ opacity: 0, y: reduced ? 0 : 12, scale: reduced ? 1 : .99 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: reduced ? 0 : .24, ease: [.2, 0, 0, 1] }}>
    <header><div><span>{race.ended ? 'Final standings' : 'Live standings'} · {laps} {laps === 1 ? 'lap' : 'laps'}</span><h2>{myPlace ? `You finished ${ordinal(myPlace)}` : race.ended ? 'Race over' : 'Race in progress'}</h2></div><button className="icon-button" aria-label="Close standings" title="Close standings" onClick={onClose}><X size={20}/></button></header>
    <ol>{racers.map((racer, i) => {
      const total = time(racer), best = bestLap(racer), dnf = total === undefined && (racer.disconnected || race.ended);
      const car = racer.id === selfId ? dressedCar(racer.carId) : carById(racer.carId);
      return <li key={racer.id} className={racer.id === selfId ? 'is-you' : ''}>
        <b>{dnf ? 'DNF' : total === undefined ? '–' : i + 1}</b>
        <div><strong>{racer.nickname}{racer.id === selfId && <small> you</small>}</strong><span>{car.shortName}</span></div>
        <div className="party-results-time">{total !== undefined ? <><strong>{formatTime(total)}</strong><span>{total === winner ? 'Winner' : `+${((total - winner!) / 1000).toFixed(3)}`}</span></> : dnf ? <strong className="is-out">Did not finish</strong> : <><strong className="is-out">Racing</strong><span>Lap {racer.pose?.lap ?? 1} / {laps}</span></>}</div>
        <div className="party-results-best">{best ? <><span className={best === fastest ? 'fastest' : ''}>{best === fastest ? 'Fastest lap' : 'Best lap'}</span><strong>{formatTime(best)}</strong></> : null}</div>
      </li>;
    })}</ol>
    <footer>
      {host ? <button className="party-results-primary" disabled={busy} onClick={onLobby}><Flag size={17}/>Back to lobby</button> : <p>{race.ended ? `Waiting for ${hostName ?? 'the host'} to reopen the lobby` : 'The order is final once everyone finishes'}</p>}
      <button onClick={onClose}><Eye size={17}/>{race.ended ? 'Back to track' : 'Watch the race'}</button>
      <button disabled={busy} onClick={onLeave}><DoorOpen size={17}/>Leave race</button>
    </footer>
  </motion.dialog>;
}

const validName = (name: string) => /^[\p{L}\p{N} _-]{2,18}$/u.test(name.trim());
/** The first time into the public city without a driver name: everyone there sees it over your car. */
function CityName({ initial, busy, error, reduced, onDrive, onCancel }: { initial: string; busy: boolean; error: string; reduced: boolean; onDrive: (name: string) => void; onCancel: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), [name, setName] = useState(initial);
  useEffect(() => { const node = dialog.current!; node.showModal(); return () => { if (node.open) node.close(); }; }, []);
  return <motion.dialog ref={dialog} className="city-name" aria-labelledby="city-name-heading" onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}
    initial={{ opacity: 0, y: reduced ? 0 : 12, scale: reduced ? 1 : .99 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: reduced ? 0 : .24, ease: [.2, 0, 0, 1] }}>
    <form onSubmit={event => { event.preventDefault(); if (validName(name) && !busy) onDrive(name.trim()); }}>
      <span>Racing City · online</span>
      <h2 id="city-name-heading">Pick a driver name</h2>
      <p>Everyone driving the city is in it with you, and sees this name over your car.</p>
      <label htmlFor="city-name-input">Driver name</label>
      <input id="city-name-input" autoFocus autoComplete="nickname" placeholder="Your name" minLength={2} maxLength={18} value={name} onChange={event => setName(event.target.value)} aria-describedby="city-name-hint"/>
      <small id="city-name-hint">2–18 letters, numbers, spaces, _ or -</small>
      {error && <p className="city-name-error" role="alert">{error}</p>}
      <footer><button type="submit" className="party-primary" disabled={busy || !validName(name)}><ArrowRight size={18}/>{busy ? 'Joining the city…' : 'Drive into the city'}</button><button type="button" disabled={busy} onClick={onCancel}>Cancel</button></footer>
    </form>
  </motion.dialog>;
}

export function PartyPanel({ game, active, player, onPlayer, reduced, cityRequest, onCitySolo }: {
  game: Game; active: boolean; player: Player | null; onPlayer: (player: Player) => void; reduced: boolean;
  /** Counts up each time Free roam asks for the city: into the public city (asking for a name first if need be). */
  cityRequest: number;
  /** The city on your own instead (in a private lobby, or the public city out of reach), and why. */
  onCitySolo: (notice: string) => void;
}) {
  const party = useParty(player, active), { lobby } = party;
  const [nickname, setNickname] = useState(player?.nickname ?? '');
  const [code, setCode] = useState(''), [identityBusy, setIdentityBusy] = useState(false), [identityError, setIdentityError] = useState('');
  const [copied, setCopied] = useState(false), [copyError, setCopyError] = useState('');
  const [raceState, setRaceState] = useState<PartyRace>(), [raceError, setRaceError] = useState('');
  useEffect(() => { if (player) setNickname(player.nickname); }, [player?.nickname]);
  useEffect(() => { game.leaveParty = () => void party.leave(); return () => { game.leaveParty = undefined; }; });
  /** This driver's identity under this name: renamed if they have one, issued if not (or it expired). */
  const identify = async (name: string, current = player) => {
    let identity = current;
    if (identity) {
      try { identity = { ...identity, ...await api<Pick<Player, 'id' | 'nickname'>>('/players/me', { nickname: name }, 'PUT') }; }
      catch (cause) { if (cause instanceof Error && cause.message.includes('expired')) identity = null; else throw cause; }
    }
    if (!identity) identity = await api<Player>('/players', { nickname: name });
    write('player', identity); onPlayer(identity);
    return identity;
  };
  const [askName, setAskName] = useState(false), [cityBusy, setCityBusy] = useState(false), [cityError, setCityError] = useState('');
  const enterCity = async (identity: Player, retried = false): Promise<void> => {
    if (lobby && !lobby.public) { onCitySolo('You are in a party lobby, so this city is just yours. Leave the lobby in Party to drive with everyone.'); return; }
    try { await party.joinCity(identity, game.state.car.id); }
    catch (cause) {
      if (cause instanceof PartyError && cause.status === 401 && !retried) return enterCity(await identify(identity.nickname, null), true);
      onCitySolo(cause instanceof PartyError && cause.status === 409 ? 'You are in a party lobby, so this city is just yours. Leave the lobby in Party to drive with everyone.' : 'The online city is out of reach right now, so you are driving it alone.');
    }
  };
  useEffect(() => {
    if (!cityRequest) return;
    if (!player) { setCityError(''); setAskName(true); return; }
    setCityBusy(true); void enterCity(player).finally(() => setCityBusy(false));
  }, [cityRequest]);
  const nameAndDrive = async (name: string) => {
    setCityBusy(true); setCityError('');
    try { const identity = await identify(name, null); setAskName(false); await enterCity(identity); }
    catch (cause) { setCityError(cause instanceof Error ? cause.message : 'Could not save your driver name. Try again.'); }
    finally { setCityBusy(false); }
  };
  const namePrompt = askName && <CityName initial={nickname} busy={cityBusy} error={cityError} reduced={reduced} onDrive={name => void nameAndDrive(name)} onCancel={() => setAskName(false)}/>;
  useEffect(() => {
    game.partyView = active && !lobby?.race;
    return () => { game.partyView = false; };
  }, [active, game, lobby?.race?.id]);
  useEffect(() => {
    if (!lobby?.race || !player) { setRaceState(undefined); return; }
    let disposed = false, ready = false, newestServerNow = -Infinity;
    setRaceState(lobby.race); setRaceError('');
    void game.prepareParty(lobby, player.id).then(() => { ready = true; }).catch(cause => { if (!disposed) setRaceError(cause instanceof Error ? cause.message : 'Race assets failed to load.'); });
    const accept = (race: PartyRace, serverNow: number) => {
      if (disposed || race.id !== lobby.race!.id || serverNow < newestServerNow) return;
      newestServerNow = serverNow;
      game.syncParty(race, serverNow); setRaceState(race);
    };
    const updates = new PartyUpdates({
      ready: () => ready,
      interval: () => game.partyPoseInterval(),
      send: () => { const traffic = game.partyTrafficOut(); return requestParty<{race: PartyRace; serverNow: number; traffic?: PartyTrafficPacket}>('/race', player.token, 'POST', { raceId: lobby.race!.id, ready, ...(ready ? { pose: game.partyPose() } : {}), ...(traffic ? { traffic } : {}), ...(lobby.public ? { away: game.partyIsAway } : {}) }); },
      receive: (result, sent, received) => { game.noteServerClock(result.serverNow, sent, received); accept(result.race, result.serverNow); game.partyTraffic(result.traffic); if (ready) setRaceError(''); },
      error: cause => setRaceError(cause instanceof Error ? cause.message : 'Race connection interrupted.'),
    });
    game.partyNetwork = () => updates.diagnostics();
    const receive = (event: Event) => {
      const packet = (event as CustomEvent).detail as { race: PartyRace; serverNow: number };
      accept(packet.race, packet.serverNow);
    };
    if (MULTIPLAYER_BACKEND === 'cloudflare') partyEvents.addEventListener('race', receive);
    updates.tick(); const timer = setInterval(() => updates.tick(), Math.ceil(POSE_INTERVAL_MS));
    return () => { disposed = true; updates.stop(); clearInterval(timer); game.partyNetwork = undefined; partyEvents.removeEventListener('race', receive); game.endParty(); };
  }, [lobby?.race?.id, player?.token, game]);
  // Results: shown once the finish callout has cleared, final or (while others still race) provisional.
  // You can close provisional results to spectate; they come back for the final order.
  const finishedHere = game.state.mode === 'party-finished';
  const [resultsDue, setResultsDue] = useState(false), [resultsClosed, setResultsClosed] = useState(false);
  const standingsButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (resultsClosed) standingsButton.current?.focus(); }, [resultsClosed]);
  useEffect(() => { if (!finishedHere) { setResultsDue(false); return; } const timer = setTimeout(() => setResultsDue(true), 4800); return () => clearTimeout(timer); }, [finishedHere]);
  useEffect(() => setResultsClosed(false), [lobby?.race?.id, raceState?.ended]);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 2000); return () => clearTimeout(timer); }, [copied]);
  // Keep the presence wrapper mounted so the paddock can animate out when you leave it.
  if (!active && !lobby?.race) return <>{namePrompt}<AnimatePresence /></>;

  const busy = party.busy || identityBusy || party.checking;
  const host = lobby?.hostId === player?.id;
  const settings = lobby?.settings ?? DEFAULT_PARTY_SETTINGS;
  // city: free roam together, in Racing City or (highway) on the Endless Highway.
  const highway = isHighwayParty(settings), city = isRoamParty(settings), street = CITY_RACES.find(race => race.id === settings.trackId);
  const track = highway ? HIGHWAY : city ? CITY : street ?? TRACKS.find(track => track.id === settings.trackId)!;
  const art = highway ? 'art/free-roam-highway.jpg' : city || street ? 'art/free-roam-city.jpg' : `art/${track.id}.png`;
  // The highway's traffic, as the host set it (Cruise's medium traffic until they change it).
  const traffic = { ...DEFAULT_HIGHWAY_TRAFFIC, ...settings.traffic }, trafficMph = Math.round(traffic.speedKph / 1.609344);
  const trafficStep = DENSITY_STEPS.reduce((best, step) => Math.abs(step.value - traffic.density) < Math.abs(best.value - traffic.density) ? step : best, DENSITY_STEPS[0]);
  /** A street race's own shape: its laps (built in) and length. */
  /** A street race's own lap, from the gates passed (its gates go round all its laps). */
  const streetLap = (checkpoint: number) => street ? Math.min(street.street!.laps, Math.floor(checkpoint * street.street!.laps / (street.checkpoints.length + 1)) + 1) : 1;
  const streetFacts = street && <span>{street.street!.laps > 1 ? `${street.street!.laps} laps` : 'Sprint'}<i>/</i>{(street.length / 1609.344).toFixed(1)} mi<i>/</i>Police roadblocks</span>;
  const me = lobby?.members.find(member => member.id === player?.id);
  const selectedCar = carById(me?.carId ?? game.state.car.id);
  // Party grids use the same garage ownership as time trials; a locked garage preview joins in the starter car.
  const joinCar = selectedCar;
  const hostName = lobby?.members.find(member => member.id === lobby.hostId)?.nickname;
  const error = identityError || party.error;
  const validNickname = validName(nickname);
  const connect = async (join: boolean) => {
    if (!validNickname || busy) return;
    setIdentityBusy(true); setIdentityError(''); party.clearError();
    try {
      const identity = await identify(nickname);
      if (join) await party.join(identity, joinCar.id, code);
      // A lobby starts on the circuit (or the city) you are on; anywhere else (a street race, the car park) on the default.
      else await party.create(identity, joinCar.id, { trackId: game.state.track.id === CITY.id || game.state.track.id === HIGHWAY.id || TRACKS.some(t => t.id === game.state.track.id) ? game.state.track.id : DEFAULT_PARTY_SETTINGS.trackId, weather: game.settings.weather });
    } catch (cause) { setIdentityError(cause instanceof Error ? cause.message : 'Could not save your driver name. Try again.'); }
    finally { setIdentityBusy(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(lobby!.code); setCopied(true); setCopyError(''); }
    catch { setCopyError('Select the lobby code above to copy it.'); }
  };

  if (lobby?.race && raceState) {
    const racers = game.partyStandings(raceState);
    const bestLap = (racer: PartyRace['racers'][number]) => racer.id === player?.id ? game.partyBestLap ?? racer.pose?.best : racer.pose?.best;
    const fastest = Math.min(...racers.map(r => bestLap(r) ?? Infinity));
    const loading = !raceState.ended && !(game.partyRace?.ready && raceState.startAt);
    const ready = raceState.racers.filter(r => r.ready && !r.disconnected).length, total = raceState.racers.filter(r => !r.disconnected).length;
    const step = !game.partyRace ? 'Finding your lobby' : game.partyLoadStep || (!raceState.startAt ? `Waiting for drivers · ${ready} / ${total} ready` : 'Starting');
    const spectating = game.state.mode === 'party-finished';
    const watchable = spectating ? game.spectateCandidates() : [];
    const watchedName = raceState.racers.find(r => r.id === game.spectating)?.nickname;
    const field = racers.filter(r => !r.disconnected).length, place = racers.findIndex(r => r.id === player?.id) + 1;
    const showResults = !!raceState.startAt && resultsDue && !resultsClosed;
    const openResults = () => { setResultsDue(true); setResultsClosed(false); };
    // Racing a street race away from the public city: the race's own screen, nothing from the party.
    if (city && game.partyIsAway) return null;
    if (loading) return <section className="party-loading" role="status" aria-live="polite" aria-label="Joining race">
      <img src={assetUrl(art)} alt=""/>
      <div className="party-loading-card">
        <span className="party-loading-kicker">{lobby.public ? 'Racing City · online with everyone' : highway ? 'Highway party · free roam together' : city ? 'City party · free roam together' : street ? `Street race · ${street.street!.laps > 1 ? `${street.street!.laps} laps` : 'sprint'} · Racing City` : `Party race · ${settings.laps} ${settings.laps === 1 ? 'lap' : 'laps'} · ${weatherNames[settings.weather]}`}</span>
        <h2>{track.name}</h2>
        <div className="party-loading-step">{!(raceError || error) && <span className="party-loading-spinner" aria-hidden="true"/>}<strong>{raceError || error || step}</strong></div>
        <ul className="party-loading-drivers">{raceState.racers.map(r => <li key={r.id} className={r.ready ? 'is-ready' : ''}><span>{r.nickname}{r.id === player?.id ? ' (you)' : ''}</span><small>{r.disconnected ? 'Left' : r.ready ? 'Ready' : 'Loading…'}</small></li>)}</ul>
        <div className="party-race-actions">{host && !lobby.public && <button className="party-leave" disabled={busy} onClick={() => void party.reopen()}><Flag size={17}/>{city ? 'End session' : 'Cancel race'}</button>}<button className="party-leave" disabled={busy} onClick={() => void party.leave()}><DoorOpen size={17}/>{city ? 'Leave' : 'Leave race'}</button></div>
      </div>
    </section>;
    // A city party: who is in the city, and the way back out.
    if (city) return <section className="party-race party-city" aria-label={lobby.public ? 'Online city' : highway ? 'Highway party' : 'City party'}>
      <div className="party-race-status"><strong>{lobby.public ? 'Racing City · online' : highway ? 'Highway party' : 'City party'}</strong><span>{(n => highway ? (n > 1 ? `${n} on the highway · traffic ${trafficStep.label.toLowerCase()}` : 'Just you so far · friends can join with the code') : lobby.public ? (n > 1 ? `${n} drivers in the city` : 'Just you for now · anyone driving the city joins you') : n > 1 ? `${n} in the city · traffic shared` : 'Just you so far · friends can join with the code')(raceState.racers.filter(r => !r.disconnected).length)}</span></div>
      <ol className="party-race-order">{raceState.racers.filter(r => !r.disconnected).map(racer => <li key={racer.id} className={racer.id === player?.id ? 'is-you' : ''}>
        <b className="party-place">{racer.id === lobby.hostId && !lobby.public ? <Crown size={13}/> : '·'}</b><span>{racer.nickname}{racer.id === player?.id ? ' (you)' : ''}</span>
        <strong>{racer.away ? 'Street race' : !racer.ready ? 'Joining' : highway && racer.pose?.s !== undefined ? `${(racer.pose.s / 1609.344).toFixed(1)} mi` : 'Driving'}</strong>
      </li>)}
        {lobby.public && <li className="party-city-private" role="note">Want the city to yourselves? Make a private lobby in Party.</li>}
      </ol>
      {(raceError || error) && <p className="party-race-error" role="alert">{raceError || error}</p>}
      <div className="party-race-actions">{host && !lobby.public && <button className="party-leave" disabled={busy} onClick={() => void party.reopen()}><Flag size={17}/>Back to lobby</button>}<button className="party-leave" disabled={busy} onClick={() => void party.leave()}><DoorOpen size={17}/>{lobby.public ? 'Leave the city' : 'Leave'}</button></div>
    </section>;
    return <section className={`party-race ${showResults ? 'shows-results' : ''}`} aria-label="Party race">
      {showResults && <PartyResults race={raceState} racers={racers} selfId={player?.id} bestLap={bestLap} laps={street ? street.street!.laps : settings.laps}
        host={host} hostName={hostName} busy={busy} reduced={reduced} onClose={() => setResultsClosed(true)}
        onLobby={() => void party.reopen()} onLeave={() => void party.leave()}/>}
      {spectating && <div className="party-spectate" role="group" aria-label="Spectator camera" data-watching={watchedName ? "true" : undefined}>
        <span>{watchedName ? 'Watching' : 'Camera'}<strong>{watchedName ?? 'Your car'}</strong></span>
        {watchable.length > 0 && <><button onClick={() => game.spectate(-1)} aria-label="Previous driver">‹</button>
        <button onClick={() => game.spectate(1)} aria-label="Next driver">›</button></>}
        {watchedName && <button onClick={() => game.spectate(0)}>Your car</button>}
        <button ref={standingsButton} onClick={openResults}><ListOrdered size={14}/> Standings</button>
        {!watchable.length && <small>Everyone has finished</small>}
      </div>}
      <div className="party-race-status">{raceState.startAt && place > 0 && !raceState.racers.find(r => r.id === player?.id)?.disconnected && <b className="party-position" aria-label={`Position ${place} of ${field}`}>P{place}<small>/{field}</small></b>}
        <div><strong>{raceState.ended ? 'Race results' : !game.partyRace?.ready ? 'Preparing grid' : !raceState.startAt ? 'Waiting for drivers' : game.partyRace.finished ? 'Finished' : street ? `Lap ${streetLap(game.sim.checkpoint)} / ${street.street!.laps}` : `Lap ${game.partyRace.lap} / ${settings.laps}`}</strong><span>{track.name} · {street ? 'Night' : weatherNames[settings.weather]}</span></div></div>
      <ol className="party-race-order">{racers.map((racer, i) => {
        const best = bestLap(racer), finished = !!racer.finishedAt || raceState.ended;
        return <li key={racer.id} className={racer.id === player?.id ? 'is-you' : ''}>
          <b className="party-place">{racer.disconnected ? '–' : `P${i + 1}`}</b><span>{racer.nickname}</span>
          <strong>{racer.disconnected ? 'DNF' : racer.finishedAt ? formatTime(racer.finishedAt - raceState.startAt!) : !racer.ready ? 'Loading' : !raceState.startAt ? 'Ready' : `Lap ${street ? streetLap(racer.id === player?.id ? game.sim.checkpoint : racer.pose?.checkpoint ?? 0) : racer.id === player?.id ? game.partyRace?.lap ?? 1 : racer.pose?.lap ?? 1}`}</strong>
          {finished && best && <small className={best === fastest ? 'party-best fastest' : 'party-best'}>{best === fastest ? 'Fastest lap ' : 'Best lap '}{formatTime(best)}</small>}
        </li>;
      })}</ol>
      {(raceError || error) && <p className="party-race-error" role="alert">{raceError || error}</p>}
      <div className="party-race-actions">{host && <button className="party-leave" disabled={busy} onClick={() => void party.reopen()}><Flag size={17}/>{raceState.ended ? 'Back to lobby' : 'Cancel race'}</button>}<button className="party-leave" disabled={busy} onClick={() => void party.leave()}><DoorOpen size={17}/>Leave race</button></div>
    </section>;
  }

  return <AnimatePresence>{active && <motion.main key="party-paddock" className={`party ${lobby ? 'has-lobby' : 'party-entrance'}`} variants={reduced ? still : pageMotion} initial="hidden" animate="shown" exit="exit">
    <motion.header className="party-heading" variants={reduced ? still : fromAbove}>
      <div><h1>{lobby ? 'Your lobby' : 'Party'}</h1><p>{lobby ? `${hostName}'s grid` : 'Private paddock'}</p></div>
      {lobby ? <div className="party-invite"><span>Lobby code</span><strong data-testid="party-code">{lobby.code}</strong><button className="party-icon" onClick={() => void copy()} aria-label={copied ? 'Code copied' : 'Copy lobby code'} title={copied ? 'Code copied' : 'Copy lobby code'}>{copied ? <Check size={19}/> : <Copy size={19}/>}</button></div> : <div className="party-heading-mark"><UsersRound size={20}/><span>Up to 8 drivers</span></div>}
      {lobby && <button className="party-leave" onClick={() => void party.leave()} disabled={busy}><DoorOpen size={17}/><span>Leave lobby</span></button>}
    </motion.header>
    {copyError && <p className="party-feedback" role="status">{copyError}</p>}
    {error && <div className="party-feedback party-error" role="alert">{error}<button onClick={() => { setIdentityError(''); party.clearError(); }}>Dismiss</button></div>}
    {lobby && !party.connected && <p className="party-feedback" role="status"><WifiOff size={16}/> Connection interrupted. Reconnecting to your lobby...</p>}

    <div className="party-layout">
      <motion.section className="party-paddock" aria-label="Party lineup" variants={reduced ? still : settle}>
        <div className="party-lineup-heading"><h2>Lineup <span>{lobby?.members.length ?? 1}<i>/</i>{lobby?.settings.maxPlayers ?? 8}</span></h2><span className={`party-connection ${party.connected ? '' : 'offline'}`}>{lobby ? <><Wifi size={13}/>{party.connected ? 'Connected' : 'Reconnecting'}</> : 'Your starting place'}</span></div>
        <PartyStage world={game.world} members={lobby?.members ?? [{ id: 'preview', nickname: nickname.trim() || 'Your driver', carId: joinCar.id }]} capacity={lobby?.settings.maxPlayers ?? 4} hostId={lobby?.hostId} selfId={player?.id ?? 'preview'} reduced={reduced} entrance={!lobby}
          onKick={host && !busy && party.connected ? member => { if (confirm(`Remove ${member.nickname} from the lobby? They will not be able to rejoin it.`)) void party.kick(member.id); } : undefined}/>
      </motion.section>

      {lobby ? <motion.aside className="party-setup" aria-label="Shared race settings" variants={reduced ? still : fromRight}>
        <div className="party-your-car">
          <div><label htmlFor="party-car">Your car</label><span>{player?.nickname}</span></div>
          <select id="party-car" value={me?.carId ?? selectedCar.id} disabled={busy || !party.connected} onChange={event => void party.chooseCar(carById(event.target.value).id)}>{CARS.map(car => <option key={car.id} value={car.id}>{dressedCar(car.id).name}</option>)}</select>
          <span className="party-car-drive">{selectedCar.physics.drivetrain}</span>
        </div>
        <div className="party-section-title"><h2>Race setup</h2><span><Crown size={14}/>{host ? 'You are host' : `${hostName} hosts`}</span></div>
        <div className="party-track-art"><img src={assetUrl(art)} alt={highway ? 'The Endless Highway' : city ? 'Racing City' : `${track.name} circuit map`}/><span>{city ? 'Free roam together' : street ? `Racing City · ${track.subtitle}` : track.subtitle}</span></div>
        <label className="party-field"><span>Circuit</span>{host ? <select aria-label="Circuit" value={settings.trackId} disabled={busy || !party.connected} onChange={event => void party.configure({ trackId: event.target.value })}><optgroup label="Circuits">{TRACKS.map(track => <option key={track.id} value={track.id}>{track.name}</option>)}</optgroup><optgroup label="Racing City">{CITY_RACES.map(race => <option key={race.id} value={race.id}>{race.name} · street race</option>)}<option value={CITY.id}>Private city · free roam</option></optgroup><optgroup label="Endless Highway"><option value={HIGHWAY_PARTY_TRACK}>Endless Highway · free roam</option></optgroup></select> : <strong data-testid="party-track">{highway ? 'Endless Highway · free roam' : city ? 'Racing City · free roam' : street ? `${track.name} · street race` : track.name}</strong>}</label>
        {(!city || highway) && !street && <><fieldset className="party-weather" disabled={!host || busy || !party.connected}><legend>Weather</legend><div>{PARTY_WEATHER.map(weather => {
          const WeatherIcon = weatherIcons[weather];
          return <label key={weather} title={weatherNames[weather]} className={settings.weather === weather ? 'selected' : ''}><input type="radio" aria-label={weatherNames[weather]} name="party-weather" value={weather} checked={settings.weather === weather} onChange={() => void party.configure({ weather })}/><WeatherIcon size={20}/><span>{weatherNames[weather]}</span></label>;
        })}</div></fieldset>
        {highway ? <>
          <div className="party-setting-row"><label htmlFor="party-traffic">Traffic</label>{host ? <select id="party-traffic" value={trafficStep.value} disabled={busy || !party.connected} onChange={event => void party.configure({ traffic: { ...traffic, density: Number(event.target.value) } })}>{DENSITY_STEPS.map(step => <option key={step.label} value={step.value}>{step.label}</option>)}</select> : <strong data-testid="party-traffic">{trafficStep.label}</strong>}</div>
          <div className="party-setting-row"><label htmlFor="party-traffic-speed">Traffic speed</label>{host ? <select id="party-traffic-speed" value={Math.round(trafficMph / 5) * 5} disabled={busy || !party.connected || traffic.density === 0} onChange={event => void party.configure({ traffic: { ...traffic, speedKph: Number(event.target.value) * 1.609344 } })}>{Array.from({ length: 26 }, (_, i) => 35 + i * 5).map(mph => <option key={mph} value={mph}>{mph} mph</option>)}</select> : <strong>{trafficMph} mph</strong>}</div>
        </> : <div className="party-setting-row"><label htmlFor="party-laps">Laps</label>{host ? <Laps value={settings.laps} disabled={busy || !party.connected} onChange={laps => void party.configure({ laps })}/> : <strong data-testid="party-laps">{settings.laps}</strong>}</div>}</>}
        <div className="party-setting-row"><label htmlFor="party-capacity">Player limit</label>{host ? <select id="party-capacity" value={settings.maxPlayers} disabled={busy || !party.connected} onChange={event => void party.configure({ maxPlayers: Number(event.target.value) })}>{[2,3,4,5,6,7,8].map(n => <option key={n} value={n} disabled={n < lobby.members.length}>{n} drivers</option>)}</select> : <strong>{settings.maxPlayers} drivers</strong>}</div>
        <div className="party-session-summary" aria-live="polite"><Flag size={17}/>{highway ? <span>Desert highway<i>/</i>{traffic.density === 0 ? 'No traffic' : `${trafficStep.label} traffic · ${trafficMph} mph`}<i>/</i>Friends can join any time</span> : city ? <span>Night city<i>/</i>Shared traffic<i>/</i>Friends can join any time</span> : streetFacts ? streetFacts : <span>{settings.laps} {settings.laps === 1 ? 'lap' : 'laps'}<i>/</i>{weatherNames[settings.weather]}<i>/</i>{(track.length * settings.laps / 1609.344).toFixed(1)} mi</span>}</div>
        {host ? <button className="party-primary" disabled={busy || !party.connected} onClick={() => void party.start()}><Flag size={18}/>{city ? 'Drive together' : 'Start race'}</button> : <p className="party-lobby-status">Waiting for host<span>{lobby.members.length} of {settings.maxPlayers} places filled</span></p>}
      </motion.aside> : <motion.aside className="party-entry" aria-label="Create or join a lobby" variants={reduced ? still : fromRight}>
        <label className="party-field" htmlFor="party-nickname"><span>Driver name</span><input id="party-nickname" autoComplete="nickname" placeholder="Your name" minLength={2} maxLength={18} value={nickname} onChange={event => setNickname(event.target.value)} aria-describedby="party-name-hint"/></label>
        <p id="party-name-hint" className="party-field-hint">2–18 letters, numbers, spaces, _ or -</p>
        <section className="party-create"><h2>Create a lobby</h2><button className="party-primary" disabled={busy || !validNickname} onClick={() => void connect(false)}><Plus size={19}/>{busy ? 'Connecting...' : 'Create lobby'}</button></section>
        <form className="party-join" onSubmit={event => { event.preventDefault(); void connect(true); }}><h2>Join a lobby</h2><label htmlFor="party-join-code">Lobby code</label><div><Hash size={18}/><input id="party-join-code" aria-label="Lobby code" placeholder="ABC234" autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={6} value={code} onChange={event => setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}/><button type="submit" disabled={busy || !validNickname || !/^[A-HJ-NP-Z2-9]{6}$/.test(code)} aria-label="Join lobby" title="Join lobby"><ArrowRight size={22}/></button></div></form>
        {!party.connected && <p className="party-entry-offline" role="status"><WifiOff size={15}/> Party service offline. Trying to reconnect.</p>}
      </motion.aside>}
    </div>
    <motion.footer className="party-footer" variants={reduced ? still : fade}><span>APEX <i>/</i> Private sessions</span>{lobby ? <span>{host ? 'Host controls' : 'Shared setup'}<i>/</i>{track.name}</span> : <span>Invite by code</span>}</motion.footer>
  </motion.main>}</AnimatePresence>;
}
