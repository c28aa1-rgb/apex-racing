export const DEFAULT_BINDINGS={throttle:['KeyW','ArrowUp'],brake:['KeyS','ArrowDown'],left:['KeyA','ArrowLeft'],right:['KeyD','ArrowRight'],drift:['ShiftLeft'],shiftUp:['KeyE'],shiftDown:['KeyQ'],restart:['KeyR'],recover:['KeyC'],flip:['KeyF'],camera:['KeyV'],lookBack:['KeyB'],ghost:['KeyG'],mute:['KeyM'],pause:['Escape']};
export type Action=keyof typeof DEFAULT_BINDINGS;
export type Bindings=Record<Action,string[]>;
export const ACTION_LABELS:Record<Action,string>={throttle:'Accelerate',brake:'Brake / reverse',left:'Steer left',right:'Steer right',drift:'Drift',shiftUp:'Shift up',shiftDown:'Shift down',restart:'Restart run',recover:'Recover at checkpoint',flip:'Flip upright',camera:'Switch camera',lookBack:'Look behind (hold)',ghost:'Toggle ghost',mute:'Mute sound',pause:'Pause / resume'};
export const keyLabel=(code:string)=>({ArrowUp:'↑',ArrowDown:'↓',ArrowLeft:'←',ArrowRight:'→',ShiftLeft:'Left Shift',ShiftRight:'Right Shift',Escape:'Esc',Space:'Space',BracketLeft:'[',BracketRight:']',Comma:',',Period:'.',Slash:'/',Semicolon:';',Quote:"'",Minus:'−',Equal:'=',Backslash:'\\'}[code]??code.replace(/^Key|^Digit/,''));
export const validKey=(code:string)=>/^(Key[A-Z]|Digit[0-9]|Arrow(Up|Down|Left|Right)|Shift(Left|Right)|Space|Bracket(Left|Right)|Comma|Period|Slash|Semicolon|Quote|Minus|Equal|Backslash)$/.test(code);
/**
 * Rebinds one slot. A key may be shared by several actions (both fire when it is
 * pressed); `shared` lists the other actions already using it, so the interface can warn.
 */
export function bindingChange(bindings:Bindings,action:Action,index:number,code:string):{error?:string;bindings?:Bindings;shared?:Action[]}{
  if(!validKey(code))return {error:'Use a letter, number, arrow, Shift, Space or punctuation key. Escape stays available for safety.'};
  const next=structuredClone(bindings);next[action][index]=code;
  const shared=(Object.keys(next) as Action[]).filter(other=>other!==action&&next[other].includes(code));
  return {bindings:next,shared};
}
/** Keys bound to more than one action, with the actions that share each. */
export function bindingConflicts(bindings:Bindings):Map<string,Action[]>{
  const owners=new Map<string,Action[]>();
  for(const action of Object.keys(bindings) as Action[])for(const code of new Set(bindings[action])){const list=owners.get(code)??[];list.push(action);owners.set(code,list);}
  for(const [code,list] of owners)if(list.length<2)owners.delete(code);
  return owners;
}
export function loadBindings(value:unknown):Bindings{
  const result=structuredClone(DEFAULT_BINDINGS);
  if(!value||typeof value!=='object')return result;
  const candidate=value as Partial<Bindings>;
  for(const action of Object.keys(result) as Action[]){
    const codes=candidate[action];
    // Actions added in a later version keep their default key instead of discarding the player's other bindings.
    if(codes===undefined)continue;
    if(!Array.isArray(codes)||codes.length!==result[action].length||codes.some(c=>typeof c!=='string'||(!validKey(c)&&!(action==='pause'&&c==='Escape'))))return structuredClone(DEFAULT_BINDINGS);
    result[action]=[...codes] as never;
  }
  return result;
}
