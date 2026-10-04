import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { Matrix4, Vector3 } from 'three';
import { TRACKS } from '../shared/tracks';

test('all cleaned runtime models have finite non-degenerate geometry and preserve material identities',async t=>{
  const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder});
  for(const track of TRACKS)await t.test(track.id,async()=>{
    assert.ok(track.runtimeModel?.endsWith('.clean.glb'));
    const doc=await io.read(`public/models/tracks/${track.runtimeModel}`),source=await io.read(`public/models/tracks/${track.model}`);
    assert.deepEqual(doc.getRoot().listMaterials().map(m=>m.getName()),source.getRoot().listMaterials().map(m=>m.getName()),'surface classification indices must remain stable');
    let triangles=0,cutouts=0;
    for(const m of doc.getRoot().listMaterials())if(m.getExtras().apexFoliage){
      assert.equal(m.getAlphaMode(),'MASK');assert.equal(m.getExtras().apexNonSolid,true);cutouts++;
    }
    for(const m of doc.getRoot().listMaterials())if(m.getExtras().apexRoadOverlay){
      assert.equal(m.getAlphaMode(),'BLEND');assert.equal(m.getExtras().apexNonSolid,true);
    }
    assert.ok(cutouts>0,'each venue should have audited non-solid cutout foliage');
    doc.getRoot().getDefaultScene()!.traverse(node=>{
      const matrix=new Matrix4().fromArray(node.getWorldMatrix());
      for(const p of node.getMesh()?.listPrimitives()??[]){
        const pos=p.getAttribute('POSITION');if(!pos||p.getMode()!==4)continue;
        const verts:Vector3[]=[],idx=p.getIndices(),count=idx?.getCount()??pos.getCount();
        for(let i=0;i<pos.getCount();i++){
          const v=new Vector3().fromArray(pos.getElement(i,[])).applyMatrix4(matrix);
          assert.ok(v.toArray().every(Number.isFinite));verts.push(v);
        }
        if(p.getMaterial()?.getBaseColorTexture())assert.ok(p.getAttribute('TEXCOORD_0'),'textured geometry must retain UVs');
        assert.equal(count%3,0);
        for(let i=0;i<count;i+=3){
          const [a,b,c]=[0,1,2].map(j=>verts[idx?.getScalar(i+j)??i+j]);assert.ok(a&&b&&c);
          assert.ok(b.clone().sub(a).cross(c.clone().sub(a)).length()>=1e-8,`${node.getName()}: zero-area face ${i/3}`);triangles++;
        }
      }
    });
    assert.ok(triangles>10000);t.diagnostic(`${track.id}: ${triangles} valid runtime triangles; ${cutouts} cutout materials`);
  });
});
