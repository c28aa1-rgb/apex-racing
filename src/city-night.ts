import * as THREE from 'three';

/** Soft round falloff used for light pools and lamp glows: white centre to transparent edge. */
function glowTexture() {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
  const c = canvas.getContext('2d')!, gradient = c.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(255,255,255,1)'); gradient.addColorStop(.35, 'rgba(255,255,255,.55)'); gradient.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = gradient; c.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; return texture;
}

/**
 * Night dressing for a venue that only has daytime materials. Real lights are expensive in a forward renderer, so the
 * street lamps are faked: an emissive lamp head, an additive glow sprite around it and an additive pool of light on the
 * ground below. Windows and sign faces glow from their own textures. Two draw calls cover every lamp.
 */
export class CityNight {
  readonly group = new THREE.Group();
  private glow = glowTexture();
  private done = new WeakSet<THREE.Material>();
  constructor() { this.group.name = 'apex-city-night'; }
  /** Applies night materials and builds the lamp effects for a freshly loaded venue. Safe to call again. */
  apply(venue: THREE.Object3D) {
    this.clear();
    const heads: THREE.Vector3[] = [], poles: THREE.Vector3[] = [], matrix = new THREE.Matrix4(), at = new THREE.Vector3();
    venue.updateMatrixWorld(true);
    venue.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      const name = object.name + ' ' + (object.parent?.name ?? '');
      if (object instanceof THREE.InstancedMesh && /LampHeads|LampPoles/.test(name)) {
        // Heads are kept at their centre; poles at their foot (the geometry's lowest point), which is the ground.
        const list = /LampHeads/.test(name) ? heads : poles;
        if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
        const foot = list === poles ? object.geometry.boundingBox!.min.y : 0;
        for (let i = 0; i < object.count; i++) { object.getMatrixAt(i, matrix); list.push(at.set(0, foot, 0).applyMatrix4(matrix.premultiply(object.matrixWorld)).clone()); }
      }
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (!(material instanceof THREE.MeshStandardMaterial) || this.done.has(material)) continue;
        this.done.add(material);
        if (/LampHeads/.test(name)) { material.emissive.set(0xffdca6); material.emissiveIntensity = 4; }
        else if (/_Text$/.test(material.name)) { material.emissiveMap = material.map; material.emissive.set(0xffffff); material.emissiveIntensity = .9; }
        else if (/Glass/i.test(material.name)) { material.emissive.set(0xffc98a); material.emissiveIntensity = .22; }
        // The ModelMaker building atlas paints its windows in: a faint self-lit copy of it reads as lit rooms.
        else if (material.name === 'Atlas' && material.map) { material.emissiveMap = material.map; material.emissive.set(0xffd9a3); material.emissiveIntensity = .07; }
        else continue;
        material.needsUpdate = true;
      }
    });
    if (!heads.length) return;
    const pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({
      map: this.glow, color: 0xffb867, transparent: true, opacity: .5, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }), heads.length);
    const halos = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
      map: this.glow, color: 0xffd9a0, transparent: true, opacity: .7, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }), heads.length);
    const scale = new THREE.Vector3(), q = new THREE.Quaternion();
    heads.forEach((head, i) => {
      // The pool lies on the ground at the foot of the nearest pole, centred under the head.
      const base = poles.reduce((best, pole) => pole.distanceToSquared(head) < best.distanceToSquared(head) ? pole : best, poles[0] ?? head.clone().setY(0));
      pools.setMatrixAt(i, matrix.compose(at.set(head.x, base.y + .05, head.z), q.identity(), scale.set(18, 1, 18)));
      halos.setMatrixAt(i, matrix.compose(head, q.identity(), scale.set(2.6, 2.6, 2.6)));
    });
    pools.renderOrder = 3; halos.renderOrder = 4;
    halos.onBeforeRender = (_renderer, _scene, camera) => {
      // Halos face the camera; one shared rotation is enough for small sprites.
      for (let i = 0; i < heads.length; i++) halos.setMatrixAt(i, matrix.compose(heads[i], camera.quaternion, scale.set(2.6, 2.6, 2.6)));
      halos.instanceMatrix.needsUpdate = true;
    };
    pools.computeBoundingSphere(); halos.computeBoundingSphere(); halos.frustumCulled = false;
    this.group.add(pools, halos);
  }
  clear() {
    for (const child of [...this.group.children]) { if (child instanceof THREE.Mesh) { child.geometry.dispose(); (child.material as THREE.Material).dispose(); } this.group.remove(child); }
  }
}
