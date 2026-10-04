import type { Track, Vec3 } from './tracks';

export type RoadPoint = {
  center: Vec3; left: Vec3; right: Vec3; forward: Vec3;
  distance: number; segment: number; width: number;
};
export type RoadMesh = { points: RoadPoint[]; vertices: Float32Array; indices: Uint32Array };

const horizontal = (value: Vec3): Vec3 => {
  const length = Math.hypot(value.x, value.z) || 1;
  return { x: value.x / length, y: 0, z: value.z / length };
};
const add = (a: Vec3, b: Vec3, scale = 1): Vec3 => ({ x: a.x + b.x * scale, y: a.y + b.y * scale, z: a.z + b.z * scale });
const mix = (a: Vec3, b: Vec3, t: number): Vec3 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
const length = (a: Vec3, b: Vec3) => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
const unit = (a: Vec3, b: Vec3): Vec3 => { const n = length(a, b) || 1; return { x: (b.x-a.x)/n, y: (b.y-a.y)/n, z: (b.z-a.z)/n }; };
const quadratic = (a: Vec3, control: Vec3, b: Vec3, t: number): Vec3 => {
  const one = 1 - t;
  return { x: one*one*a.x + 2*one*t*control.x + t*t*b.x, y: one*one*a.y + 2*one*t*control.y + t*t*b.y, z: one*one*a.z + 2*one*t*control.z + t*t*b.z };
};

/**
 * Builds a sampled, tangent-continuous road ribbon. Each hard editor corner is
 * replaced by a quadratic bend and the straight runs are subdivided. Renderer
 * and physics consume the same points, so rounded corners cannot reveal seams.
 */
export function buildRoadMesh(track: Track): RoadMesh {
  const authored = [track.segments[0].start, ...track.segments.map(segment => segment.end)];
  const samples: Array<{ center: Vec3; segment: number; width: number }> = [];
  const append = (center: Vec3, segment: number, width: number) => {
    const previous = samples.at(-1)?.center;
    if (previous && length(previous, center) < .001) return;
    samples.push({ center, segment, width });
  };
  const appendLine = (from: Vec3, to: Vec3, segment: number, width: number) => {
    const steps = Math.max(1, Math.ceil(length(from, to) / 7));
    for (let step = 1; step <= steps; step++) append(mix(from, to, step / steps), segment, width);
  };

  let cursor = authored[0];
  append(cursor, 0, track.segments[0].width);
  for (let index = 1; index < authored.length - 1; index++) {
    const corner = authored[index], incoming = unit(authored[index - 1], corner), outgoing = unit(corner, authored[index + 1]);
    const radius = Math.min(15, length(authored[index - 1], corner) * .22, length(corner, authored[index + 1]) * .22);
    const entry = add(corner, incoming, -radius), exit = add(corner, outgoing, radius);
    const previousWidth = track.segments[index - 1].width, nextWidth = track.segments[index].width;
    appendLine(cursor, entry, index - 1, previousWidth);
    const dot = Math.max(-1, Math.min(1, incoming.x*outgoing.x + incoming.y*outgoing.y + incoming.z*outgoing.z));
    const steps = Math.max(4, Math.ceil(radius * Math.max(.35, Math.acos(dot)) / 2.6));
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      append(quadratic(entry, corner, exit, t), t < .5 ? index - 1 : index, previousWidth + (nextWidth - previousWidth) * t);
    }
    cursor = exit;
  }
  appendLine(cursor, authored.at(-1)!, track.segments.length - 1, track.segments.at(-1)!.width);

  const points: RoadPoint[] = [];
  let distance = 0;
  samples.forEach((sample, index) => {
    if (index) distance += length(samples[index - 1].center, sample.center);
    const before = samples[Math.max(0, index - 1)].center, after = samples[Math.min(samples.length - 1, index + 1)].center;
    const forward = horizontal({ x: after.x - before.x, y: 0, z: after.z - before.z });
    const right = { x: forward.z, y: 0, z: -forward.x };
    points.push({
      ...sample, forward, distance,
      left: add(sample.center, right, -sample.width / 2),
      right: add(sample.center, right, sample.width / 2)
    });
  });
  const vertices = new Float32Array(points.length * 6);
  points.forEach((point, index) => vertices.set([point.left.x,point.left.y,point.left.z,point.right.x,point.right.y,point.right.z], index * 6));
  const indices = new Uint32Array((points.length - 1) * 6);
  for (let index = 0; index < points.length - 1; index++) {
    const vertex = index * 2;
    indices.set([vertex,vertex+2,vertex+1,vertex+1,vertex+2,vertex+3], index * 6);
  }
  return { points, vertices, indices };
}

export function interpolateRoad(point: RoadPoint, across: number, lift = 0): Vec3 {
  return { x: point.left.x + (point.right.x-point.left.x)*across, y: point.left.y + (point.right.y-point.left.y)*across + lift, z: point.left.z + (point.right.z-point.left.z)*across };
}
