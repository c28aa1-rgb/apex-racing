# Multiplayer backends

Live frontend: https://c28aa1-rgb.github.io/apex-racing/

Production backend: https://apex-multiplayer.c28aa1-rgb.workers.dev

Cloudflare D1 database: `apex-times`, bound as `TIMES`. The public site stores casual best times and replay inputs here. Leaderboards show the top 50 and retain only each driver's fastest time per track, track version, and physics version. These times are explicitly unverified: the Worker checks session ownership, payloads, versions, and input duration, but does not replay physics or prove checkpoints were completed. The existing Node backend still verifies full physics replays. Career REP and personal bests remain on the device. Anonymous identities are device-specific; keep browser storage to keep posting under the same driver.

The database was created and initialized through the connected Cloudflare plugin. For subsequent deployments, apply migrations before publishing the Worker:

```sh
npx wrangler d1 migrations apply apex-times --remote
npm run deploy:cloudflare
```

`npm run dev:cloudflare` applies the same migrations to the local D1 database before starting. The database credentials stay inside Cloudflare bindings; the browser only calls the Worker API. D1 prepared statements and atomic batches protect score ownership and faster-only updates. Existing local Node scores are not imported into this new casual leaderboard.

Source repository: https://github.com/c28aa1-rgb/apex-racing

`main` pushes run `.github/workflows/pages.yml` and publish the frontend. Run `npm run build:pages` to produce the same artifact locally. Deployment excludes personal soundtrack files and original model backups; runtime models and licensed effects remain included. Original models stay in the local project for asset regeneration and tests that inspect source GLBs. Those source-model tests require the delivered local assets after cloning. Backend updates use Wrangler separately; log in to the configured account before deploying.

Node remains the default. Its HTTP party API and database-backed solo features remain available. Cloudflare runs private race rooms with native WebSockets and one SQLite-backed Durable Object per six-character room code. Both backends use `shared/party-room.ts` and the existing `PartyLobby`, `PartyRace`, and `PartyPose` types.

## Run Node locally

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:5173. The existing `npm run dev:lan`, `npm run build`, and `npm start` commands still work. If the old local database has the WAL problem already described in the README, use the existing preview database:

```sh
DATA_DIR=work/party-preview-db npm run dev
```

Stop the development servers before switching modes. Use independent browser profiles or the `127.0.0.1` and `localhost` frontend addresses for separate driver identities.

## Run Cloudflare locally

No Cloudflare login or account is required for this local workflow:

```sh
npm ci
cp .dev.vars.example .dev.vars
npm run dev:cloudflare
```

Open http://127.0.0.1:5173. Vite serves the frontend, and Wrangler runs the backend at http://127.0.0.1:8787. Create a lobby, join its code in a second browser profile, and start the race. Cloudflare mode does not require Node or its database. Node-only leaderboard, replay verification, and circuit editor APIs are unavailable unless a separate Node API is provided.

`.env.cloudflare` selects the backend for this command. `.dev.vars` is ignored by Git and provides the local signing secret. The example secret is for local tests only.

## Switch backend

Vite reads configuration at startup or build time. Set these in `.env.local`, your shell, or the frontend build environment:

```dotenv
VITE_MULTIPLAYER_BACKEND=node
```

or:

```dotenv
VITE_MULTIPLAYER_BACKEND=cloudflare
VITE_MULTIPLAYER_URL=http://127.0.0.1:8787
```

Production uses an **HTTPS** backend URL. The client derives `wss://` automatically and rejects insecure backend URLs when the frontend uses HTTPS. `VITE_MULTIPLAYER_URL` is the backend origin, without `/api` or a room path. Do not put secrets in `VITE_*` variables; these values are public.

In Node mode, `VITE_API_URL` optionally points solo, leaderboard, and party requests at a separately hosted Node API. Such an API must accept your frontend origin through its own deployment proxy/CORS configuration. Leaving it unset preserves the existing same-origin `/api` workflow. Cloudflare mode sends player, time, leaderboard, and replay requests to `VITE_MULTIPLAYER_URL`.

Node and Cloudflare driver sessions have separate browser storage keys. Cloudflare room membership is remembered per tab in session storage. Switching modes requires no game-code edits.

## Deploy Cloudflare

Create a Cloudflare account and choose its Workers subdomain under **Workers & Pages**. Set `ALLOWED_ORIGINS` in `wrangler.jsonc` to your exact frontend origin, for example `https://YOUR_USERNAME.github.io`. Origins contain no repository path or trailing slash. Multiple origins are comma-separated. Keep localhost entries only if you want local frontends to connect to production.

From this directory:

