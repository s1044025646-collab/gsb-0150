import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '../core/errors.js';
import type {
  PidConfig,
  PlantConfig,
  RunConfig,
  RunState,
  SampleRow,
} from '../core/types.js';

interface RunRow {
  id: string;
  idempotency_key: string;
  config_json: string;
  state_json: string;
  iae: number;
  status: string;
  failure_reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface StoredRun {
  id: string;
  idempotencyKey: string;
  config: RunConfig;
  state: RunState;
  iae: number;
  status: RunState['status'];
  failureReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Page<T> {
  items: T[];
  limit: number;
  offset: number;
  total: number;
}

export class Repository {
  constructor(private readonly db: DatabaseSync, private readonly now: () => number) {}

  private withTx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // --- versioned plants ---
  upsertNextPlant(name: string, config: PlantConfig): { version: number; config: PlantConfig } {
    return this.withTx(() => {
      const row = this.db
        .prepare('SELECT COALESCE(MAX(version),0) AS v FROM plants WHERE name = ?')
        .get(name) as { v: number };
      const version = row.v + 1;
      this.db
        .prepare(
          `INSERT INTO plants(name, version, config_json, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(name, version) DO UPDATE SET config_json = excluded.config_json`,
        )
        .run(name, version, JSON.stringify(config), this.now());
      return { version, config };
    });
  }

  getPlant(name: string, version?: number): { version: number; config: PlantConfig } {
    const row =
      version === undefined
        ? (this.db
            .prepare(
              'SELECT version, config_json FROM plants WHERE name = ? ORDER BY version DESC LIMIT 1',
            )
            .get(name) as { version: number; config_json: string } | undefined)
        : (this.db
            .prepare('SELECT version, config_json FROM plants WHERE name = ? AND version = ?')
            .get(name, version) as { version: number; config_json: string } | undefined);
    if (!row) throw new AppError('NOT_FOUND', `plant '${name}' not found`);
    return { version: row.version, config: JSON.parse(row.config_json) as PlantConfig };
  }

  listPlants(): { name: string; version: number; createdAt: number }[] {
    return this.db
      .prepare('SELECT name, version, created_at FROM plants ORDER BY name, version')
      .all()
      .map((r: any) => ({ name: r.name, version: r.version, createdAt: r.created_at }));
  }

  // --- versioned controllers ---
  upsertNextController(
    name: string,
    config: PidConfig,
    note: string,
  ): { version: number; config: PidConfig } {
    return this.withTx(() => {
      const row = this.db
        .prepare('SELECT COALESCE(MAX(version),0) AS v FROM controllers WHERE name = ?')
        .get(name) as { v: number };
      const version = row.v + 1;
      this.db
        .prepare(
          `INSERT INTO controllers(name, version, config_json, note, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(name, version) DO UPDATE SET
             config_json = excluded.config_json, note = excluded.note`,
        )
        .run(name, version, JSON.stringify(config), note, this.now());
      return { version, config };
    });
  }

  getController(
    name: string,
    version?: number,
  ): { version: number; config: PidConfig; note: string } {
    const row =
      version === undefined
        ? (this.db
            .prepare(
              'SELECT version, config_json, note FROM controllers WHERE name = ? ORDER BY version DESC LIMIT 1',
            )
            .get(name) as { version: number; config_json: string; note: string } | undefined)
        : (this.db
            .prepare(
              'SELECT version, config_json, note FROM controllers WHERE name = ? AND version = ?',
            )
            .get(name, version) as
            | { version: number; config_json: string; note: string }
            | undefined);
    if (!row) throw new AppError('NOT_FOUND', `controller '${name}' not found`);
    return { version: row.version, config: JSON.parse(row.config_json) as PidConfig, note: row.note };
  }

  listControllers(): { name: string; version: number; note: string; createdAt: number }[] {
    return this.db
      .prepare('SELECT name, version, note, created_at FROM controllers ORDER BY name, version')
      .all()
      .map((r: any) => ({
        name: r.name,
        version: r.version,
        note: r.note,
        createdAt: r.created_at,
      }));
  }

  // --- runs ---
  /**
   * Idempotent run creation. Repeating the same idempotencyKey returns the
   * original run instead of inserting a second one.
   */
  createRun(
    id: string,
    key: string,
    config: RunConfig,
    state: RunState,
  ): { run: StoredRun; created: boolean } {
    return this.withTx(() => {
        const existing = this.db
          .prepare('SELECT * FROM runs WHERE idempotency_key = ?')
          .get(key) as RunRow | undefined;
        if (existing) return { run: this.rowToRun(existing), created: false };
        const ts = this.now();
        this.db
          .prepare(
            `INSERT INTO runs(id, idempotency_key, config_json, state_json, iae,
                               status, failure_reason, created_at, updated_at)
             VALUES (?, ?, ?, ?, 0, 'running', NULL, ?, ?)`,
          )
          .run(id, key, JSON.stringify(config), JSON.stringify(state), ts, ts);
        return {
          run: {
            id,
            idempotencyKey: key,
            config,
            state,
            iae: 0,
            status: 'running',
            failureReason: null,
            createdAt: ts,
            updatedAt: ts,
          },
          created: true,
        };
    });
  }

  getRun(id: string): StoredRun {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as
      | RunRow
      | undefined;
    if (!row) throw new AppError('NOT_FOUND', `run '${id}' not found`);
    return this.rowToRun(row);
  }

  tryGetRun(id: string): StoredRun | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as
      | RunRow
      | undefined;
    return row ? this.rowToRun(row) : null;
  }

  saveRun(run: StoredRun): void {
    this.db
      .prepare(
        `UPDATE runs SET state_json = ?, iae = ?, status = ?, failure_reason = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        JSON.stringify(run.state),
        run.iae,
        run.status,
        run.failureReason,
        this.now(),
        run.id,
      );
  }

  insertSamples(samples: SampleRow[]): void {
    if (samples.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO samples(run_id, k, sp, y, error, p_term, i_term, d_term,
                           v_unsat, u_command, u_applied, load, saturated, iae)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, k) DO NOTHING`,
    );
    for (const s of samples) {
      stmt.run(
        s.runId, s.k, s.sp, s.y, s.error, s.pTerm, s.iTerm, s.dTerm,
        s.vUnsat, s.uCommand, s.uApplied, s.load, s.saturated, s.iae,
      );
    }
  }

  /** Persist state + freshly produced samples atomically (checkpoint consistency). */
  persistAdvance(run: StoredRun, samples: SampleRow[]): void {
    this.withTx(() => {
      this.saveRun(run);
      this.insertSamples(samples);
    });
  }

  getSamples(runId: string, limit: number, offset: number): Page<SampleRow> {
    const total = (
      this.db.prepare('SELECT COUNT(*) AS c FROM samples WHERE run_id = ?').get(runId) as {
        c: number;
      }
    ).c;
    const rows = this.db
      .prepare(
        `SELECT run_id, k, sp, y, error, p_term AS pTerm, i_term AS iTerm,
                d_term AS dTerm, v_unsat AS vUnsat, u_command AS uCommand,
                u_applied AS uApplied, load, saturated, iae
         FROM samples WHERE run_id = ? ORDER BY k LIMIT ? OFFSET ?`,
      )
      .all(runId, limit, offset) as unknown as SampleRow[];
    return { items: rows, limit, offset, total };
  }

  getAllSamples(runId: string): SampleRow[] {
    return this.db
      .prepare(
        `SELECT run_id, k, sp, y, error, p_term AS pTerm, i_term AS iTerm,
                d_term AS dTerm, v_unsat AS vUnsat, u_command AS uCommand,
                u_applied AS uApplied, load, saturated, iae
         FROM samples WHERE run_id = ? ORDER BY k`,
      )
      .all(runId) as unknown as SampleRow[];
  }

  logOp(runId: string, op: string, detail: string, atSample: number | null): void {
    this.db
      .prepare(
        `INSERT INTO run_op_log(run_id, op, detail, at_sample, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(runId, op, detail, atSample, this.now());
  }

  listOps(runId: string, limit: number, offset: number): Page<{
    id: number;
    op: string;
    detail: string;
    atSample: number | null;
    createdAt: number;
  }> {
    const total = (
      this.db.prepare('SELECT COUNT(*) AS c FROM run_op_log WHERE run_id = ?').get(runId) as {
        c: number;
      }
    ).c;
    const items = this.db
      .prepare(
        `SELECT id, op, detail, at_sample AS atSample, created_at AS createdAt
         FROM run_op_log WHERE run_id = ? ORDER BY id LIMIT ? OFFSET ?`,
      )
      .all(runId, limit, offset) as any;
    return { items, limit, offset, total };
  }

  listRuns(limit: number, offset: number): Page<StoredRun> {
    const total = (this.db.prepare('SELECT COUNT(*) AS c FROM runs').get() as { c: number }).c;
    const rows = this.db
      .prepare('SELECT * FROM runs ORDER BY created_at DESC, id LIMIT ? OFFSET ?')
      .all(limit, offset) as unknown as RunRow[];
    return { items: rows.map((r) => this.rowToRun(r)), limit, offset, total };
  }

  private rowToRun(r: RunRow): StoredRun {
    return {
      id: r.id,
      idempotencyKey: r.idempotency_key,
      config: JSON.parse(r.config_json) as RunConfig,
      state: JSON.parse(r.state_json) as RunState,
      iae: r.iae,
      status: r.status as RunState['status'],
      failureReason: r.failure_reason,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}
