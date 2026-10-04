# Trailer Shot Director

Run the Vite development server and open `/dev/trailer`. The route is development-only and does not start the racing simulation, leaderboard or party session.

Choose a shot, circuit, lead car and 1-4 cars. Supporting cars use a fixed GT/street roster. The cars follow scripted paths with animated wheels and brake lamps; they are cinematic actors, not opponents running a physics simulation.

Use Play/Pause, Reset, Step and the timeline to inspect a take. Playback speed supports 1x, 0.5x and 0.25x. The same timeline position restores the same actor and camera poses.

The route slider follows the dev menu's saved driven path (`maps` in the circuit configuration), not the original timing guide. Both **Drive & record route** and **Drive checkpoints** save paths for the director. Reload recorded routes after recording a new drive. Tracks without a recorded path have motion and route scrubbing disabled. Recordings are also backed up in the browser used to record them; the race-control server shares them across local ports and browsers. Open paths stop at their endpoints. Routes with a teleport-sized gap are rejected.

The initial view uses Moving pack and starts playback when a recorded route is available. The Action menu offers Moving pack, Approach each other, Pull apart, Overtake, Launch and Parked. Expand each car to adjust its start/end speeds, direction, starting gap, start/end lane and launch delay. Camera Follow chooses the subject. Shot duration is adjustable from 2 to 30 seconds. These are independently controlled cinematic actors; opposing cars need separate lanes to pass without intersecting.

Day, Sunset, Night and Moon set the hour. Sun/moon cycle advances the hour with shot time and is repeatable on reset. Exposure, bloom, fog distance, weather and headlights can be tuned separately. Lights illuminate geometry; there is no volumetric beam simulation. Sun and moon cast local shadows. Night reflections use the existing environment map at reduced intensity.

The eye button hides every control. H or Escape restores them; tapping the viewport also restores them on touch devices. Space toggles playback when focus is outside an input. Fullscreen is available from the transport bar.

Download saves a JSON take recipe including all car motion settings; Upload restores it. This saves staging and lighting, not video. Use a screen recorder for footage once the shots have been approved. HyperFrames assembly and soundtrack timing remain a separate step.

## Shot Presets

- Low tracking: parked pack at Bugatti, moving low camera.
- Starting grid: parked formation with a rear camera.
- Launch sweep: accelerating scripted pack at sunset.
- Curb drift: staged yaw and a close roadside camera at Marina Bay.
- Pack chase: elevated tracking view at Marina Bay.
- Wheel close-up: front wheel detail and brake lamps.
- Barrier overtake: second car moves out and passes the lead.
- Finish orbit: slow-moving pack with an orbiting camera.

The existing circuits remain the locations. This does not add a free-roam city, traffic, bridge jumps, tire smoke, hot brake rotors or new engine audio. Those require separate assets or effects once the intended takes are selected.

## Verification

`node --import tsx --test tests/trailer.test.ts`

`GAME_URL=http://127.0.0.1:5173 node tests/trailer-browser.mjs`

Browser checks inject test-only routes and write still screenshots to `work/trailer-checks`; they do not overwrite saved recordings or record video.