```sh
npx wrangler login
npx wrangler whoami
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
npx wrangler secret put SESSION_SECRET
npm run deploy:cloudflare
```

Paste the generated random value at Wrangler's secret prompt. Do not use the local example secret in production. For multiple accounts, add your account ID to `wrangler.jsonc` or export `CLOUDFLARE_ACCOUNT_ID` before deployment. CI can use `CLOUDFLARE_API_TOKEN` with Workers deployment permissions instead of interactive login.

Wrangler creates the Worker, `RACE_ROOMS` binding, and SQLite Durable Object class through migration `v1`. The `apex-times` D1 database is already created and configured in `wrangler.jsonc`; apply its SQL migrations before deploying changes. Room objects are created on demand. Do not remove or rename an applied migration. The rate limiter uses namespace `1001`; choose another positive integer if an existing Worker in your account already uses that namespace for unrelated limits.

Use the HTTPS `workers.dev` URL printed by Wrangler as `VITE_MULTIPLAYER_URL`. Optional custom domains can be configured in the Cloudflare dashboard. Check the dashboard for deployment logs and usage; local tests do not verify your account's deployed bindings or origin settings.

The implementation follows Cloudflare's [WebSocket hibernation guidance](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), [SQLite-backed free-plan support](https://developers.cloudflare.com/durable-objects/platform/pricing/), and [native rate-limit bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

## GitHub Pages frontend

Build with the public Worker origin. For a repository site at `https://YOUR_USERNAME.github.io/YOUR_REPOSITORY/`:

```sh
VITE_MULTIPLAYER_BACKEND=cloudflare \
VITE_MULTIPLAYER_URL=https://apex-multiplayer.YOUR_SUBDOMAIN.workers.dev \
npx vite build --base=/YOUR_REPOSITORY/
```

For a user site or custom domain at its root, use `--base=/`. Publish `dist/` through your GitHub Pages deployment workflow, and select **GitHub Actions** as the Pages source in repository settings. Runtime models, collision files, artwork, credits, and fonts use Vite's base path. The Node server is not required to host this frontend.

If `.env.local` overrides these variables, remove the conflicting values or use explicit shell variables as shown above. A frontend rebuild is required after changing backend configuration.

## Protocol and lifecycle

Node keeps the existing authenticated HTTP endpoints. Cloudflare creates and joins rooms through HTTP, then sends the same party operations through a native WebSocket as `{id, path, method, body}`. Replies use `{id, data}` or `{id, error, status}`. Push events carry lobby snapshots or compact race snapshots; the transport merges race snapshots with the stored grid/checkpoints/finish. The game still receives the existing complete race type.

Each ready driver sends fresh poses at a target of 30 Hz (approximately 34 ms browser timer spacing), independently of replies and the 60 Hz physics/render loop. At most six race requests are outstanding; congestion skips a send rather than queuing old poses. Loading drivers check readiness at 2 Hz. Poses include optional linear velocity; legacy clients without it remain accepted. Deploy the updated Worker before publishing the frontend: older Workers reject the velocity field and their 30-message-per-second limit is too tight for the new cadence plus other commands. Node permits 2,400 race requests per driver per minute. The new cadence sends roughly 50% more poses than 20 Hz.

Remote cars use timed cubic interpolation with a 50-250 ms buffer adapting to smoothed delivery age, delivery variation, and half the sender spacing. The buffer grows promptly during jitter and shrinks as delivery recovers, rather than retaining an old worst-case delay. Server-clock corrections are limited to 0.5 ms per accepted reply after initialization so asymmetric jitter cannot jump the playback timeline. Prediction is limited to 100 ms beyond the newest pose, then holds. Speed and elapsed time distinguish normal high-speed gaps from respawns. This deliberately trades a small display delay for smoother motion; it does not reduce Internet round-trip latency or make collisions server-authoritative.

Cloudflare coalesces ordinary driving broadcasts over 10 ms and serializes each room snapshot once for all sockets. Unchanged grid/checkpoint data is excluded. Each sender gets an immediate reply; all drivers receive the batched push. Membership, readiness, and finish changes still broadcast immediately. The one-shot broadcast timer only exists while updates arrive and stops with idle traffic.

Signed anonymous sessions expire after 30 days. WebSocket authentication uses a subprotocol header rather than a token in the URL. Payload schemas reject unknown fields, invalid cars/settings, non-finite transforms, bad progress, and oversized messages. Host permissions and room capacity use the same shared rules as Node. Connection attempts are limited to 60 per minute per source IP, and sockets allow at most 40 messages per second. The IP limit can affect many users sharing one public IP; increase it for large LAN events.

### Room placement

