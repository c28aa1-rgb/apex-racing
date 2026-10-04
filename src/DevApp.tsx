import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { TRACKS } from '../shared/tracks';
import { CARS, type CarId } from '../shared/cars';
import { Game } from './game';
import { applyFinishPlacement, applyRoadWidthOverrides, applyStartPlacement, loadCockpitOffsets, loadFinishPlacements, loadRoadWidthOverrides, loadStartPlacements, saveCockpitOffsets, saveFinishPlacements, saveRoadWidthOverrides, saveStartPlacements, type CockpitOffsets, type FinishPlacements, type RoadWidthOverrides, type StartPlacements } from './dev-spawns';
import type { CockpitOffset, EditorMode, StartPlacement } from './world';
import { CheckpointRecorder } from './CheckpointRecorder';
import { loadCheckpoints, saveCheckpoints, applyCheckpoints } from './dev-spawns';
import { loadRecordedRoutes, saveRecordedRoutes } from './dev-routes';

type Tool = EditorMode | 'cockpit' | 'checkpoints';
type MapPaths = Record<string, { x: number; y: number; z: number }[]>;
type Config = { starts: StartPlacements; finishes: FinishPlacements; roads: RoadWidthOverrides; maps: MapPaths; cockpits: CockpitOffsets };
const labels: Record<Tool, string> = { spawn: 'Start', finish: 'Finish', road: 'Road surface', cockpit: 'Cockpit camera',checkpoints:'Drive checkpoints' };
const pos = (n: number) => n.toFixed(2);
const zeroOffset: CockpitOffset = { x: 0, y: 0, z: 0, reference: 'driver-seat' };

