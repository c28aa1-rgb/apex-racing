import { motion, useReducedMotion } from 'framer-motion';
import { CAMERA_LABELS, CAMERA_MODES, type CameraMode } from './camera-modes';

const OUTER = 150, INNER = 62, SIZE = OUTER * 2 + 20, C = SIZE / 2;
const point = (radius: number, angle: number) => [C + Math.sin(angle) * radius, C - Math.cos(angle) * radius];

/** One ring segment centred on `angle` (radians clockwise from the top). */
function segment(angle: number, half: number) {
  const gap = .025, a = angle - half + gap, b = angle + half - gap;
  const [x1, y1] = point(OUTER, a), [x2, y2] = point(OUTER, b), [x3, y3] = point(INNER, b), [x4, y4] = point(INNER, a);
  return `M${x1} ${y1}A${OUTER} ${OUTER} 0 0 1 ${x2} ${y2}L${x3} ${y3}A${INNER} ${INNER} 0 0 0 ${x4} ${y4}Z`;
}

/** Radial camera picker shown while the camera key is held. Move the mouse toward a view and release the key. */
export function CameraWheel({ current, pick, keyHint, onPick }: { current: CameraMode; pick?: CameraMode; keyHint: string; onPick: (mode: CameraMode) => void }) {
  const still = useReducedMotion();
  const step = Math.PI * 2 / CAMERA_MODES.length;
  return <motion.div className="camera-wheel" role="listbox" aria-label="Choose camera"
    initial={{ opacity: 0, scale: still ? 1 : .9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: still ? 1 : .95 }} transition={{ duration: still ? 0 : .14 }}>
    <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE}>
      <circle className="camera-wheel-hub" cx={C} cy={C} r={INNER - 6} />
      {CAMERA_MODES.map((mode, i) => {
        const angle = i * step, [lx, ly] = point((OUTER + INNER) / 2, angle);
        return <g key={mode} role="option" aria-selected={pick === mode} className={`camera-wheel-slice${pick === mode ? ' picked' : ''}${current === mode ? ' current' : ''}`} onPointerDown={() => onPick(mode)}>
          <path d={segment(angle, step / 2)} />
          <text x={lx} y={ly} textAnchor="middle" dominantBaseline="middle">{CAMERA_LABELS[mode]}</text>
        </g>;
      })}
    </svg>
    <div className="camera-wheel-centre"><strong>{CAMERA_LABELS[pick ?? current]}</strong><small>{pick ? `Release ${keyHint}` : 'Move the mouse'}</small></div>
  </motion.div>;
}
