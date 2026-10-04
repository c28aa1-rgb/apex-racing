# APEX Racing

Frontend deployment target: [GitHub Pages](https://c28aa1-rgb.github.io/apex-racing/). Publication awaits repository push access. Multiplayer runs on Cloudflare Workers and Durable Objects. Pushes to `main` deploy the frontend automatically.

A playable browser racer with seven imported real-world circuits, eleven selectable cars, a Rapier physics vehicle, instant restarts, drifting, medals, personal and online ghosts, and a replay-verified leaderboard. See `VALIDATION.md` for current checks and known route-test limitations.

## Play locally

Requires Node.js 22.12+ (tested on Node 25.8). From this folder:

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:5173. Dependencies are already installed in this delivered folder. On macOS, **Start Game.command** also starts the development servers. Keep its terminal open while playing; Control-C stops both servers.

| Control | Action |
|---|---|
| W / Up | Progressive acceleration |
| S / Down | Progressive braking, then reverse at a stop |
| A D / Left Right | Smooth, speed-sensitive steering |
| Left Shift | Hold for extra drift; strength increases with speed and steering |
| R | Restart immediately |
| C | Recover at the last checkpoint; time continues |
| Escape | Pause / resume |
| Enter | Start a race |
| G / M | Toggle ghost / sound |
| V | Toggle chase / driver-height first-person camera |
| F | Flip upright below 16 mph |

In the garage, drag across the car to orbit horizontally and change viewing elevation. Rotation buttons and Reset view are also available. First-person mode uses the modeled cockpit and detected driver-seat position; `/dev` provides per-car camera adjustments. Interior detail and visibility depend on the supplied model.

Pass the timing checkpoints in order and complete the lap. Each checkpoint is painted across the asphalt as a teal band and the finish as a checkered line. Their triggers are measured from the venue's collision mesh and span the whole drivable width between barriers, including grass and run-off, so no line past a marking can miss it (`shared/gates.ts`). Finish times and best input replays are saved on this device, and the best one races alongside you as the personal ghost (G toggles it). Custom layouts recorded in `/dev` keep their own personal best and ghost, keyed to that exact start, checkpoint and finish layout. Choose a nickname to submit a run. Leaderboard ghost buttons let you race another driver's verified run. Losing browser storage loses the anonymous identity; there is no account recovery or cross-device sign-in.

## Parties

Two backends are available: the existing Node HTTP API (default), and Cloudflare Workers + one Durable Object per room with native WebSockets. See [multiplayer setup, testing, and deployment](docs/multiplayer.md) for exact commands and configuration.

The **Party** tab opens a 3D parking paddock. Create a lobby or join with its six-character code, then choose your car. The host controls circuit, weather, laps (1-99), and capacity (2-8). Other drivers see these settings and everyone's car and name. The host starts the race; all drivers load before a shared countdown. Each driver gets a distinct starting slot, sees the other cars and names, and races the selected number of laps. The host can cancel or return everyone to the lobby after results.

Lobby state is shared by clients connected to the same API process, refreshing every two seconds while the party is open. Driving updates run at up to 10 Hz, with interpolated remote cars. This is casual, client-authoritative, non-contact racing: cars pass through one another, finish times use server receipt time, and party races never award career REP or enter verified leaderboards. A loading session times out after three minutes; running races have a one-hour limit. Disconnected racers become DNF after 20 seconds without presence. Lobby members expire after two minutes. Leaving transfers hosting to the next driver. Refreshing and reopening Party restores a running driver's last position and progress. In Node mode, all lobbies disappear when the API restarts, and multiple Node instances require shared party storage. Cloudflare mode isolates rooms in Durable Objects and preserves metadata through hibernation.

Run focused checks with `node --import tsx --test tests/party.test.ts tests/party-race.test.ts`. Grid data lives in `shared/party-grids.ts`. With the API running, `node --import tsx design/build-party-grids.ts` rebuilds all eight-slot layouts and checks 2.5 m by 6.1 m footprints against the collision geometry. Inspect markings and barriers at `/tests/grid-inspection.html`. Moving a saved first start invalidates the party grid until it is rebuilt and visually checked. Daytona uses a shallow stagger because its saved start is on a narrow lane.

The development-only `/tests/party-driving.html` page adds a three-second throttle button for repeatable checks through the real keyboard, physics, and network path. To test independent local driver identities, use `127.0.0.1:5173` and `localhost:5173`. Remote devices need a reachable deployment of the same app/API; a localhost link does not work on another device.

**Same Wi-Fi test:** on the host Mac run `DATA_DIR=work/party-preview-db npm run dev:lan`, find its address with `ipconfig getifaddr en0`, and open `http://<that address>:5173` on every device. Vite listens on all interfaces and proxies `/api` to the local API, so only port 5173 must be reachable. Each browser keeps its own driver identity.

Local dependency note (October 3): installing Wrangler and Workers types created a normal local `node_modules` installation and updated the lockfile. The prior dependency cache and `node_modules.cloud-backup-20260930` remain available.

Local database note (September 28): the existing `work/leaderboard-db` cannot start because its WAL and control file identify different database systems. Its files and existing backup directories were preserved. The current preview API uses the separate `work/party-preview-db` directory. To use that preview database with the normal development command, run `DATA_DIR=work/party-preview-db npm run dev` after stopping the current servers. This is not a recovery of the old leaderboard.

## Build and verify

```sh
npm test
npm run build
npm start
```

The production server serves both the built client and API at http://127.0.0.1:3001. `npm test` includes circuit contact, steering, replay, API and persistence checks. The legacy full-lap driver currently fails at a visible tire barrier on Indianapolis; see `VALIDATION.md`. Run `node --import tsx --test tests/contact.test.ts` for the focused surface/handling/car checks.

Rebuild physical track geometry from the shipped rendering GLBs with `npm run build:collisions`. The output uses the `APEXCOL2` binary format and per-triangle surface labels. Run this before `npm run build` after replacing a track model. Hard surfaces, grass and gravel provide wheel-specific traction, independent of the minimap or traced route. Anonymous materials are audited against their embedded textures; mixed asphalt/grass texture atlases still use material-level classification rather than pixel-level grip.

`npm run build:tracks` rebuilds all seven cleaned runtime venues and their collisions. The supplied `*.glb` files remain intact; `*.race.glb` retains the earlier runtime texture source, and the renderer uses the new `*.clean.glb` files. Cleanup removes degenerate and exact duplicate faces, preserves thin road/scenery detail, and tags non-solid foliage and road overlays for stable rendering. See `work/track-cleanup/REPORT.md` for the handling and model audit.

To check browser/Node compatibility and rendering:

```sh
npm run test:browser:fixtures
npm run dev
```

Open http://127.0.0.1:5173/tests/browser.html and select **Run browser checks**. It compares browser simulation against the Node reference replay, then measures 150 rendered frames. These test files and diagnostic hooks are excluded from the production build.

## Architecture

- **Client:** Three.js renderer and an independent fixed 60 Hz game loop. React and Framer Motion handle the garage, menus, race HUD, dialogs, and results. Detailed GLB vehicles are normalized and compatible static pieces are merged at load time to reduce draw calls. The camera follows with an upright horizon and look-ahead; reduced-motion preferences remove camera orbit and FOV spectacle.
- **Performance:** The renderer uses a reversed depth buffer (logarithmic depth only where `EXT_clip_control` is missing), so the GPU can reject hidden pixels early. Shaders, geometry and textures for the whole venue, car, ghost and start lights are uploaded during loading rather than on first sight mid-race. Each layout's static physics world is built once and later restarts, ghosts and replays restore a Rapier snapshot of it (bit-identical, about ten times faster). Audio is prepared while the menu is idle. Profile with `tests/frame-profile-browser.mjs`.
- **Simulation:** pinned Rapier WASM version, rigid chassis and four raycast wheels. Each car changes mass, drive layout, engine force, speed curve, drag, downforce, tire grip, steering lock, and braking. Keyboard pedals and steering ramp progressively. A small amount of rear slip builds naturally at speed; Left Shift enables larger slides based on road speed and actual wheel lock. Releasing Shift, lifting or braking restores grip. The in-race tuning panel allows steering from 70–200% and drift amount from 0–200%; both values are recorded per physics tick for deterministic replays. Tracks, car tuning, input bit masks, ordered checkpoint checks, and recovery all live in `shared/`. The browser and validation worker import the same implementation.
- **Tracks:** The supplied GLBs are the visible venues and the source for physical triangle meshes, with internal-edge contact correction. Imported tracks no longer use invisible route ribbons as a floor. Route segments supply timing gates and fallback diagrams; `/dev` supplies placement and route-recording tools. Collision geometry is independent of those diagrams. Transparent decals and foliage helpers are excluded from solid geometry; visible barriers remain solid.
- **API:** Fastify, hashed anonymous bearer tokens, request limits, strict schemas, one bounded validation worker and a short queue. Scores are accepted only when the server simulation reaches the finish after every checkpoint and computes exactly the submitted time. The client cannot supply authoritative positions.
- **Database:** PostgreSQL through `DATABASE_URL`, or persistent PGlite (Postgres WASM) at `work/leaderboard-db` for local use. Parameterized SQL is shared between both. One process owns the local database; stop the server gracefully before moving or backing it up.

Each board is partitioned by track ID, track version, and physics version. There is one best score per driver per partition. Equal/slower re-submissions cannot replace a faster score. Physics and track changes must bump their versions; old local ghosts are ignored and old leaderboard partitions are kept separate.

The replay validator proves that an input stream is physically achievable. It does not prove that the inputs were produced by a human, prevent tool-assisted play, or enforce real wall-clock racing. This is a casual competitive board, not an esports anti-cheat system. Pauses freeze simulation time. Runs are limited to five minutes.

## API

| Method / path | Behavior |
|---|---|
| GET `/api/health` | Database health and physics version |
| GET `/api/tracks` | Track metadata and versions |
| POST `/api/players` | Create anonymous identity from `{ nickname }`; returns ID and token |
| PUT `/api/players/me` | Rename authenticated driver |
| GET `/api/leaderboards/:trackId` | Current-version top 50, one best time per driver |
| POST `/api/runs` | Authenticate, validate full input replay, store improved score |
| GET `/api/replays/:id` | Fetch a ranked replay for ghost racing |
| GET `/api/parties/current` | Authenticated lobby snapshot and presence heartbeat |
| POST `/api/parties` | Create lobby with `{ carId, settings? }` |
| POST `/api/parties/join` | Join with `{ code, carId }` |
| PATCH `/api/parties/me` | Choose own car with `{ carId }` |
| PATCH `/api/parties/settings` | Host-only changes to trackId, weather, laps, maxPlayers |
| DELETE `/api/parties/me` | Leave current lobby |
| POST `/api/parties/start` | Host-only race creation with a frozen grid and course |
| POST `/api/parties/race` | Authenticated readiness/pose exchange with `{ raceId, ready, pose? }` |
| POST `/api/parties/reopen` | Host-only cancellation or return to lobby |

Authenticated requests use `Authorization: Bearer <token>`. A run contains `trackId`, `trackVersion`, `physicsVersion`, `carId`, integer `timeMs`, and one integer input bit mask per fixed tick. Masks use throttle=1, brake/reverse=2, left=4, right=8, drift=16, checkpoint recovery=32, and flip=64. The limit is 18,000 input ticks.

## Hosting

This delivery runs locally; it has not been published to the internet. Deploy the Node service and PostgreSQL together behind HTTPS. Set `DATABASE_URL`, `HOST=0.0.0.0`, and your platform's `PORT`; run `npm ci`, `npm run build`, then `npm start`. The server initializes its two tables and ranking index at startup. Configure database backups in the hosting provider. A split static client deployment must proxy `/api` to this service.

The embedded local database is intended for a single-process local server. Use hosted PostgreSQL for multiple server instances. Public deployment, accounts and live multiplayer are not enabled. The local `/dev` editor should not be exposed publicly without access control.

## Design assets

The custom **Coastal Circuit** theme and **Coastal Precision** design philosophy are in `design/`. Circuit cards are in `public/art/`; regenerate them with `npm run art`. Imported track and vehicle attribution is recorded alongside the models in `public/models/`.

Track and vehicle models supplied by the project owner are stored in `public/models/`; attribution is kept alongside the assets and linked from the garage. The four added vehicles are the Ferrari 488 GT3, McLaren 720S GT3, Bugatti Bolide Concept, and Peugeot 9X8. The Chevrolet SS is no longer selectable; its source file and credit are retained for recovery. The Porsche 963, Skyline, Bolide and Peugeot source metadata specifies CC BY-NC-SA; review those licenses before commercial distribution. New vehicle performance values are game-tuning estimates. Big Shoulders and Instrument Sans are self-hosted with their OFL licenses in `public/fonts/`.

Rapier's cross-platform determinism requires identical versions, initialization and step order: https://rapier.rs/docs/user_guides/javascript/determinism/
