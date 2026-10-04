# Validation

## Current changes — September 13, 2026

See [the current track/handling report](work/track-cleanup/REPORT.md) for physics v24: subtle automatic rear slip, speed/load-dependent Left Shift drift, all-eight track cleanup, road-overlay depth correction and contact-aware visual wheel attachment. Road smoothing permits takeoff rather than pinning unloaded tires to the floor. The build, 1,584-scenario handling matrix, model integrity checks, all-car takeoff/landing tests and wheel-attachment browser checks pass. Full suite: 65 passed; the four older Indianapolis lap-dependent tests remain unresolved.

## Historical changes — September 11, 2026

- Physics v14 retains the progressive low/high-speed steering curve and adds a non-solid, model-projected wheel-support skin along the authored racing lane. A saved developer drive trace replaces the older lane for this support as well as the minimap; custom grids receive a short smooth run-up. Wheel suspension uses the continuous skin on-lane while the chassis, barriers, grass, runoff and other contacts continue to come from visible venue geometry.
- Suspension stiffness was reduced from 25 to 19 and compression/relaxation damping increased to 11.5/13. The renderer no longer applies average wheel travel to the entire car a second time; grounded vertical, horizontal and tilt motion are low-pass filtered independently. In a 59–83 mph browser run this reduced visible vertical second-difference RMS to 0.000334 and primary visible tilt RMS to 0.000315, with no lost-contact frames.
- Eighteen focused contact/handling checks pass, including all source-GLB asphalt probes, all-car contact, smooth-support starts, a custom pre-route grid launch, sustained smooth support down the default Bugatti straight, steering behavior and deterministic imported-mesh physics.
- Collision binaries remain direct derivatives of every optimized, rendered GLB. An attempted collision-mesh reduction was rejected because independent asphalt probes detected gaps below four venues; exact visible triangles and Rapier internal-edge correction remain enabled.
- Independent source-GLB asphalt probes cover 741 points across the eight circuits, including pit-lane materials. Opaque surfaces must match collision within 4 cm; transparent asphalt-joint decals allow a supporting floor up to 20 cm below. These are sampled checks, not a claim of exhaustive inspection of every triangle.
- All nine cars maintain four-wheel contact while accelerating on Bugatti's starting straight. High-speed tap and direction-reversal steering tests pass. Start elevation is reconciled with nearby physical floor; saved horizontal placements are not overwritten.
- Headless Chrome loaded all four new cars with embedded textures, verified drag-orbit movement and both directions of the V camera toggle, and reported no page errors. Screenshots are in `work/*-garage.png`, `work/garage-rotated.png`, `work/chase-camera.png`, and `work/first-person-camera.png`.
- First-person is an unobstructed driver-height camera, with the exterior mesh hidden; it does not render a full cockpit interior.
- Player-facing speed, circuit distance, vehicle weight, acceleration, top-speed, braking, flip-limit and help labels use mph, miles, pounds and feet. Internal SI values remain canonical for deterministic physics and replay validation.
- Indianapolis now defaults to the infield road course (route, start, finish and five checkpoints taken from a recorded lap, `INDIANAPOLIS_LAYOUT` in `shared/track-routes.ts`). The test driver completes it with no respawns, and the full suite passes (108 of 108). The earlier oval route and its barrier workarounds were removed.
- Tire grip for anonymously named mixed-surface texture atlases is still material-level, not texture-pixel-level. Extensive human handling tests and full laps on each venue remain recommended.

## Historical validation (before the current collision replacement)

Validated after moving the complete project to the Desktop folder.

- Production TypeScript and Vite builds pass.
- Ten automated tests pass, including all authored courses, recorded-input replay validation, exact repeated simulation snapshots, distinct car setups, progressive pedal input, upward road winding, checkpoint order, fall and manual recovery, malformed or forged submissions, database reopen/persistence, anonymous credentials, ranking upserts, and the production worker.
- All six supplied GLB cars load in the browser garage and the selected model carries onto the track with the correct scale and forward orientation. Five files contain embedded image textures; the Porsche 911 uses its embedded PBR material values without image maps.
- All eight supplied circuit GLBs load in the selector. Their road-aligned collision ribbons, continuous edge barriers, off-road terrain, invisible timing gates, calibrated real-distance scale, and per-circuit starting transforms are shared by gameplay and replay validation.
- The road and curb triangle winding is verified upward, fixing the top surface being culled while preserving the shared render/collision ribbon through turns.
- Browser physics exactly matches every reference position and rotation generated on Node: Coastline (972 ticks), Highline (1,108 ticks), Switchback (1,072 ticks).
- A 150-frame Three.js chase-camera benchmark measured 60 average FPS and 95 draw calls on the test machine's in-app browser. This is a local measurement, not a guarantee for all hardware.
- Browser interaction checks covered track selection, race countdown, Escape pause, instant restart, checkpoint recovery, nickname save, leaderboard empty state, and return to track selection.
- The leaderboard API responds successfully after relocation with its persistent database intact.
- The production dependency audit reports zero known vulnerabilities.

The game is running locally. Public hosting and a hosted PostgreSQL deployment were not performed. Chrome/Edge-wide hardware coverage and extensive human handling playtests remain useful before a public release. Test leaderboards use isolated temporary databases; no fabricated competing scores were added to the delivered leaderboard.