`RACE_ROOM_LOCATION_HINT` in `wrangler.jsonc` defaults to `auto`, allowing Cloudflare to place new rooms near their initiating host request. Operators can set a supported hint (`wnam`, `enam`, `sam`, `weur`, `eeur`, `apac`, `apac-ne`, `apac-se`, `oc`, `afr`, or `me`) after measuring their players' connections. Invalid configuration returns a service error instead of silently selecting a different policy. The hint applies only to room creation; joins and reconnects preserve the same room identity.

Hints are best-effort, only affect the first instantiation, and do not relocate existing rooms. `/api/health` reports the configured `roomPlacement` policy, not the room's actual physical location. Follow Cloudflare's [Durable Object data-location guidance](https://developers.cloudflare.com/durable-objects/reference/data-location/). Before this change, the inspected production Worker had no explicit placement override; no production configuration was changed during local testing.

Room metadata is saved on membership/settings/start/readiness/finish changes and disconnects. Ordinary pose packets stay in memory and socket attachments, avoiding per-pose storage writes. The Hibernation API restores the last accepted pose and presence of each connected driver after a wake. Alarms expire stale members and stop when the room is empty; there is no continuously running room timer.

A brief network interruption can reconnect within the existing 20-second racing grace period. After that, a disconnected racer is DNF. Lobby membership expires after two minutes without successful activity. Closing a tab follows the same grace period; explicit Leave removes the member immediately. Empty rooms delete their stored state. A host can reopen an ended race to reuse the room. Loading and race duration limits remain three minutes and one hour.

## Test

```sh
npm run test:multiplayer
npm run check:cloudflare
npm test
npm run build
```

The focused suite starts a real local Wrangler process with isolated temporary storage. It verifies native WebSocket upgrades, two-way pose delivery, independent rooms, capacity, host permissions, invalid messages/origins, reconnects, leaving, and empty-room cleanup. Node checks exercise the original HTTP API and shared race rules. Tests require no Cloudflare account and use an available port automatically.

With either local backend running, exercise two actual browser drivers and simulate per-direction latency/jitter:

```sh
GAME_URL=http://127.0.0.1:5173 NETWORK_DELAY_MS=40 NETWORK_JITTER_MS=30 \
  node tests/party-sync-browser.mjs
node --import tsx --test tests/party-network.test.ts
```

The browser script writes desktop/mobile screenshots and `diagnostics.json` under `work/party-network` (override with `SHOTS`). It checks shared lights, standings, fresh poses, bounded requests, send spacing, and positional delay. In a development browser console, `window.__apex.multiplayerDiagnostics()` reports RTT and send-gap p50/p95, FPS, remote arrival/delivery timing, missing sequences, buffer/playback age, prediction/hold frames, and teleport resets. Missing sequences can result from batching or skipped sends, not just network loss. The deterministic test additionally covers high-speed curved motion, delayed bursts, omitted poses, stalled connections, respawns, and legacy poses.

### Local tuning results

An eight-driver local Worker test acknowledged 320 poses at 20 Hz and 480 poses at 30 Hz over two seconds each, with reply p95 about 22 ms in both profiles. All drivers received the latest poses and remained connected; a separate flood above 40 messages per second was rejected. These timings include the test's acknowledgement polling and are not production ping measurements.

With two real browsers and simulated 40 ms one-way delay plus up to 30 ms jitter, send-gap p95 was 36 ms, RTT p50 about 95 ms, and remote playback age about 208-213 ms versus 250-257 ms in the earlier 20 Hz run using the same delay profile. Rendering held 60 FPS, no requests failed, and no teleport resets occurred. Results are saved in `work/party-latency/after/diagnostics.json`; they are local measurements, not a guarantee for real Internet connections. Deterministic tests also check buffer recovery within two seconds after a short slowdown and bounded sends with 150 ms replies.

## Limits and next improvement

- Driving and finish claims remain client-authoritative, as in the existing game. These races do not qualify for replay-verified leaderboards.
- Cloudflare uses the checked-in grid/checkpoint/finish layouts. It does not replicate the Node database or development circuit edits.
- Membership is per room and remembered per browser tab. There is no global account/membership directory preventing one identity from joining rooms in separate tabs.
- Hibernation retains socket attachments, but an abrupt process/deployment failure can lose recent transient poses. Metadata survives; reconnecting drivers may resume from the latest metadata checkpoint.
- Local Wrangler and browser tests cannot establish production latency, free-tier capacity, or deployment-failure recovery. Test a deployed room from two real devices before public release.

The next useful measurement is a deployed room on two real devices, including a full lobby. Use the diagnostics to distinguish network delay from low rendering FPS before changing transports or adding authoritative physics, rollback, matchmaking, or rankings.
