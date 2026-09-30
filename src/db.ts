import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Repeatable, ordered schema migrations. Each migration runs inside a
 * transaction and records its row in schema_migrations; re-running applies
 * nothing. Database file always lives inside the project directory.
 */
const MIGRATIONS: { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: "initial",
    sql: `
CREATE TABLE scenarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  gain REAL NOT NULL,
  tau REAL NOT NULL,
  ts REAL NOT NULL,
  delay_steps INTEGER NOT NULL,
  u_min REAL NOT NULL,
  u_max REAL NOT NULL,
  setpoint REAL NOT NULL,
  y0 REAL NOT NULL,
  max_samples INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario_id INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  kp REAL NOT NULL,
  ki REAL NOT NULL,
  kd REAL NOT NULL,
  td_filter REAL NOT NULL,
  anti_windup TEXT NOT NULL,
  tt REAL NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running',
  stop_reason TEXT,
  loop_state TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(scenario_id, label)
);
CREATE TABLE disturbances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario_id INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  start_step INTEGER NOT NULL,
  end_step INTEGER,
  amplitude REAL NOT NULL
);
CREATE TABLE setpoint_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario_id INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  step INTEGER NOT NULL,
  setpoint REAL NOT NULL
);
CREATE TABLE samples (
  version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  step INTEGER NOT NULL,
  setpoint REAL NOT NULL,
  measurement REAL NOT NULL,
  error REAL NOT NULL,
  p REAL NOT NULL,
  i REAL NOT NULL,
  d REAL NOT NULL,
  demand REAL NOT NULL,
  control REAL NOT NULL,
  disturbance REAL NOT NULL,
  PRIMARY KEY (version_id, step)
);
CREATE TABLE reports (
  version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  tolerance_band REAL NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (version_id, tolerance_band)
);
CREATE TABLE idempotency_keys (
  key TEXT PRIMARY KEY,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_samples_version_step ON samples(version_id, step);
CREATE INDEX idx_versions_scenario ON versions(scenario_id);
`,
  },
];

export function openDatabase(filePath: string): DatabaseSync {
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  return db;
}

export function migrate(db: DatabaseSync, now: () => string): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);");
  const timestamp = () => {
    const value = now();
    return typeof value === "string" ? value : new Date(value).toISOString();
  };
  for (const migration of MIGRATIONS) {
    const applied = db
      .prepare("SELECT id FROM schema_migrations WHERE id = ?")
      .get(migration.id) as { id: number } | undefined;
    if (applied) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(migration.id, migration.name, timestamp());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

/** Run a unit of work in a transaction that rolls back on any thrown error. */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
