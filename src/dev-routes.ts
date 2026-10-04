import type { Vec3 } from '../shared/tracks';

export type RecordedRoutes=Record<string,Vec3[]>;
const key='apex:dev-recorded-routes:v1';
export function validRoute(value:unknown):value is Vec3[] {
  return Array.isArray(value)&&value.length>=2&&value.length<=4000&&value.every(p=>p&&['x','y','z'].every(axis=>Number.isFinite(p[axis])));
}
export function loadRecordedRoutes():RecordedRoutes {
  try {const value=JSON.parse(localStorage.getItem(key)??'{}');return Object.fromEntries(Object.entries(value).filter(([,path])=>validRoute(path))) as RecordedRoutes;}catch{return {};}
}
export function saveRecordedRoutes(routes:RecordedRoutes) {
  const clean=Object.fromEntries(Object.entries(routes).filter(([,path])=>validRoute(path)));
  localStorage.setItem(key,JSON.stringify(clean));
  window.dispatchEvent(new Event('apex:routes-updated'));
}
export async function fetchRecordedRoutes():Promise<{routes:RecordedRoutes;online:boolean}> {
  const local=loadRecordedRoutes();
  try{
    const response=await fetch('/api/dev-circuit-config',{signal:AbortSignal.timeout(5000)});
    if(!response.ok)throw new Error('Route server unavailable');
    const config=await response.json();
    const remote=Object.fromEntries(Object.entries(config.maps??{}).filter(([,path])=>validRoute(path))) as RecordedRoutes;
    const routes={...local,...remote};
    // Storage may be blocked or full; a successful server read must still work.
    try{saveRecordedRoutes(routes);}catch{}
    return {routes,online:true};
  }catch{return {routes:local,online:false};}
}
