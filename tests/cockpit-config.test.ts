import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store';
import { createApp } from '../server/app';

test('saved cockpit positions preserve both legacy and detected-seat origins across a server restart',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'apex-cockpit-test-'));
  const config={starts:{},finishes:{},roads:{},maps:{},cockpits:{
    'mclaren-720s-gt3':{x:-.16,y:-.01,z:.19},
    'porsche-911-gt3':{x:.03,y:.1,z:-.12,reference:'driver-seat'},
  }};
  const store=new Store(undefined,directory);await store.init();
  const app=await createApp(store,async()=>{throw new Error('No replay expected');});
  try{
    const result=await app.inject({method:'PUT',url:'/api/dev-circuit-config',payload:config});
    assert.equal(result.statusCode,200,result.body);
    assert.deepEqual((await app.inject({url:'/api/dev-circuit-config'})).json(),config);
  }finally{await app.close();await store.close();}
  const reopened=new Store(undefined,directory);await reopened.init();
  try{assert.deepEqual(await reopened.circuitConfig(),config);}finally{await reopened.close();}
});
