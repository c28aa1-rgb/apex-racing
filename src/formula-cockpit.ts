import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Procedural cockpit for the Red Bull RB19, built from reference images (work/cockpit-rb19/ref-*.png):
 * a 2023-style steering wheel, the driver's gloves, sleeves, torso and thighs, a carbon liner over the
 * tub walls and the suede rim padding. Everything here is built in code; the GLB supplies the bodywork.
 *
 * Coordinates: the wheel's own space has its hub at the origin and its face towards -Z (the driver).
 * The car's +X is the driver's LEFT, so a reference x measured from the driver's view is negated.
 * Car-space parts are positioned against the RB19 tub, measured by ray casts: side walls at |x| = 0.16-0.17,
 * floor y = -0.47, front bulkhead z ≈ 0.53, rim top y ≈ -0.05 with its upper flare reaching |x| ≈ 0.25.
 */

type Owned = { geometries: THREE.BufferGeometry[]; materials: THREE.Material[]; textures: THREE.Texture[] };
export type FormulaCockpit = {
  /** Keeps the forearms joined between the turning wheel and the fixed elbows. Call after the wheel moves. */
  pose(): void;
  /** Shift lights across the top of the wheel; `fraction` is rpm / redline. */
  paintLeds(fraction: number): void;
  /** The driver shows only from on board: the body from the cockpit, plus the helmet from the T-cam (the cockpit camera is inside it). */
  setDriverVisible(visible: boolean, helmet: boolean): void;
};

/** Reference x (driver's view, right positive) to car/wheel-space x. */
const rx = (x: number) => -x;

function canvasTexture(owned: Owned, width: number, height: number, draw: (c: CanvasRenderingContext2D) => void, color = true) {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  draw(canvas.getContext('2d')!);
  const texture = new THREE.CanvasTexture(canvas); if (color) texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.anisotropy = 4; owned.textures.push(texture);
  return texture;
}
/** 2×2 twill, the weave on F1 carbon parts, with a little fibre noise. */
function carbonTexture(owned: Owned) {
  return canvasTexture(owned, 128, 128, c => {
    let seed = 71;
    for (let y = 0; y < 128; y += 16) for (let x = 0; x < 128; x += 16) {
      const twill = ((x + y) / 16) % 4 < 2;
      const g = c.createLinearGradient(x, y, twill ? x + 16 : x, twill ? y : y + 16);
      g.addColorStop(0, '#16181a'); g.addColorStop(.5, twill ? '#2c3033' : '#24272a'); g.addColorStop(1, '#141618');
      c.fillStyle = g; c.fillRect(x, y, 16, 16);
    }
    const image = c.getImageData(0, 0, 128, 128);
    for (let i = 0; i < image.data.length; i += 4) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; const n = (seed >>> 28) - 8; for (let k = 0; k < 3; k++) image.data[i + k] += n; }
    c.putImageData(image, 0, 0);
  });
}
function noiseTexture(owned: Owned, seed: number) {
  return canvasTexture(owned, 64, 64, c => {
    const image = c.createImageData(64, 64);
    for (let i = 0; i < image.data.length; i += 4) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; const v = 100 + (seed >>> 26); image.data.set([v, v, v, 255], i); }
    c.putImageData(image, 0, 0);
  }, false);
}
/** Scales a geometry's UVs so a texture repeats every `size` metres on a face `w` × `h` metres. */
function tileUV(geometry: THREE.BufferGeometry, w: number, h: number, size: number) {
  const uv = geometry.getAttribute('uv'); if (!uv) return geometry;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w / size, uv.getY(i) * h / size);
  return geometry;
}

// Reference layout, measured from the front-view reference (wheel 0.29 m across): x right, y up, metres.
const BUTTONS: [x: number, y: number, color: string, label: string, dark?: boolean][] = [
  [-.089, .071, '#d8262d', 'PL'], [-.067, .067, '#25a244', 'DRS'], [-.068, .041, '#111315', '+1'], [-.067, .014, '#1f6fd6', 'BB'],
  [-.068, -.007, '#f2c418', 'HI', true], [-.068, -.028, '#f2c418', 'STR', true],
  [.068, .067, '#f39a1d', 'PIT', true], [.087, .071, '#1f6fd6', 'BOX'], [.067, .041, '#111315', '+10'], [.088, .045, '#d8262d', 'PC'],
  [.067, .014, '#e9ecee', 'N', true], [.067, -.007, '#f39a1d', 'FDR', true], [.067, -.028, '#e9ecee', 'BB+', true],
];
const ROTARIES: [x: number, y: number, color: string, label: string, small?: boolean][] = [
  [-.031, -.016, '#c6e62a', 'TYRE'], [.030, -.016, '#e8333a', 'ERS'], [0, -.019, '#b9c3c7', 'BAL', true],
  [-.045, -.057, '#f39a1d', 'DIFF'], [0, -.057, '#29c7c0', 'ENGINE'], [.045, -.057, '#2f7cf0', 'MODE'],
];

