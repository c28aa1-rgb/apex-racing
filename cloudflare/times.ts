import { z } from 'zod';
import { runSchema } from '../shared/replay-schema';
import { DT, PHYSICS_VERSION } from '../shared/physics-version';
import { trackById } from '../shared/tracks';
import { CONE_PENALTY_MS } from '../shared/lot';

type Player = { id: string; nickname: string };
const fail = (statusCode: number, message: string): never => { throw Object.assign(new Error(message), { statusCode }); };
export async function savePlayer(db: D1Database, player: Player) {
  await db.prepare('INSERT INTO players(id,nickname) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET nickname=excluded.nickname').bind(player.id, player.nickname).run();
}
async function leaderboard(db: D1Database, trackId: string, version: number) {
  const { results } = await db.prepare(`SELECT s.id, s.player_id AS playerId, p.nickname, s.car_id AS carId, s.time_ms AS timeMs,
    json_extract(s.replay,'$.manual') AS manual,
    ROW_NUMBER() OVER (ORDER BY s.time_ms,s.created_at,s.id) AS rank
    FROM scores s JOIN players p ON p.id=s.player_id
    WHERE s.track_id=? AND s.track_version=? AND s.physics_version=?
    ORDER BY s.time_ms,s.created_at,s.id LIMIT 50`).bind(trackId, version, PHYSICS_VERSION).all();
  return results.map(row => ({ ...row, manual: row.manual === 1, verified: false }));
}
/** Casual records only. The Node backend retains full physics replay verification. */
export async function times(request: Request, db: D1Database, player?: Player, payload?: unknown) {
  const path = new URL(request.url).pathname;
  const board = path.match(/^\/api\/leaderboards\/([^/]+)$/);
  if (board && request.method === 'GET') {
    const track = trackById(board[1]);
    if (!track || track.kind === 'lot') fail(404, 'Track not found.');
    return Response.json({ entries: await leaderboard(db, track!.id, track!.version), verified: false });
  }
  const replay = path.match(/^\/api\/replays\/([^/]+)$/);
  if (replay && request.method === 'GET') {
    const id = z.uuid().parse(replay[1]);
    const row = await db.prepare('SELECT replay FROM scores WHERE id=?').bind(id).first<{ replay: string }>();
    if (!row) fail(404, 'Replay not found.');
    return Response.json(JSON.parse(row!.replay));
  }
  if (path === '/api/runs' && request.method === 'POST' && player) {
    const parsed = runSchema.safeParse(payload);
    if (!parsed.success) fail(422, 'This run is invalid or from an older game version. Reload and try again.');
    const run = parsed.data!, track = trackById(run.trackId);
    if (!track || track.kind === 'lot' || track.version !== run.trackVersion) fail(422, 'Track version is no longer supported. Start a new run.');
    const ticksTime = Math.round(run.inputs.length * DT * 1000), penalty = run.timeMs - ticksTime;
    if (penalty < 0 || (track!.kind === 'cones' ? penalty % CONE_PENALTY_MS !== 0 : penalty !== 0)) fail(422, 'Submitted time does not match the recorded duration.');
    if (run.origin) {
      const zone = track!.lot?.startZone;
      if (track!.kind !== 'cones' || !zone || Math.abs(run.origin.x-zone.x)>zone.w/2 || Math.abs(run.origin.z-zone.z)>zone.l/2) fail(422, 'The run does not start inside the start box.');
    }
    const result = await db.batch([
      // Existing signed sessions can predate the database. Never let an old token undo a nickname change.
      db.prepare('INSERT OR IGNORE INTO players(id,nickname) VALUES(?,?)').bind(player.id, player.nickname),
      db.prepare(`INSERT INTO scores(id,player_id,track_id,track_version,physics_version,car_id,time_ms,replay,created_at)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(player_id,track_id,track_version,physics_version) DO UPDATE
        SET car_id=excluded.car_id,time_ms=excluded.time_ms,replay=excluded.replay,created_at=excluded.created_at
        WHERE excluded.time_ms < scores.time_ms`).bind(crypto.randomUUID(), player.id, run.trackId, run.trackVersion, run.physicsVersion, run.carId, run.timeMs, JSON.stringify(run), Date.now())
    ]);
    return Response.json({ improved: result[1].meta.changes > 0, timeMs: run.timeMs, verified: false, entries: await leaderboard(db, run.trackId, run.trackVersion) }, { status: 201 });
  }
  return Response.json({ error: 'Endpoint not found.' }, { status: 404 });
}
