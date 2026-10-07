import { assetUrl } from '../shared/assets';
import { MULTIPLAYER_BACKEND } from './multiplayer-config';
import { partyEvents } from './cloudflare-party';
import { useEffect, useState } from 'react';
import { AnimatePresence, motion, type Variants } from 'framer-motion';

// Paddock entrance: the page settles in, then heading, lineup and settings arrive in a short cascade.
const SPRING = { type: 'spring', stiffness: 380, damping: 34, mass: .9 } as const;
const pageMotion: Variants = { hidden: { opacity: 0 }, shown: { opacity: 1, transition: { duration: .2, staggerChildren: .07, delayChildren: .04 } }, exit: { opacity: 0, scale: .985, transition: { duration: .2, ease: [.4, 0, 1, 1] } } };
const fromAbove: Variants = { hidden: { opacity: 0, y: -14 }, shown: { opacity: 1, y: 0, transition: SPRING } };
const settle: Variants = { hidden: { opacity: 0, scale: .965 }, shown: { opacity: 1, scale: 1, transition: { ...SPRING, stiffness: 260 } } };
const fromRight: Variants = { hidden: { opacity: 0, x: 32 }, shown: { opacity: 1, x: 0, transition: SPRING } };
const fade: Variants = { hidden: { opacity: 0 }, shown: { opacity: 1, transition: { duration: .3 } } };
const still: Variants = { hidden: { opacity: 0 }, shown: { opacity: 1, transition: { duration: 0 } }, exit: { opacity: 0, transition: { duration: 0 } } };
import { ArrowRight, Check, Copy, Crown, DoorOpen, Flag, Hash, Minus, Plus, Sun, CloudRain, Snowflake, CloudFog, UsersRound, Wifi, WifiOff } from 'lucide-react';
import { CARS, DEFAULT_CAR, carById } from '../shared/cars';
import { UNLOCK_XP, unlocked } from './progression';
import { TRACKS } from '../shared/tracks';
import { DEFAULT_PARTY_SETTINGS, PARTY_WEATHER, type PartyWeather, type PartyRace } from '../shared/party';
import { Game } from './game';
import { api, write, type Player } from './storage';
import { PartyStage } from './PartyStage';
import { useParty, requestParty } from './use-party';
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

