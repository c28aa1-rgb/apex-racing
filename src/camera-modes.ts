/** Race camera views, in the order the camera key cycles through them. */
export const CAMERA_MODES = ['chase', 'far', 'hood', 'cockpit', 'tcam', 'drone'] as const;
export type CameraMode = typeof CAMERA_MODES[number];
export const CAMERA_LABELS: Record<CameraMode, string> = { chase: 'Chase', far: 'Far chase', hood: 'Hood', cockpit: 'Cockpit', tcam: 'T-cam', drone: 'Drone' };
export const CAMERA_HELP: Record<CameraMode, string> = {
  chase: 'Close behind, swings wide through corners.',
  far: 'Higher and further back. Easier to read the road ahead.',
  hood: 'Just above the bonnet, looking over it. Fast and clear.',
  cockpit: 'From the driver seat, with working instruments.',
  tcam: 'Just behind the driver\'s helmet, over the halo. Formula car only.',
  drone: 'High above and behind. Best for reading a cone course.',
};
/** Views that only exist on some cars: the T-cam sits on the F1 car's airbox. */
const CAR_ONLY: Partial<Record<CameraMode, string[]>> = { tcam: ['red-bull-rb19'] };
/** The views a car offers, in cycle order. */
export const cameraModesFor = (carId: string) => CAMERA_MODES.filter(mode => CAR_ONLY[mode]?.includes(carId) ?? true);
export type CameraOptions = { fov: number; distance: number; shake: boolean; recenter: boolean };
