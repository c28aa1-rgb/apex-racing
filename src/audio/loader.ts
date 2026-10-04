// Fetches and decodes audio samples once per AudioContext. Missing or undecodable files resolve to
// undefined so callers can fall back to synthesis; audio must never break the game.
const cache=new WeakMap<AudioContext,Map<string,Promise<AudioBuffer|undefined>>>();

export function loadSample(context:AudioContext,url:string):Promise<AudioBuffer|undefined> {
  let samples=cache.get(context);
  if(!samples)cache.set(context,samples=new Map());
  let sample=samples.get(url);
  if(!sample){
    sample=fetch(url).then(r=>r.ok?r.arrayBuffer():Promise.reject(new Error(String(r.status)))).then(data=>context.decodeAudioData(data)).catch(()=>undefined);
    samples.set(url,sample);
  }
  return sample;
}

export function loadSamples<T extends string>(context:AudioContext,urls:Record<T,string>):Promise<Partial<Record<T,AudioBuffer>>> {
  const keys=Object.keys(urls) as T[];
  return Promise.all(keys.map(key=>loadSample(context,urls[key]))).then(buffers=>{
    const result:Partial<Record<T,AudioBuffer>>={};
    keys.forEach((key,i)=>{const buffer=buffers[i];if(buffer)result[key]=buffer;});
    return result;
  });
}
