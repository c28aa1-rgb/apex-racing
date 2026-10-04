import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import type { Run } from '../shared/replay';
import { PHYSICS_VERSION } from '../shared/physics';

export const schema = `
CREATE TABLE IF NOT EXISTS players (
  id UUID PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, nickname VARCHAR(18) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS scores (
  id UUID PRIMARY KEY, player_id UUID NOT NULL REFERENCES players(id), track_id TEXT NOT NULL,
  track_version INTEGER NOT NULL, physics_version TEXT NOT NULL, car_id TEXT NOT NULL, time_ms INTEGER NOT NULL CHECK(time_ms > 0),
  inputs JSONB NOT NULL, steering JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(player_id, track_id, track_version, physics_version)
);
CREATE INDEX IF NOT EXISTS scores_ranking ON scores(track_id, track_version, physics_version, time_ms, created_at);
CREATE TABLE IF NOT EXISTS circuit_config (
  key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;
export type Row = Record<string, unknown>;
export class Store {
  private database: PGlite | pg.Pool;
  constructor(url?: string, directory?: string) {
    this.database = url ? new pg.Pool({ connectionString: url, max: 5 }) : new PGlite(directory);
  }
  async query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = this.database instanceof PGlite ? await this.database.query(sql, params) : await this.database.query(sql, params);
    return result.rows as T[];
  }
  async init() {
    // Separate statements are compatible with both PostgreSQL and embedded PGlite.
    for (const statement of schema.split(';').filter(s => s.trim())) await this.query(statement);
    // Existing local installations predate selectable cars. Old scores live in a
    // different physics partition, but the default keeps their rows readable.
    await this.query("ALTER TABLE scores ADD COLUMN IF NOT EXISTS car_id TEXT NOT NULL DEFAULT 'porsche-911-gt3'");
    // Preserve the per-tick steering tuner alongside keys. Legacy runs have no
    // tuner samples and retain the simulation's original 100% replay default.
    await this.query('ALTER TABLE scores ADD COLUMN IF NOT EXISTS steering JSONB');
    await this.query('ALTER TABLE scores ADD COLUMN IF NOT EXISTS drift JSONB');
    await this.query('ALTER TABLE scores ADD COLUMN IF NOT EXISTS manual BOOLEAN');
  }
  async createPlayer(nickname: string) {
    const id = randomUUID(), token = randomBytes(32).toString('hex');
    await this.query('INSERT INTO players(id,token_hash,nickname) VALUES($1,$2,$3)', [id, this.hash(token), nickname]);
    return { id, token, nickname };
  }
  private hash(token: string) { return createHash('sha256').update(token).digest('hex'); }
  async player(token: string) {
    return (await this.query<{ id: string; nickname: string }>('SELECT id,nickname FROM players WHERE token_hash=$1', [this.hash(token)]))[0];
  }
  async rename(id: string, nickname: string) { await this.query('UPDATE players SET nickname=$2 WHERE id=$1', [id, nickname]); }
  async save(playerId: string, run: Run) {
    const rows = await this.query(`INSERT INTO scores(id,player_id,track_id,track_version,physics_version,car_id,time_ms,inputs,steering,drift,manual)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11)
      ON CONFLICT(player_id,track_id,track_version,physics_version) DO UPDATE
      SET car_id=EXCLUDED.car_id, time_ms=EXCLUDED.time_ms, inputs=EXCLUDED.inputs, steering=EXCLUDED.steering, drift=EXCLUDED.drift, manual=EXCLUDED.manual, created_at=NOW()
      WHERE EXCLUDED.time_ms < scores.time_ms RETURNING id`,
    [randomUUID(), playerId, run.trackId, run.trackVersion, run.physicsVersion, run.carId, run.timeMs, JSON.stringify(run.inputs), run.steering ? JSON.stringify(run.steering) : null,run.drift?JSON.stringify(run.drift):null,run.manual??null]);
    return { improved: rows.length > 0 };
  }
  async leaderboard(trackId: string, version: number) {
    return this.query(`SELECT s.id, p.id AS "playerId", p.nickname, s.car_id AS "carId", s.time_ms AS "timeMs", s.manual,
      ROW_NUMBER() OVER (ORDER BY s.time_ms, s.created_at, s.id)::integer AS rank
      FROM scores s JOIN players p ON p.id=s.player_id
      WHERE s.track_id=$1 AND s.track_version=$2 AND s.physics_version=$3
      ORDER BY s.time_ms,s.created_at,s.id LIMIT 50`, [trackId, version, PHYSICS_VERSION]);
  }
  async replay(id: string) {
    const row = (await this.query(`SELECT track_id AS "trackId", track_version AS "trackVersion",
      physics_version AS "physicsVersion", car_id AS "carId", time_ms AS "timeMs", inputs, steering, drift, manual FROM scores WHERE id=$1`, [id]))[0];
    if (row?.steering == null && row) delete row.steering;
    if(row?.drift==null&&row)delete row.drift;
    if(row?.manual==null&&row)delete row.manual;
    return row;
  }
  async circuitConfig() {
    return (await this.query<{ value: unknown }>('SELECT value FROM circuit_config WHERE key=$1', ['shared']))[0]?.value ?? { starts: {}, finishes: {}, roads: {}, maps: {}, cockpits: {} };
  }
  async saveCircuitConfig(value: unknown) {
    await this.query(`INSERT INTO circuit_config(key,value) VALUES($1,$2::jsonb)
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`, ['shared', JSON.stringify(value)]);
    return value;
  }
  async close() { if (this.database instanceof PGlite) await this.database.close(); else await this.database.end(); }
}
