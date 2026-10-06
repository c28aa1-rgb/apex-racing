import { API_URL } from './multiplayer-config';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { TRACKS } from '../shared/tracks';
import { LoadingScreen } from './LoadingScreen';
import type { Game } from './game';
import { applyFinishPlacement, applyRoadWidthOverrides, applySavedFinishPlacements, applySavedRoadWidthOverrides, applySavedStartPlacements, applyStartPlacement, saveCockpitOffsets, type CockpitOffsets } from './dev-spawns';
import './style.css';
import { applyCheckpoints, loadCheckpoints, type CheckpointLayouts } from './dev-spawns';

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
  try {
    const response = await fetch(`${API_URL}/api/dev-circuit-config`);
    if (response.ok) {
      const config = await response.json() as { starts?: Record<string, import('./world').StartPlacement>; finishes?: Record<string, import('./world').StartPlacement>; roads?: Record<string, Record<number, number>>; maps?: Record<string, import('../shared/tracks').Vec3[]>; cockpits?: CockpitOffsets };
      TRACKS.forEach(track => { applyStartPlacement(track, config.starts?.[track.id]); applyFinishPlacement(track, config.finishes?.[track.id]); applyRoadWidthOverrides(track, config.roads?.[track.id]); track.mapPath = config.maps?.[track.id]; });
      const layouts=(config as typeof config & {checkpoints?:CheckpointLayouts}).checkpoints;
      if(layouts)TRACKS.forEach(t=>applyCheckpoints(t,layouts[t.id]));
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
