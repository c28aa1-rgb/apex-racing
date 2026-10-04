# Party Verification

Verified September 29, 2026.

- `npm run build`: passed.
- `node --import tsx --test tests/party.test.ts`: all four tests passed, including the empty DELETE request regression.
- Track asset checks: all seven cleaned runtime models passed geometry and material validation.
- Browser checks: two independent identities created/joined a lobby, synchronized car choices and host settings, copied the code, left successfully, and transferred hosting. The new host changed circuit, weather, and laps; the other client displayed the same values read-only.
- Navigating to Time trials and back preserved membership. The Bugatti track rendered successfully.
- Desktop rendering: eight actual cars loaded into separate bays. Camera dragging changed 17,165 sampled scene pixels. Screenshots contained hundreds of distinct scene color buckets, not a blank canvas.
- Mobile rendering: checked at 390px wide, with no horizontal page overflow. Four spaces and the wrapped settings bar are visible; eight spaces use a taller scrollable layout. Temporary viewport overrides were reset.
- Design proofs: `PARTY-DESKTOP.png`, `PARTY-ORBIT.png`, and `PARTY-MOBILE.png`.

## Remaining Limits

- The broader `tests/api.test.ts` replay test returns 422 instead of 201: its replay does not complete every checkpoint and finish. Party tests do not depend on that replay.
- The original local database cannot start because its WAL and control file identify different database systems. Its files and existing backup directories remain preserved. Development currently uses `DATA_DIR=work/party-preview-db`.
- Lobbies are transient and belong to one API process. They are not globally hosted. Race starting and network simulation are intentionally absent.
