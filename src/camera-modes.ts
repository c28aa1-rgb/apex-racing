/** Race camera views, in the order the camera key cycles through them. */
export const CAMERA_MODES = ['chase', 'far', 'bumper', 'cockpit', 'tv', 'drone'] as const;
export type CameraMode = typeof CAMERA_MODES[number];
export const CAMERA_LABELS: Record<CameraMode, string> = { chase: 'Chase', far: 'Far chase', bumper: 'Bumper', cockpit: 'Cockpit', tv: 'TV', drone: 'Drone' };
export const CAMERA_HELP: Record<CameraMode, string> = {
  chase: 'Close behind, swings wide through corners.',
  far: 'Higher and further back. Easier to read the road ahead.',
  bumper: 'Low on the nose. The fastest sense of speed.',
  cockpit: 'From the driver seat, with working instruments.',
  tv: 'Trackside long-lens shots that cut as you pass.',
  drone: 'High above and behind. Best for reading a cone course.',
};
export type CameraOptions = { fov: number; distance: number; shake: boolean; recenter: boolean };