/** Mirror a shape's right half (x >= 0, listed top to bottom) into a closed symmetric outline. */
function symmetric(points: [number, number][]) {
  const shape = new THREE.Shape(); const all = [...points, ...[...points].reverse().map(([x, y]) => [-x, y] as [number, number])];
  shape.moveTo(...all[0]); for (const p of all.slice(1)) shape.lineTo(...p); shape.closePath(); return shape;
}
function smooth(points: [number, number][], divisions = 6) {
  const curve = new THREE.SplineCurve(points.map(([x, y]) => new THREE.Vector2(x, y)));
  return curve.getPoints(points.length * divisions).map(p => [p.x, p.y] as [number, number]);
}

export function buildFormulaCockpit(root: THREE.Object3D, wheel: THREE.Object3D, owned: Owned): FormulaCockpit {
  const add = (parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material, name: string) => {
    owned.geometries.push(geometry); const mesh = new THREE.Mesh(geometry, material); mesh.name = name; parent.add(mesh); return mesh;
  };
  const material = <T extends THREE.Material>(m: T) => { owned.materials.push(m); return m; };

  const carbonMap = carbonTexture(owned);
  const carbon = material(new THREE.MeshPhysicalMaterial({ map: carbonMap, roughness: .34, metalness: .05, clearcoat: .55, clearcoatRoughness: .22 }));
  const linerCarbon = material(new THREE.MeshPhysicalMaterial({ map: carbonMap, roughness: .5, metalness: .03, clearcoat: .3, clearcoatRoughness: .4, color: 0x34383c }));
  const satinCarbon = material(new THREE.MeshPhysicalMaterial({ map: carbonMap, roughness: .55, metalness: .03, clearcoat: .15, clearcoatRoughness: .5, color: 0xb8bcc0 }));
  const grain = noiseTexture(owned, 119);
  const rubber = material(new THREE.MeshStandardMaterial({ color: 0x141618, roughness: .82, bumpMap: grain, bumpScale: .0004 }));
  const metal = material(new THREE.MeshStandardMaterial({ color: 0x8a9196, roughness: .35, metalness: .85 }));
  const blackPlastic = material(new THREE.MeshStandardMaterial({ color: 0x0c0e0f, roughness: .45 }));
  const glovePanel = material(new THREE.MeshStandardMaterial({ color: 0x24272b, roughness: .78, bumpMap: grain, bumpScale: .0005 }));
  const gloveLogo = material(new THREE.MeshStandardMaterial({ color: 0x8d959b, roughness: .5, metalness: .3 }));
  const glove = material(new THREE.MeshStandardMaterial({ color: 0x17191c, roughness: .88, bumpMap: grain, bumpScale: .0006 }));
  const suit = material(new THREE.MeshStandardMaterial({ color: 0x1b2446, roughness: .92, bumpMap: grain, bumpScale: .0004 }));
  const suede = material(new THREE.MeshStandardMaterial({ color: 0x1f2a52, roughness: 1, bumpMap: grain, bumpScale: .0009 }));
  const strap = material(new THREE.MeshStandardMaterial({ color: 0x0f1012, roughness: .7 }));

  // ---- Steering wheel --------------------------------------------------------------------------
  // The wheel keeps the supplied model's pivot: hub at (0, -0.285, 0.519), just behind the chassis lip (y -0.21 at z 0.6).
  wheel.clear(); wheel.userData.steeringRatio = 4;
  // Rubber body: the whole outline including the grips, with the two hand slots cut through.
  const body = symmetric(smooth([[0, .094], [.112, .09], [.130, .074], [.138, .035], [.139, -.02], [.131, -.068], [.108, -.090], [.080, -.088], [.050, -.082], [0, -.080]], 5));
  for (const side of [-1, 1]) {
    const hole = new THREE.Path(); const pts = smooth([[.080, .022], [.098, .026], [.106, .0], [.104, -.045], [.090, -.060], [.080, -.050]], 5).map(([x, y]) => [x * side, y] as [number, number]);
    if (side < 0) pts.reverse();
    hole.moveTo(...pts[0]); pts.slice(1).forEach(p => hole.lineTo(...p)); hole.closePath(); body.holes.push(hole);
  }
  const rubberBody = new THREE.ExtrudeGeometry(body, { depth: .022, bevelEnabled: true, bevelThickness: .008, bevelSize: .007, bevelSegments: 4, curveSegments: 6 });
  rubberBody.translate(0, 0, -.008); add(wheel, rubberBody, rubber, 'apex-formula-grips');
  // Carbon faceplate on the driver's side, proud of the rubber.
  const plate = symmetric(smooth([[0, .097], [.114, .093], [.127, .077], [.118, .036], [.096, .030], [.078, .026], [.077, -.058], [.068, -.083], [0, -.085]], 4));
  const plateGeometry = new THREE.ExtrudeGeometry(plate, { depth: .006, bevelEnabled: true, bevelThickness: .0015, bevelSize: .0015, bevelSegments: 2, curveSegments: 6 });
  plateGeometry.translate(0, 0, -.0205);
  { const uv = plateGeometry.getAttribute('uv'); for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 30, uv.getY(i) * 30); }
  add(wheel, plateGeometry, carbon, 'apex-formula-carbon');
  const front = -.022; // faceplate front surface
  // Display bezel and the shift-light bar.
  const bezel = new RoundedBoxGeometry(.114, .080, .004, 2, .004); bezel.translate(0, .043, front - .0015); add(wheel, bezel, blackPlastic, 'apex-formula-bezel');
  const ledBar = new RoundedBoxGeometry(.104, .010, .004, 2, .003); ledBar.translate(0, .0855, front - .0015); add(wheel, ledBar, blackPlastic, 'apex-formula-ledbar');
  const ledCanvas = document.createElement('canvas'); ledCanvas.width = 512; ledCanvas.height = 32;
  const ledTexture = new THREE.CanvasTexture(ledCanvas); ledTexture.colorSpace = THREE.SRGBColorSpace; owned.textures.push(ledTexture);
  const leds = add(wheel, new THREE.PlaneGeometry(.098, .006), material(new THREE.MeshBasicMaterial({ map: ledTexture, toneMapped: false })), 'apex-formula-leds');
  leds.position.set(0, .0855, front - .0037); leds.rotation.y = Math.PI;
  // Buttons: metal collar and coloured cap.
  for (const [x, y, color] of BUTTONS) {
    const collar = new THREE.CylinderGeometry(.0094, .0098, .003, 24); collar.rotateX(Math.PI / 2); collar.translate(rx(x), y, front - .0012); add(wheel, collar, metal, 'apex-formula-button-collar');
    const cap = new THREE.CylinderGeometry(.0078, .0082, .005, 24); cap.rotateX(Math.PI / 2); cap.translate(rx(x), y, front - .004);
    add(wheel, cap, material(new THREE.MeshStandardMaterial({ color, roughness: .3, metalness: .05 })), 'apex-formula-button');
  }
  // Rotaries: recessed dark face, knurled knob with a white pointer (rings and numbers are on the decal).
  for (const [x, y, , , small] of ROTARIES) {
    const r = small ? .0075 : .0088;
    const face = new THREE.CircleGeometry(small ? .011 : .0185, 40); face.rotateY(Math.PI); face.translate(rx(x), y, front - .0003); add(wheel, face, blackPlastic, 'apex-formula-rotary-face');
    const knob = new THREE.CylinderGeometry(r * .92, r, .012, 32); knob.rotateX(Math.PI / 2); knob.translate(rx(x), y, front - .006); add(wheel, knob, rubber, 'apex-formula-knob');
    const pointer = new THREE.BoxGeometry(.0014, r * .9, .0012); pointer.translate(rx(x), y + r * .45, front - .0122);
    add(wheel, pointer, material(new THREE.MeshBasicMaterial({ color: 0xf2f4f4 })), 'apex-formula-pointer');
  }
  // Thumb encoders in the top corners, the small joystick, screws.
  for (const x of [-.112, .112]) {
    const encoder = new THREE.CylinderGeometry(.0115, .012, .011, 28); encoder.rotateX(Math.PI / 2); encoder.translate(rx(x), .075, front - .006); add(wheel, encoder, rubber, 'apex-formula-encoder');
    const cap = new THREE.CylinderGeometry(.006, .007, .004, 20); cap.rotateX(Math.PI / 2); cap.translate(rx(x), .075, front - .013); add(wheel, cap, blackPlastic, 'apex-formula-encoder-cap');
  }
  { const stick = new THREE.SphereGeometry(.0058, 16, 12); stick.translate(rx(-.089), .045, front - .006); add(wheel, stick, rubber, 'apex-formula-joystick'); }
  for (const [x, y] of [[-.104, .085], [.104, .085], [-.06, .088], [.06, .088], [-.075, -.07], [.075, -.07], [-.058, .052], [.058, .052], [-.058, -.004], [.058, -.004], [0, -.078]]) {
    const screw = new THREE.CylinderGeometry(.0018, .0018, .0012, 10); screw.rotateX(Math.PI / 2); screw.translate(rx(x), y, front - .0004); add(wheel, screw, metal, 'apex-formula-screw');
  }
  // Paddles behind the grips (seen through the hand slots) and the quick-release hub.
  for (const side of [-1, 1]) {
    const paddle = new RoundedBoxGeometry(.030, .078, .004, 2, .002); paddle.rotateZ(side * .08); paddle.translate(side * .092, -.012, .028); add(wheel, paddle, satinCarbon, 'apex-formula-paddle');
    const clutch = new RoundedBoxGeometry(.026, .034, .004, 2, .002); clutch.translate(side * .088, -.064, .036); add(wheel, clutch, satinCarbon, 'apex-formula-clutch');
  }
  { const hub = new THREE.CylinderGeometry(.020, .024, .05, 24); hub.rotateX(Math.PI / 2); hub.translate(0, 0, .045); add(wheel, hub, metal, 'apex-formula-hub'); }
  // Decal: button labels, dial numbers and coloured rings, drawn once.
  const W = .26, H = .20, PX = 4096 / W;
  const decalMap = canvasTexture(owned, 4096, Math.round(H * PX), c => {
    const at = (x: number, y: number) => [(x + W / 2) * PX, (H / 2 - y) * PX] as const;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    for (const [x, y, color, label, small] of ROTARIES) {
      const [px, py] = at(x, y), ring = (small ? .0098 : .0162) * PX, numbers = (small ? .0 : .0128) * PX;
      c.strokeStyle = color; c.lineWidth = (small ? .0012 : .0022) * PX;
      for (let i = 0; i < 12; i++) { const a0 = (-225 + i * 22.5 + 2) * Math.PI / 180, a1 = a0 + 18.5 * Math.PI / 180; c.beginPath(); c.arc(px, py, ring, a0, a1); c.stroke(); }
      if (!small) { c.fillStyle = '#e9eeee'; c.font = 'bold 22px Arial, sans-serif'; for (let i = 0; i < 12; i++) { const a = (-225 + i * 22.5 + 11) * Math.PI / 180; c.fillText(String(i + 1), px + Math.cos(a) * numbers * 1.0, py + Math.sin(a) * numbers * 1.0); } }
      c.fillStyle = '#e4e8e8'; c.font = `bold ${small ? 26 : 28}px Arial, sans-serif`; c.fillText(label, px, py - (small ? .0135 : .0205) * PX);
    }
  });
  // Printed on the faceplate 2.5 mm proud of it (polygon offset is unreliable with the reversed depth buffer).
  const decal = add(wheel, new THREE.PlaneGeometry(W, H), material(new THREE.MeshBasicMaterial({ map: decalMap, transparent: true, depthWrite: false, toneMapped: false })), 'apex-formula-decal');
  decal.position.z = front - .0025; decal.rotation.y = Math.PI;
  // Button legends sit just in front of the caps.
  const legendMap = canvasTexture(owned, 4096, Math.round(H * PX), c => {
    c.textAlign = 'center'; c.textBaseline = 'middle';
    for (const [x, y, , label, dark] of BUTTONS) { c.fillStyle = dark ? '#16181a' : '#f3f5f5'; c.font = `bold ${label.length > 2 ? 34 : 42}px Arial, sans-serif`; c.fillText(label, (x + W / 2) * PX, (H / 2 - y) * PX); }
  });
  const legends = add(wheel, new THREE.PlaneGeometry(W, H), material(new THREE.MeshBasicMaterial({ map: legendMap, transparent: true, depthWrite: false, toneMapped: false })), 'apex-formula-legends');
  legends.position.z = front - .0068; legends.rotation.y = Math.PI;

  // ---- Driver: gloves on the grips, sleeves, torso, thighs ---------------------------------------
  // One hand, built for the car's +X grip (the driver's left) and mirrored for the other.
  const tube = (points: [number, number, number][], radius: number, segments = 16) =>
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p))), segments, radius, 10, false);
  const wrists: { hand: THREE.Object3D; wrist: THREE.Vector3; elbow: THREE.Vector3; forearm: THREE.Mesh }[] = [];
  for (const side of [1, -1]) {
    const hand = new THREE.Group(); hand.name = 'apex-driver-hand'; hand.scale.x = side; wheel.add(hand);
    // Back of the hand faces the driver over the front of the grip (grip: |x| 0.110-0.145, z -0.016 to 0.022).
    const back = new THREE.SphereGeometry(1, 24, 16); back.scale(.030, .048, .016); back.rotateZ(-.30); back.translate(.130, -.004, -.036); add(hand, back, glovePanel, 'apex-glove');
    const palmSide = new THREE.SphereGeometry(1, 20, 14); palmSide.scale(.016, .046, .022); palmSide.rotateZ(-.30); palmSide.translate(.152, -.010, -.016); add(hand, palmSide, glove, 'apex-glove');
    // Silver brand strip across the back of the hand, as on race gloves.
    const logo = new THREE.BoxGeometry(.026, .0035, .002); logo.rotateZ(-.30); logo.translate(.128, .006, -.0515); add(hand, logo, gloveLogo, 'apex-glove-logo');
    // Fingers: knuckles along the top-outer edge of the hand, curling over the grip's outer edge to its back.
    [.034, .017, .000, -.017].forEach((y, i) => {
      const r = i === 3 ? .0078 : .0088, x = .150 + i * .004;
      add(hand, tube([[x - .012, y + .012, -.044], [x + .006, y + .006, -.034], [x + .016, y, -.006], [x + .010, y - .002, .024], [x - .014, y - .004, .034]], r, 18), glove, 'apex-glove-finger');
      const tip = new THREE.SphereGeometry(r, 10, 8); tip.translate(x - .014, y - .004, .034); add(hand, tip, glove, 'apex-glove-finger');
      const knuckle = new THREE.SphereGeometry(r * 1.12, 12, 10); knuckle.translate(x - .010, y + .011, -.043); add(hand, knuckle, glovePanel, 'apex-glove-knuckle');
    });
    // Thumb along the front of the faceplate edge, its tip by the upper buttons.
    add(hand, tube([[.120, .016, -.045], [.112, .030, -.043], [.106, .038, -.036]], .0105, 12), glove, 'apex-glove-thumb');
    { const tip = new THREE.SphereGeometry(.0105, 12, 10); tip.scale(1, 1, .8); tip.translate(.106, .038, -.036); add(hand, tip, glove, 'apex-glove-thumb'); }
    add(hand, tube([[.136, -.040, -.036], [.146, -.066, -.046]], .025, 8), glove, 'apex-glove-cuff');
    add(hand, tube([[.146, -.066, -.046], [.156, -.094, -.058]], .029, 8), suit, 'apex-driver-sleeve');
    // Forearm: a tapered sleeve from the wrist (turns with the wheel) to a fixed elbow, re-aimed every frame in pose().
    const forearm = add(root, new THREE.CylinderGeometry(.029, .036, 1, 18, 1, false), suit, 'apex-driver-forearm');
    wrists.push({ hand, wrist: new THREE.Vector3(.156, -.094, -.058), elbow: new THREE.Vector3(side * .152, -.42, .26), forearm });
    const elbow = new THREE.SphereGeometry(.036, 16, 12); elbow.translate(side * .152, -.42, .26); add(root, elbow, suit, 'apex-driver-elbow');
    add(root, tube([[side * .152, -.42, .26], [side * .157, -.38, .10], [side * .158, -.32, -.04]], .040, 12), suit, 'apex-driver-upper-arm');
    // Thigh from the hip up to the knee under the chassis top.
    add(root, tube([[side * .075, -.44, -.02], [side * .072, -.432, .22], [side * .066, -.425, .47]], .046, 14), suit, 'apex-driver-thigh');
  }
  { const torso = new THREE.SphereGeometry(1, 28, 18); torso.scale(.14, .09, .16); torso.translate(0, -.385, .0); add(root, torso, suit, 'apex-driver-torso'); }
  for (const side of [1, -1]) add(root, tube([[side * .095, -.30, -.10], [side * .085, -.30, .06], [side * .040, -.35, .15]], .009, 12), strap, 'apex-driver-harness');

  // ---- Tub: carbon liner over the side walls, front bulkhead, suede rim padding --------------------
  for (const side of [1, -1]) {
    // Kept below the rim, which drops to y -0.23 towards the front of the opening.
    const wall = tileUV(new THREE.BoxGeometry(.004, .22, .80), .80, .22, .05); wall.translate(side * .158, -.355, .14); add(root, wall, linerCarbon, 'apex-tub-liner');
    // Headrest wings beside the helmet: mostly behind the eye, so only their front ends show at the edges of view.
    const pad = new RoundedBoxGeometry(.05, .045, .34, 3, .016); pad.translate(side * .19, -.15, -.12); add(root, pad, suede, 'apex-rim-pad');
    const sidePad = new RoundedBoxGeometry(.03, .14, .22, 3, .012); sidePad.translate(side * .14, -.30, -.17); add(root, sidePad, suede, 'apex-seat-pad');
  }
  { const bulkhead = tileUV(new THREE.BoxGeometry(.29, .26, .004), .29, .26, .06); bulkhead.translate(0, -.34, .548); add(root, bulkhead, satinCarbon, 'apex-tub-bulkhead'); }
  { const column = new THREE.CylinderGeometry(.013, .013, .04, 16); column.rotateX(Math.PI / 2); column.translate(0, -.286, .565); add(root, column, metal, 'apex-steering-column'); }

  // Helmet, HANS collar and shoulders for the T-cam. Head centred round the cockpit eye (0, -0.135, 0.149).
  const helmet = new THREE.Group(); helmet.name = 'apex-driver-helmet'; root.add(helmet);
  const helmetMap = canvasTexture(owned, 512, 256, c => {
    // Generic team-style livery on an equirectangular map: navy shell, red crown band, yellow stripes. Not any real driver's design.
    c.fillStyle = '#1a2650'; c.fillRect(0, 0, 512, 256);
    c.fillStyle = '#d6232f'; c.fillRect(0, 0, 512, 54);
    c.fillStyle = '#f4c21b'; c.fillRect(0, 54, 512, 10); c.fillRect(0, 150, 512, 8);
    c.fillStyle = '#d6232f'; for (const x of [96, 352]) { c.beginPath(); c.moveTo(x - 60, 64); c.lineTo(x + 60, 64); c.lineTo(x + 20, 150); c.lineTo(x - 20, 150); c.closePath(); c.fill(); }
    c.fillStyle = '#e8ecef'; c.font = 'bold 30px Arial, sans-serif'; c.textAlign = 'center'; c.fillText('APEX', 128, 120); c.fillText('APEX', 384, 120);
  });
  const shell = material(new THREE.MeshPhysicalMaterial({ map: helmetMap, roughness: .25, clearcoat: 1, clearcoatRoughness: .08 }));
  const visorMaterial = material(new THREE.MeshPhysicalMaterial({ color: 0x0b0d10, roughness: .05, metalness: .6, clearcoat: 1 }));
  { const g = new THREE.SphereGeometry(1, 40, 28); g.scale(.128, .14, .155); g.rotateY(Math.PI); g.translate(0, -.085, .115); add(helmet, g, shell, 'apex-driver-helmet-shell'); }
  { const g = new THREE.SphereGeometry(1, 32, 16, -Math.PI * .32, Math.PI * .64, Math.PI * .40, Math.PI * .17); g.scale(.131, .143, .158); g.translate(0, -.085, .115); add(helmet, g, visorMaterial, 'apex-driver-helmet-visor'); }
  { const g = new THREE.CylinderGeometry(.075, .095, .07, 24); g.translate(0, -.215, .085); add(helmet, g, strap, 'apex-driver-hans'); }
  { const g = new THREE.SphereGeometry(1, 28, 16); g.scale(.20, .065, .11); g.translate(0, -.27, .04); add(helmet, g, suit, 'apex-driver-shoulders'); }
  // Merge parts that share a material into one draw call per material (the cockpit has ~130 small pieces).
  for (const parent of [wheel, root, ...wrists.map(w => w.hand)]) mergeByMaterial(parent, owned);
  const driver: THREE.Object3D[] = [];
  root.traverse(o => { if (/^apex-(glove|driver)/.test(o.name)) driver.push(o); });
  for (const o of driver) o.visible = false;
  helmet.visible = false;
  const wrist = new THREE.Vector3(), axis = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  return {
    pose() {
      wheel.updateMatrix();
      for (const arm of wrists) {
        wrist.copy(arm.wrist); wrist.x *= arm.hand.scale.x; wrist.applyMatrix4(wheel.matrix);
        axis.subVectors(arm.elbow, wrist); const length = axis.length();
        arm.forearm.position.copy(wrist).addScaledVector(axis, .5);
        arm.forearm.quaternion.setFromUnitVectors(up, axis.normalize());
        arm.forearm.scale.set(1, length, 1);
      }
    },
    setDriverVisible(visible, showHelmet) { for (const o of driver) o.visible = visible; helmet.visible = visible && showHelmet; },
    paintLeds(fraction) {
      const c = ledCanvas.getContext('2d')!; c.fillStyle = '#050607'; c.fillRect(0, 0, 512, 32);
      const lit = Math.round(Math.min(1, Math.max(0, (fraction - .55) / .4)) * 15), flash = fraction > .97;
      for (let i = 0; i < 15; i++) {
        const on = flash || i < lit, color = flash ? '#7a5cff' : i < 5 ? '#34f06f' : i < 10 ? '#ff3640' : '#3d7dff';
        c.fillStyle = on ? color : '#1a1e22'; c.beginPath(); c.arc(17 + i * 34, 16, 11, 0, Math.PI * 2); c.fill();
        if (on) { c.fillStyle = 'rgba(255,255,255,.55)'; c.beginPath(); c.arc(17 + i * 34 - 3, 13, 4, 0, Math.PI * 2); c.fill(); }
      }
      ledTexture.needsUpdate = true;
    },
  };
}

