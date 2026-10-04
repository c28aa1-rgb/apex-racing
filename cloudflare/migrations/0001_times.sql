CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL CHECK(length(nickname) BETWEEN 2 AND 18)
);
CREATE TABLE IF NOT EXISTS scores (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(id),
  track_id TEXT NOT NULL,
  track_version INTEGER NOT NULL,
  physics_version TEXT NOT NULL,
  car_id TEXT NOT NULL,
  time_ms INTEGER NOT NULL CHECK(time_ms > 0),
  replay TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(player_id, track_id, track_version, physics_version)
);
CREATE INDEX IF NOT EXISTS scores_ranking ON scores(track_id, track_version, physics_version, time_ms, created_at, id);
