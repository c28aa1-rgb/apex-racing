import { API_URL } from './multiplayer-config';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { TRACKS } from '../shared/tracks';
import { LoadingScreen } from './LoadingScreen';
import type { Game } from './game';
import { applyCheckpoints, applyFinishPlacement, applyRoadWidthOverrides, applySavedFinishPlacements, applySavedRoadWidthOverrides, applySavedStartPlacements, applyStartPlacement, loadCheckpoints, loadFinishPlacements, loadRoadWidthOverrides, loadStartPlacements, mergeCircuitSettings, saveCockpitOffsets, type CockpitOffsets, type CheckpointLayouts } from './dev-spawns';
import './style.css';
import { loadRecordedRoutes } from './dev-routes';

async function boot() {
  if (import.meta.env.DEV && location.pathname === '/dev/trailer') {
    const { bootTrailer } = await import('./trailer/TrailerApp');
    await bootTrailer();
    return;
  }
  const [{initPhysics},{Game},{App},{DevApp}]=await Promise.all([
    import('../shared/physics'),import('./game'),import('./App'),import('./DevApp')
  ]);
  applySavedStartPlacements(TRACKS);
  applySavedFinishPlacements(TRACKS);
  applySavedRoadWidthOverrides(TRACKS);
  const checkpoints=loadCheckpoints();TRACKS.forEach(t=>applyCheckpoints(t,checkpoints[t.id]));
  const starts=loadStartPlacements(),finishes=loadFinishPlacements(),roads=loadRoadWidthOverrides(),maps=mergeCircuitSettings(Object.fromEntries(TRACKS.map(track=>[track.id,track.mapPath!])),loadRecordedRoutes());
  try {
    const response = await fetch(`${API_URL}/api/dev-circuit-config`);
    if (response.ok) {
      const config = await response.json() as { starts?: Record<string, import('./world').StartPlacement>; finishes?: Record<string, import('./world').StartPlacement>; roads?: Record<string, Record<number, number>>; maps?: Record<string, import('../shared/tracks').Vec3[]>; cockpits?: CockpitOffsets };
      const saved=config as typeof config & {checkpoints?:CheckpointLayouts};
      const mergedStarts=mergeCircuitSettings(starts,config.starts),mergedFinishes=mergeCircuitSettings(finishes,config.finishes),mergedRoads=mergeCircuitSettings(roads,config.roads),mergedMaps=mergeCircuitSettings(maps,config.maps),mergedCheckpoints=mergeCircuitSettings(checkpoints,saved.checkpoints);
      TRACKS.forEach(track => { applyStartPlacement(track, mergedStarts[track.id]); applyFinishPlacement(track, mergedFinishes[track.id]); applyRoadWidthOverrides(track, mergedRoads[track.id]); track.mapPath = mergedMaps[track.id]; applyCheckpoints(track,mergedCheckpoints[track.id]); });
      if (config.cockpits) saveCockpitOffsets(config.cockpits);
    }
  } catch { /* Browser drafts remain available while the local server is offline. */ }
  await Promise.all([initPhysics(location.pathname.startsWith('/dev')?TRACKS[0]:undefined), document.fonts.ready]);
  const game=new Game(document.querySelector<HTMLCanvasElement>('#world')!);
  const root = createRoot(document.getElementById('app')!);
  root.render(createElement(location.pathname.startsWith('/dev') ? DevApp : App,{game}));
  // Diagnostic hooks are available only in the development build.
  if(import.meta.env.DEV)(window as unknown as {__apex:Game}).__apex=game;
}
const booting=boot();
// The trailer reel covers the boot on the player-facing game; dev tools and the trailer skip it.
if(!location.pathname.startsWith('/dev')){
  const host=document.createElement('div');host.id='loader';document.body.append(host);
  const loader=createRoot(host);
  loader.render(createElement(LoadingScreen,{ready:booting,onContinue:()=>{loader.unmount();host.remove();}}));
}
booting.catch(error=>{
  console.error(error);const root=document.getElementById('app')!;root.replaceChildren();
  const section=document.createElement('section');section.className='boot';
  const heading=document.createElement('h1');heading.textContent='The engine could not start.';
  const p=document.createElement('p');p.textContent='APEX needs WebGL 2. Enable hardware acceleration in your browser, then reload.';
  const button=document.createElement('button');button.textContent='Try again';button.onclick=()=>location.reload();section.append(heading,p,button);root.append(section);
});
