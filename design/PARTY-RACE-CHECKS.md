# Party race verification

Checked September 30, 2026.

- All seven circuits have eight non-overlapping starting footprints. The saved first position and heading are preserved.
- `design/build-party-grids.ts` validates the full 2.5 by 6.1 footprint against collision surfaces. All seven circuits passed.
- All seven grids were visually inspected on the actual track models. Screenshots are `design/party-grid-*.png`. Daytona uses a shallow stagger within the narrow paved lane containing its saved start.
- Two independent browser identities created/joined a lobby, loaded their selected cars, started together, and received live driving and checkpoint-recovery updates. Host cancellation returned both to the lobby.
- Desktop race HUD was visually checked. Mobile spacing was adjusted after an earlier overlap was found, but the final browser viewport override did not apply; that final mobile layout remains unverified.
- Ten focused tests passed: `node --import tsx --test tests/party.test.ts tests/party-race.test.ts tests/cockpit-config.test.ts`. These cover eight participants, shared readiness/countdown, progress validation, ownership, capacity, disconnection, results, and saved configuration.
- Production build and TypeScript checks passed. A complete multi-lap course was not manually driven to completion in the browser; lap progression and results were checked at the server level.

## Deliberate limits

Racing is casual, client-authoritative, and non-contact. Party races award no REP and never submit to the solo leaderboard. Clients need access to the same running API; a localhost URL alone cannot connect another device.

The preview uses `work/party-preview-db`; the original database remains untouched. Dependency versions were preserved while restoring local dependency files outside cloud-managed Desktop storage. See the README for details.
