import { useEffect, useState, useSyncExternalStore } from 'react';
import { rotate } from '../shared/physics';
import type { Vec3 } from '../shared/tracks';
import type { Game } from './game';
import type { StartPlacement } from './world';
import { loadRecordedRoutes, saveRecordedRoutes } from './dev-routes';
import { applyCheckpoints, applyFinishPlacement, applyStartPlacement, loadCheckpoints, loadFinishPlacements, loadStartPlacements, saveCheckpoints, saveFinishPlacements, saveStartPlacements } from './dev-spawns';

export function CheckpointRecorder({game,onSaved}:{game:Game;onSaved:(mapPath?:Vec3[])=>void}) {
  const state=useSyncExternalStore(game.subscribe,game.snapshot);
  const [points,setPoints]=useState<StartPlacement[]>([]),[start,setStart]=useState<StartPlacement>(),[recording,setRecording]=useState(false),[message,setMessage]=useState('Start driving. J drops checkpoints. K saves finish plus minimap route.');
  const placement=():StartPlacement=>{const p=game.sim.car.translation(),forward=rotate(game.sim.car.rotation(),{x:0,y:0,z:1});return {position:{x:p.x,y:game.sim.visibleGroundAt(p)??p.y,z:p.z},heading:Math.atan2(forward.x,forward.z)};};
  const drop=()=>{if(!recording||state.mode!=='racing')return;const p=placement();if(points.some(v=>Math.hypot(v.position.x-p.position.x,v.position.z-p.position.z)<4)){setMessage('Drive at least 4 m from an existing checkpoint.');return;}setPoints([...points,p]);setMessage(`Checkpoint ${points.length+1} placed. Keep driving.`);};
  const finish=async()=>{
    if(!recording||!start||state.mode!=='racing')return;
    if(!points.length){setMessage('Place at least one checkpoint before the finish.');return;}
    const end=placement(),track=state.track;
    const route=game.finishRouteRecording();
    const mapPath=[start.position,...route,end.position];
    track.mapPath=mapPath;
    saveRecordedRoutes({...loadRecordedRoutes(),[track.id]:mapPath});
    game.authoring=false;setRecording(false);
    const checkpoints={...loadCheckpoints(),[track.id]:points},finishes={...loadFinishPlacements(),[track.id]:end},starts={...loadStartPlacements(),[track.id]:start};
    saveCheckpoints(checkpoints);saveFinishPlacements(finishes);saveStartPlacements(starts);
    applyStartPlacement(track,start);applyCheckpoints(track,points);applyFinishPlacement(track,end);
    setMessage(`Saved ${points.length} checkpoints and finish on this device.`);
    try{const response=await fetch('/api/dev-circuit-config');if(!response.ok)throw new Error();const config=await response.json();const saved=await fetch('/api/dev-circuit-config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({...config,starts:{...config.starts,[track.id]:start},finishes:{...config.finishes,[track.id]:end},checkpoints:{...config.checkpoints,[track.id]:points},maps:{...config.maps,[track.id]:mapPath}})});if(!saved.ok)throw new Error();setMessage(`Saved ${points.length} checkpoints, finish and minimap permanently.`);onSaved(mapPath);}catch{setMessage('Saved on this device. Server unavailable; minimap lasts this session.');onSaved(mapPath);}
    await game.select(track);
  };
  const reset=async()=>{
    const id=state.track.id,checkpoints=loadCheckpoints(),starts=loadStartPlacements(),finishes=loadFinishPlacements();
    delete checkpoints[id];delete starts[id];delete finishes[id];saveCheckpoints(checkpoints);saveStartPlacements(starts);saveFinishPlacements(finishes);
    applyCheckpoints(state.track);applyStartPlacement(state.track);applyFinishPlacement(state.track);setPoints([]);
    try{const response=await fetch('/api/dev-circuit-config');if(!response.ok)throw new Error();const config=await response.json();delete config.checkpoints?.[id];delete config.starts?.[id];delete config.finishes?.[id];const saved=await fetch('/api/dev-circuit-config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(config)});if(!saved.ok)throw new Error();onSaved();setMessage('Project race gates restored. Road-width edits remain unchanged.');}catch{setMessage('Restored on this device only; server unavailable.');}
    await game.select(state.track);
  };
  useEffect(()=>{const key=(e:KeyboardEvent)=>{if(e.repeat||(e.target as HTMLElement).closest('input,select,textarea'))return;if(e.code==='KeyJ'){e.preventDefault();drop();}if(e.code==='KeyK'){e.preventDefault();void finish();}};addEventListener('keydown',key);return()=>removeEventListener('keydown',key);});
  useEffect(()=>()=>{game.authoring=false;game.menu();},[game]);
  return <div className="checkpoint-recorder"><p>{message}</p><strong>{String(points.length).padStart(2,'0')} checkpoints</strong>
    {!recording?<button className="dev-save" disabled={!state.trackReady||!state.modelReady} onClick={()=>{game.setEditor(false);game.beginRouteRecording();if(game.state.mode!=='racing')return;game.authoring=true;setStart(placement());setPoints([]);setRecording(true);setMessage('Drive the route centre. J: checkpoint · K: finish + minimap.');}}>Start driving</button>:<>
      <button onClick={drop} disabled={state.mode!=='racing'}>Drop checkpoint <kbd>J</kbd></button><button className="dev-save" onClick={()=>void finish()} disabled={state.mode!=='racing'}>Finish line & save <kbd>K</kbd></button>
      <button onClick={()=>setPoints(p=>p.slice(0,-1))} disabled={!points.length}>Undo last checkpoint</button>
      {state.mode==='paused'&&<button onClick={()=>game.resume()}>Resume driving</button>}
      <button onClick={()=>{game.finishRouteRecording();game.authoring=false;setRecording(false);setMessage('Draft discarded. Saved layout unchanged.');}}>Cancel draft</button>
    </>}
    {!recording&&<button onClick={()=>void reset()}>Restore project race gates</button>}
    <small>Recorded drive creates minimap line. Placement follows car position and heading. Editor drives earn no REP; normal races on saved layouts earn career REP but cannot rank online.</small>
  </div>;
}