/**
 * Merges a parent's untransformed child meshes that share a material (and a name group) into one mesh each.
 * Parts here are positioned by translating their geometry, so most children have identity transforms;
 * anything with its own transform (display, decals, the forearms re-aimed every frame) is left alone.
 */
function mergeByMaterial(parent: THREE.Object3D, owned: Owned) {
  const groups = new Map<string, THREE.Mesh[]>();
  for (const child of parent.children) {
    const mesh = child as THREE.Mesh;
    // Forearms are re-aimed every frame in pose(), so they must stay separate meshes.
    if (!mesh.isMesh || mesh.name === 'apex-driver-forearm' || Array.isArray(mesh.material) || !mesh.matrix.equals(new THREE.Matrix4()) || !mesh.position.equals(new THREE.Vector3()) || mesh.rotation.x || mesh.rotation.y || mesh.rotation.z || !mesh.scale.equals(new THREE.Vector3(1, 1, 1))) continue;
    // Driver parts keep their own group so they can be hidden together.
    const key = `${mesh.material.uuid}|${/^apex-(glove|driver)/.test(mesh.name) ? 'driver' : 'car'}`;
    const list = groups.get(key) ?? []; list.push(mesh); groups.set(key, list);
  }
  for (const meshes of groups.values()) {
    if (meshes.length < 2) continue;
    const sources = meshes.map(m => { const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone(); for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name); if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2)); return g; });
    const merged = mergeGeometries(sources); sources.forEach(g => g.dispose());
    if (!merged) continue;
    const first = meshes[0], mesh = new THREE.Mesh(merged, first.material); mesh.name = first.name;
    owned.geometries.push(merged); parent.add(mesh);
    for (const m of meshes) { parent.remove(m); m.geometry.dispose(); owned.geometries.splice(owned.geometries.indexOf(m.geometry), 1); }
  }
}