export function DevApp({ game }: { game: Game }) {
  const gameState=useSyncExternalStore(game.subscribe, game.snapshot);
  const [trackId, setTrackId] = useState(game.snapshot().track.id), [tool, setTool] = useState<Tool>('spawn');
  const [starts, setStarts] = useState<StartPlacements>(() => loadStartPlacements());
  const [finishes, setFinishes] = useState<FinishPlacements>(() => loadFinishPlacements());
  const [roads, setRoads] = useState<RoadWidthOverrides>(() => loadRoadWidthOverrides());
  const [cockpits, setCockpits] = useState<CockpitOffsets>(() => loadCockpitOffsets());
  const [maps, setMaps] = useState<MapPaths>(()=>loadRecordedRoutes());
  useEffect(()=>{const reload=()=>setMaps(loadRecordedRoutes());window.addEventListener('apex:routes-updated',reload);return()=>window.removeEventListener('apex:routes-updated',reload);},[]);
  const [carId, setCarId] = useState<CarId>(gameState.car.id);
  const [cockpitOffset, setCockpitOffset] = useState(zeroOffset);
  const [placement, setPlacement] = useState<StartPlacement | undefined>();
  const [roadDraft, setRoadDraft] = useState<Record<number, number>>({});
  const [recording, setRecording] = useState(false);
  const [notice, setNotice] = useState('Choose an annotation tool.');
  const track = useMemo(() => TRACKS.find(item => item.id === trackId)!, [trackId]);
  const persist = useCallback(async (next: Config) => {
    Object.assign(next,{checkpoints:loadCheckpoints()});
    saveStartPlacements(next.starts); saveFinishPlacements(next.finishes); saveRoadWidthOverrides(next.roads); saveCockpitOffsets(next.cockpits);
    saveRecordedRoutes(next.maps);
    try { const response=await fetch('/api/dev-circuit-config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) }); if(!response.ok)throw new Error(`Save failed (${response.status})`);setNotice('Saved permanently to the local race-control server.'); }
    catch { setNotice('Saved locally. The race-control server is currently unavailable.'); }
  }, []);
  useEffect(() => { void fetch('/api/dev-circuit-config').then(r => r.ok ? r.json() : undefined).then((value: Config | undefined) => {
    if(value){value.maps={...loadRecordedRoutes(),...value.maps};saveRecordedRoutes(value.maps);}
    if (!value) return; setStarts(value.starts ?? {}); setFinishes(value.finishes ?? {}); setRoads(value.roads ?? {}); setMaps(value.maps ?? {}); setCockpits(value.cockpits ?? {}); const layouts=(value as Config & {checkpoints?:ReturnType<typeof loadCheckpoints>}).checkpoints;if(layouts){saveCheckpoints(layouts);TRACKS.forEach(t=>applyCheckpoints(t,layouts[t.id]));}
    TRACKS.forEach(item => { applyStartPlacement(item, value.starts?.[item.id]); applyFinishPlacement(item, value.finishes?.[item.id]); applyRoadWidthOverrides(item, value.roads?.[item.id]); item.mapPath = value.maps?.[item.id]; });
  }).catch(() => undefined); }, []);
  const updatePlacement = useCallback((value: StartPlacement) => { setPlacement(value); setNotice(`Click ahead of the ${tool === 'finish' ? 'finish line' : 'car'} to set direction, then save.`); }, [tool]);
  const updateRoad = useCallback((segment: number, width: number) => setRoadDraft(current => { const next = { ...current, [segment]: Math.round(width * 10) / 10 }; applyRoadWidthOverrides(track, next); setNotice(`Section ${segment + 1} staged. Click another pair of visible asphalt edges.`); return next; }), [track]);
  useEffect(() => {
    if(tool==='checkpoints'){game.setEditor(false);void game.select(track);setNotice('Drive the course. J drops a checkpoint; K creates the finish and saves.');return;}
    if (tool === 'cockpit') {
      const offset=cockpits[carId] ?? zeroOffset;
      game.setEditor(false); game.setCockpitPreview(true); game.selectCar(carId); game.setCockpitOffset(offset); setCockpitOffset(offset);
      setNotice('Use the sliders to position the driver’s eye. Drag the view to inspect the result.');
      return () => game.setCockpitPreview(false);
    }
    game.setEditor(true); applyRoadWidthOverrides(track, roads[track.id]); game.select(track);
    const next = tool === 'spawn' ? starts[track.id] : finishes[track.id]; setPlacement(next); setRoadDraft(roads[track.id] ?? {});
    if (tool === 'road') { game.world.beginRoadEditor(track, updateRoad); setNotice('Click one asphalt edge, then the opposite edge across that road section.'); }
    else { game.world.beginPlacementEditor(track, tool, next, updatePlacement); setNotice(next ? `Saved ${labels[tool].toLowerCase()} loaded.` : `Click the visible circuit to place the ${labels[tool].toLowerCase()}.`); }
    return () => game.world.endStartEditor();
  }, [game, track, tool, starts, finishes, roads, cockpits, carId, updatePlacement, updateRoad]);
  const updateCockpit = (axis: 'x'|'y'|'z', value: number) => setCockpitOffset(current => {
    const next = { ...current, [axis]: Math.round(value * 100) / 100 }; game.setCockpitOffset(next); return next;
  });
  const save = () => {
    if (tool === 'cockpit') { const next={ starts, finishes, roads, maps, cockpits: { ...cockpits, [carId]: cockpitOffset } }; setCockpits(next.cockpits); void persist(next); setNotice(`Saved ${CARS.find(car=>car.id===carId)!.shortName} cockpit position permanently.`); return; }
    if (tool === 'road') { const next = { starts, finishes, roads: { ...roads, [track.id]: roadDraft }, maps, cockpits }; setRoads(next.roads); void persist(next); game.select(track); return; }
    if (!placement) return setNotice(`Place the ${labels[tool].toLowerCase()} first.`);
    const next: Config = tool === 'spawn' ? { starts: { ...starts, [track.id]: placement }, finishes, roads, maps, cockpits } : { starts, finishes: { ...finishes, [track.id]: placement }, roads, maps, cockpits };
    setStarts(next.starts); setFinishes(next.finishes); applyStartPlacement(track, next.starts[track.id]); applyFinishPlacement(track, next.finishes[track.id]); void persist(next); game.select(track);
  };
  const clear = () => { if (tool === 'cockpit') { setCockpitOffset(zeroOffset); game.setCockpitOffset(zeroOffset); return; } if (tool === 'road') { setRoadDraft({}); applyRoadWidthOverrides(track, {}); return; } setPlacement(undefined); game.world.setEditorPlacement(undefined); };
  const toggleRecording = () => {
    if (!recording) { setRecording(true); game.beginRouteRecording(); setNotice('Recording: drive the centre of the route.'); return; }
    const path = game.finishRouteRecording(), nextMaps = { ...maps, [track.id]: path }; track.mapPath = path; setMaps(nextMaps); setRecording(false); void persist({ starts, finishes, roads, maps: nextMaps, cockpits }); setNotice(`Route smoothed into ${path.length} map points and saved permanently.`);
  };
  const reset = () => {
    if (tool === 'cockpit') { const nextCockpits={...cockpits};delete nextCockpits[carId];setCockpits(nextCockpits);setCockpitOffset(zeroOffset);game.setCockpitOffset(zeroOffset);void persist({ starts, finishes, roads, maps, cockpits: nextCockpits });return; }
    if (tool === 'road') { const nextRoads = { ...roads }; delete nextRoads[track.id]; applyRoadWidthOverrides(track, {}); setRoads(nextRoads); setRoadDraft({}); void persist({ starts, finishes, roads: nextRoads, maps, cockpits }); game.select(track); return; }
    if (tool === 'spawn') { const nextStarts = { ...starts }; delete nextStarts[track.id]; applyStartPlacement(track, undefined); setStarts(nextStarts); setPlacement(undefined); void persist({ starts: nextStarts, finishes, roads, maps, cockpits }); }
    else { const nextFinishes = { ...finishes }; delete nextFinishes[track.id]; applyFinishPlacement(track, undefined); setFinishes(nextFinishes); setPlacement(undefined); void persist({ starts, finishes: nextFinishes, roads, maps, cockpits }); }
    game.select(track);
  };
  const active = tool === 'spawn' ? !!starts[track.id] : tool === 'finish' ? !!finishes[track.id] : tool === 'road' ? !!roads[track.id] : !!cockpits[carId];
  return <main className="dev-console"><header className="dev-topbar"><a className="dev-brand" href="/">APEX<span> / </span><strong>Race control</strong></a><p>Permanent circuit annotations</p><a className="dev-return" href="/">Open game</a></header>
    <aside className="dev-track-list"><div><p>Circuits</p><strong>{TRACKS.length} loaded</strong></div>{TRACKS.map((item, i) => <button key={item.id} className={item.id === track.id ? 'active' : ''} onClick={() => setTrackId(item.id)}><span>{String(i + 1).padStart(2, '0')}</span><b>{item.name}</b><i>{starts[item.id] || finishes[item.id] || roads[item.id] ? 'edited' : 'default'}</i></button>)}</aside>
    <section className="dev-instructions"><span className="dev-step">{labels[tool]}</span><p>{notice}</p><small>{tool === 'cockpit' ? 'Drag to look around · sliders move the eye relative to the detected driver seat.' : tool === 'road' ? 'WASD/drag pans · scroll zooms · each edge pair calibrates a physical road section.' : 'WASD/drag pans · scroll zooms · arrows nudge relative to the marker.'}</small></section>
    <aside className="dev-inspector"><div className="dev-tool-tabs">{(['checkpoints','spawn','finish','road','cockpit'] as Tool[]).map(item => <button className={tool === item ? 'active' : ''} key={item} onClick={() => setTool(item)}>{labels[item]}</button>)}</div><div className="dev-title"><span>Editing</span><h1>{tool === 'cockpit' ? 'Cockpit view' : track.name}</h1></div>{tool === 'checkpoints' ? <CheckpointRecorder game={game} onSaved={()=>{setStarts(loadStartPlacements());setFinishes(loadFinishPlacements());}}/> : tool === 'cockpit' ? <div className="cockpit-controls"><label>Car<select value={carId} onChange={event => setCarId(event.target.value as CarId)}>{CARS.map(car=><option value={car.id} key={car.id}>{car.shortName}</option>)}</select></label>{(['x','y','z'] as const).map(axis=><label key={axis}><span>{axis.toUpperCase()} offset <b>{cockpitOffset[axis].toFixed(2)} m</b></span><input aria-label={`${axis.toUpperCase()} cockpit offset`} type="range" min="-1.5" max="1.5" step=".01" value={cockpitOffset[axis]} onChange={event=>updateCockpit(axis,Number(event.target.value))}/></label>)}<small>Offsets are in the car’s local axes: X left/right, Y up/down, Z forward/back.</small></div> : tool === 'road' ? <div className="dev-empty">{Object.keys(roadDraft).length} section(s) staged.<br />Click opposing asphalt edges to define width.</div> : placement ? <dl className="dev-coordinates"><div><dt>X</dt><dd>{pos(placement.position.x)}</dd></div><div><dt>Y</dt><dd>{pos(placement.position.y)}</dd></div><div><dt>Z</dt><dd>{pos(placement.position.z)}</dd></div><div><dt>Heading</dt><dd>{Math.round((placement.heading * 180 / Math.PI + 360) % 360)}°</dd></div></dl> : <div className="dev-empty">Click the visible road to stage the {labels[tool].toLowerCase()}.</div>}<div className="dev-actions" hidden={tool==='checkpoints'}><button className="dev-save" onClick={save}>Save permanently</button>{tool !== 'cockpit'&&<button onClick={toggleRecording}>{recording?'Stop & smooth route':'Drive & record route'}</button>}<button onClick={clear}>Clear draft</button><button onClick={() => navigator.clipboard.writeText(JSON.stringify(tool === 'cockpit' ? { [carId]: cockpitOffset } : tool === 'road' ? { [track.id]: roadDraft } : { [track.id]: placement }, null, 2)).then(() => setNotice('Editor JSON copied.'))}>Copy JSON</button><button className="dev-reset" disabled={!active} onClick={reset}>Use project default</button></div><p className="dev-note">{tool === 'cockpit' ? 'Cockpit adjustments are saved per vehicle by the local race-control server.' : 'Recorded routes drive the minimap and selection diagrams. Saved annotations are stored by the local race-control server.'}</p></aside>
  </main>;
}
