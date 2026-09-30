import type { DatabaseSync } from 'node:sqlite';

/**
 * Idempotent migrations. Every statement uses IF NOT EXISTS / CREATE TABLE IF
 * NOT EXISTS semantics, so applying the whole set repeatedly is safe and is the
 * mechanism used at startup and after a restart.
 */
export const MIGRATIONS: { id: number; sql: string }[] = [
  {
    id: 1,
    sql: `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plants (
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  config_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (name, version)
);
CREATE TABLE IF NOT EXISTS controllers (
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  config_json TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (name, version)
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  config_json TEXT NOT NULL,
  state_json TEXT NOT NULL,
  iae REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  failure_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS samples (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  k INTEGER NOT NULL,
  sp REAL NOT NULL,
  y REAL NOT NULL,
  error REAL NOT NULL,
  p_term REAL NOT NULL,
  i_term REAL NOT NULL,
  d_term REAL NOT NULL,
  v_unsat REAL NOT NULL,
  u_command REAL NOT NULL,
  u_applied REAL NOT NULL,
  load REAL NOT NULL,
  saturated INTEGER NOT NULL,
  iae REAL NOT NULL,
  PRIMARY KEY (run_id, k)
);
CREATE INDEX IF NOT EXISTS idx_samples_run_k ON samples(run_id, k);
CREATE TABLE IF NOT EXISTS run_op_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  op TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  at_sample INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runop_run ON run_op_log(run_id, id);
`,
  },
];

export function applyMigrations(db: DatabaseSync, now: () => number): void {
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);',
  );
  for (const m of MIGRATIONS) {
    const row = db.prepare('SELECT id FROM schema_migrations WHERE id = ?').get(m.id) as
      | { id: number }
      | undefined;
    if (row) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations(id, applied_at) VALUES (?, ?)').run(
        m.id,
        now(),
      );
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