export function PartyPanel({ game, active, player, onPlayer, reduced }: {
  game: Game; active: boolean; player: Player | null; onPlayer: (player: Player) => void; reduced: boolean;
}) {
  const party = useParty(player, active), { lobby } = party;
  const [nickname, setNickname] = useState(player?.nickname ?? '');
  const [code, setCode] = useState(''), [identityBusy, setIdentityBusy] = useState(false), [identityError, setIdentityError] = useState('');
  const [copied, setCopied] = useState(false), [copyError, setCopyError] = useState('');
  const [raceState, setRaceState] = useState<PartyRace>(), [raceError, setRaceError] = useState('');
  useEffect(() => { if (player) setNickname(player.nickname); }, [player?.nickname]);
  useEffect(() => {
    game.partyView = active && !lobby?.race;
    return () => { game.partyView = false; };
  }, [active, game, lobby?.race?.id]);
  useEffect(() => {
    if (!lobby?.race || !player) { setRaceState(undefined); return; }
    let disposed = false, timer: ReturnType<typeof setTimeout>, ready = false;
    setRaceState(lobby.race); setRaceError('');
    void game.prepareParty(lobby, player.id).then(() => { ready = true; }).catch(cause => { if (!disposed) setRaceError(cause instanceof Error ? cause.message : 'Race assets failed to load.'); });
    const poll = async () => {
      const sent = Date.now();
      try {
        const result = await requestParty<{race: PartyRace; serverNow: number}>('/race', player.token, 'POST', { raceId: lobby.race!.id, ready, ...(ready ? { pose: game.partyPose() } : {}) });
        if (!disposed) { game.syncParty(result.race, result.serverNow + (Date.now() - sent) / 2); setRaceState(result.race); if (ready) setRaceError(''); }
      } catch (cause) { if (!disposed) setRaceError(cause instanceof Error ? cause.message : 'Race connection interrupted.'); }
      finally { if (!disposed) timer = setTimeout(poll, ready ? 50 : 500); }
    };
    const receive = (event: Event) => {
      const packet = (event as CustomEvent).detail as { race: PartyRace; serverNow: number };
      if (!disposed && packet.race.id === lobby.race!.id) { game.syncParty(packet.race, packet.serverNow); setRaceState(packet.race); }
    };
    if (MULTIPLAYER_BACKEND === 'cloudflare') partyEvents.addEventListener('race', receive);
    void poll();
    return () => { disposed = true; clearTimeout(timer); partyEvents.removeEventListener('race', receive); game.endParty(); };
  }, [lobby?.race?.id, player?.token, game]);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 2000); return () => clearTimeout(timer); }, [copied]);
  // Keep the presence wrapper mounted so the paddock can animate out when you leave it.
  if (!active && !lobby?.race) return <AnimatePresence />;

  const busy = party.busy || identityBusy || party.checking;
  const host = lobby?.hostId === player?.id;
  const settings = lobby?.settings ?? DEFAULT_PARTY_SETTINGS;
  const track = TRACKS.find(track => track.id === settings.trackId)!;
  const me = lobby?.members.find(member => member.id === player?.id);
  const selectedCar = carById(me?.carId ?? game.state.car.id);
  // Party grids use the same garage ownership as time trials; a locked garage preview joins in the starter car.
  const joinCar = unlocked(game.career, selectedCar.id) ? selectedCar : DEFAULT_CAR;
  const hostName = lobby?.members.find(member => member.id === lobby.hostId)?.nickname;
  const error = identityError || party.error;
  const validNickname = /^[\p{L}\p{N} _-]{2,18}$/u.test(nickname.trim());
  const connect = async (join: boolean) => {
    if (!validNickname || busy) return;
    setIdentityBusy(true); setIdentityError(''); party.clearError();
    try {
      let identity = player;
      if (identity) {
        try { identity = { ...identity, ...await api<Pick<Player, 'id' | 'nickname'>>('/players/me', { nickname }, 'PUT') }; }
        catch (cause) { if (cause instanceof Error && cause.message.includes('expired')) identity = null; else throw cause; }
      }
      if (!identity) identity = await api<Player>('/players', { nickname });
      write('player', identity); onPlayer(identity);
      if (join) await party.join(identity, joinCar.id, code);
      else await party.create(identity, joinCar.id, { trackId: game.state.track.id, weather: game.settings.weather });
    } catch (cause) { setIdentityError(cause instanceof Error ? cause.message : 'Could not save your driver name. Try again.'); }
    finally { setIdentityBusy(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(lobby!.code); setCopied(true); setCopyError(''); }
    catch { setCopyError('Select the lobby code above to copy it.'); }
  };

  if (lobby?.race && raceState) {
    const racers = [...raceState.racers].sort((a,b) => (a.finishedAt ?? Infinity) - (b.finishedAt ?? Infinity) || (b.pose?.lap ?? 1) - (a.pose?.lap ?? 1) || (b.pose?.checkpoint ?? 0) - (a.pose?.checkpoint ?? 0) || a.slot - b.slot);
    const loading = !raceState.ended && !(game.partyRace?.ready && raceState.startAt);
    const ready = raceState.racers.filter(r => r.ready && !r.disconnected).length, total = raceState.racers.filter(r => !r.disconnected).length;
    const step = !game.partyRace ? 'Finding your lobby' : game.partyLoadStep || (!raceState.startAt ? `Waiting for drivers · ${ready} / ${total} ready` : 'Starting');
    const spectating = game.state.mode === 'party-finished' && !raceState.ended;
    const watchable = spectating ? game.spectateCandidates() : [];
    const watchedName = raceState.racers.find(r => r.id === game.spectating)?.nickname;
    if (loading) return <section className="party-loading" role="status" aria-live="polite" aria-label="Joining race">
      <img src={assetUrl(`art/${track.id}.png`)} alt=""/>
      <div className="party-loading-card">
        <span className="party-loading-kicker">Party race · {settings.laps} {settings.laps === 1 ? 'lap' : 'laps'} · {weatherNames[settings.weather]}</span>
        <h2>{track.name}</h2>
        <div className="party-loading-step">{!(raceError || error) && <span className="party-loading-spinner" aria-hidden="true"/>}<strong>{raceError || error || step}</strong></div>
        <ul className="party-loading-drivers">{raceState.racers.map(r => <li key={r.id} className={r.ready ? 'is-ready' : ''}><span>{r.nickname}{r.id === player?.id ? ' (you)' : ''}</span><small>{r.disconnected ? 'Left' : r.ready ? 'Ready' : 'Loading…'}</small></li>)}</ul>
        <div className="party-race-actions">{host && <button className="party-leave" disabled={busy} onClick={() => void party.reopen()}><Flag size={17}/>Cancel race</button>}<button className="party-leave" disabled={busy} onClick={() => void party.leave()}><DoorOpen size={17}/>Leave race</button></div>
      </div>
    </section>;
    return <section className="party-race" aria-label="Party race">
      {spectating && <div className="party-spectate" role="group" aria-label="Spectator camera" data-watching={watchedName ? "true" : undefined}>
        <span>{watchedName ? 'Watching' : 'Camera'}<strong>{watchedName ?? 'Your car'}</strong></span>
        <button disabled={!watchable.length} onClick={() => game.spectate(-1)} aria-label="Previous driver">‹</button>
        <button disabled={!watchable.length} onClick={() => game.spectate(1)} aria-label="Next driver">›</button>
        {watchedName && <button onClick={() => game.spectate(0)}>Your car</button>}
        {!watchable.length && <small>Everyone has finished</small>}
      </div>}
      <div className="party-race-status"><strong>{raceState.ended ? 'Race results' : !game.partyRace?.ready ? 'Preparing grid' : !raceState.startAt ? 'Waiting for drivers' : game.partyRace.finished ? 'Finished' : `Lap ${game.partyRace.lap} / ${settings.laps}`}</strong><span>{track.name} · {weatherNames[settings.weather]}</span></div>
      <ol className="party-race-order">{racers.map(racer => <li key={racer.id} className={racer.id === player?.id ? 'is-you' : ''}><span>{racer.nickname}</span><strong>{racer.disconnected ? 'DNF' : racer.finishedAt ? `${((racer.finishedAt - raceState.startAt!) / 1000).toFixed(2)}s` : !racer.ready ? 'Loading' : !raceState.startAt ? 'Ready' : `Lap ${racer.pose?.lap ?? 1}`}</strong></li>)}</ol>
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
        <PartyStage world={game.world} members={lobby?.members ?? [{ id: 'preview', nickname: nickname.trim() || 'Your driver', carId: joinCar.id }]} capacity={lobby?.settings.maxPlayers ?? 4} hostId={lobby?.hostId} selfId={player?.id ?? 'preview'} reduced={reduced} entrance={!lobby}/>
      </motion.section>

      {lobby ? <motion.aside className="party-setup" aria-label="Shared race settings" variants={reduced ? still : fromRight}>
        <div className="party-your-car">
          <div><label htmlFor="party-car">Your car</label><span>{player?.nickname}</span></div>
          <select id="party-car" value={me?.carId ?? selectedCar.id} disabled={busy || !party.connected} onChange={event => { const car = carById(event.target.value); if (unlocked(game.career, car.id)) void party.chooseCar(car.id); }}>{CARS.map(car => { const owned = unlocked(game.career, car.id); return <option key={car.id} value={car.id} disabled={!owned}>{owned ? car.name : `${car.name} · locked, ${UNLOCK_XP[car.id].toLocaleString()} REP`}</option>; })}</select>
          <span className="party-car-drive">{selectedCar.physics.drivetrain}</span>
        </div>
        <div className="party-section-title"><h2>Race setup</h2><span><Crown size={14}/>{host ? 'You are host' : `${hostName} hosts`}</span></div>
        <div className="party-track-art"><img src={assetUrl(`art/${track.id}.png`)} alt={`${track.name} circuit map`}/><span>{track.subtitle}</span></div>
        <label className="party-field"><span>Circuit</span>{host ? <select aria-label="Circuit" value={settings.trackId} disabled={busy || !party.connected} onChange={event => void party.configure({ trackId: event.target.value })}>{TRACKS.map(track => <option key={track.id} value={track.id}>{track.name}</option>)}</select> : <strong data-testid="party-track">{track.name}</strong>}</label>
        <fieldset className="party-weather" disabled={!host || busy || !party.connected}><legend>Weather</legend><div>{PARTY_WEATHER.map(weather => {
          const WeatherIcon = weatherIcons[weather];
          return <label key={weather} title={weatherNames[weather]} className={settings.weather === weather ? 'selected' : ''}><input type="radio" aria-label={weatherNames[weather]} name="party-weather" value={weather} checked={settings.weather === weather} onChange={() => void party.configure({ weather })}/><WeatherIcon size={20}/><span>{weatherNames[weather]}</span></label>;
        })}</div></fieldset>
        <div className="party-setting-row"><label htmlFor="party-laps">Laps</label>{host ? <Laps value={settings.laps} disabled={busy || !party.connected} onChange={laps => void party.configure({ laps })}/> : <strong data-testid="party-laps">{settings.laps}</strong>}</div>
        <div className="party-setting-row"><label htmlFor="party-capacity">Player limit</label>{host ? <select id="party-capacity" value={settings.maxPlayers} disabled={busy || !party.connected} onChange={event => void party.configure({ maxPlayers: Number(event.target.value) })}>{[2,3,4,5,6,7,8].map(n => <option key={n} value={n} disabled={n < lobby.members.length}>{n} drivers</option>)}</select> : <strong>{settings.maxPlayers} drivers</strong>}</div>
        <div className="party-session-summary" aria-live="polite"><Flag size={17}/><span>{settings.laps} {settings.laps === 1 ? 'lap' : 'laps'}<i>/</i>{weatherNames[settings.weather]}<i>/</i>{(track.length * settings.laps / 1609.344).toFixed(1)} mi</span></div>
        {host ? <button className="party-primary" disabled={busy || !party.connected} onClick={() => void party.start()}><Flag size={18}/>Start race</button> : <p className="party-lobby-status">Waiting for host<span>{lobby.members.length} of {settings.maxPlayers} places filled</span></p>}
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
