import type { DatabaseSync } from "node:sqlite";
import { withTransaction } from "./db.ts";
import type {
  Disturbance,
  LoopState,
  PidParams,
  PlantConfig,
  RunStatus,
  SampleRow,
  SetpointChange,
  StopReason,
} from "./types.ts";

export interface ScenarioRow {
  id: number;
  name: string;
  gain: number;
  tau: number;
  ts: number;
  delay_steps: number;
  u_min: number;
  u_max: number;
  setpoint: number;
  y0: number;
  max_samples: number;
  created_at: string;
  updated_at: string;
}

export interface VersionRow {
  id: number;
  scenario_id: number;
  label: string;
  kp: number;
  ki: number;
  kd: number;
  td_filter: number;
  anti_windup: "freeze" | "backcalc";
  tt: number;
  is_active: number;
  status: RunStatus;
  stop_reason: StopReason;
  loop_state: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export function plantFromRow(r: ScenarioRow): PlantConfig {
  return {
    gain: r.gain,
    tau: r.tau,
    ts: r.ts,
    delaySteps: r.delay_steps,
    uMin: r.u_min,
    uMax: r.u_max,
  };
}

export function pidFromRow(r: VersionRow): PidParams {
  return {
    kp: r.kp,
    ki: r.ki,
    kd: r.kd,
    tdFilter: r.td_filter,
    antiWindup: r.anti_windup,
    tt: r.tt,
  };
}

export class Repository {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  createScenario(input: {
    name: string;
    plant: PlantConfig;
    setpoint: number;
    y0: number;
    maxSamples: number;
    now: string;
  }): ScenarioRow {
    const info = this.db
      .prepare(
        `INSERT INTO scenarios
          (name, gain, tau, ts, delay_steps, u_min, u_max, setpoint, y0, max_samples, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.name,
        input.plant.gain,
        input.plant.tau,
        input.plant.ts,
        input.plant.delaySteps,
        input.plant.uMin,
        input.plant.uMax,
        input.setpoint,
        input.y0,
        input.maxSamples,
        input.now,
        input.now,
      );
    return this.getScenario(Number(info.lastInsertRowid)) as ScenarioRow;
  }

  listScenarios(limit: number, offset: number): { rows: ScenarioRow[]; total: number } {
    const rows = this.db
      .prepare("SELECT * FROM scenarios ORDER BY id ASC LIMIT ? OFFSET ?")
      .all(limit, offset) as ScenarioRow[];
    const total = (this.db.prepare("SELECT COUNT(*) AS c FROM scenarios").get() as { c: number }).c;
    return { rows, total };
  }

  getScenario(id: number): ScenarioRow | undefined {
    return this.db.prepare("SELECT * FROM scenarios WHERE id = ?").get(id) as ScenarioRow | undefined;
  }

  addVersion(input: {
    scenarioId: number;
    label: string;
    pid: PidParams;
    active: boolean;
    now: string;
  }): VersionRow {
    const info = this.db
      .prepare(
        `INSERT INTO versions
          (scenario_id, label, kp, ki, kd, td_filter, anti_windup, tt, is_active, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
      )
      .run(
        input.scenarioId,
        input.label,
        input.pid.kp,
        input.pid.ki,
        input.pid.kd,
        input.pid.tdFilter,
        input.pid.antiWindup,
        input.pid.tt,
        input.active ? 1 : 0,
        input.now,
        input.now,
      );
    return this.getVersion(Number(info.lastInsertRowid)) as VersionRow;
  }

  listVersions(scenarioId: number): VersionRow[] {
    return this.db
      .prepare("SELECT * FROM versions WHERE scenario_id = ? ORDER BY id ASC")
      .all(scenarioId) as VersionRow[];
  }

  getVersion(id: number): VersionRow | undefined {
    return this.db.prepare("SELECT * FROM versions WHERE id = ?").get(id) as VersionRow | undefined;
  }

  setActiveVersion(scenarioId: number, versionId: number, now: string): void {
    this.db.prepare("UPDATE versions SET is_active = 0, updated_at = ? WHERE scenario_id = ?").run(now, scenarioId);
    const res = this.db
      .prepare("UPDATE versions SET is_active = 1, updated_at = ? WHERE id = ? AND scenario_id = ?")
      .run(now, versionId, scenarioId);
    if (res.changes === 0) throw new Error("active version update affected no rows");
  }

  addDisturbance(scenarioId: number, d: Disturbance): number {
    const info = this.db
      .prepare("INSERT INTO disturbances (scenario_id, start_step, end_step, amplitude) VALUES (?, ?, ?, ?)")
      .run(scenarioId, d.startStep, d.endStep, d.amplitude);
    return Number(info.lastInsertRowid);
  }

  listDisturbances(scenarioId: number): Disturbance[] {
    const rows = this.db
      .prepare("SELECT start_step, end_step, amplitude FROM disturbances WHERE scenario_id = ? ORDER BY start_step")
      .all(scenarioId) as { start_step: number; end_step: number | null; amplitude: number }[];
    return rows.map((r) => ({ startStep: r.start_step, endStep: r.end_step, amplitude: r.amplitude }));
  }

  addSetpointChange(scenarioId: number, c: SetpointChange): number {
    const info = this.db
      .prepare("INSERT INTO setpoint_changes (scenario_id, step, setpoint) VALUES (?, ?, ?)")
      .run(scenarioId, c.step, c.setpoint);
    return Number(info.lastInsertRowid);
  }

  listSetpointChanges(scenarioId: number): SetpointChange[] {
    const rows = this.db
      .prepare("SELECT step, setpoint FROM setpoint_changes WHERE scenario_id = ? ORDER BY step")
      .all(scenarioId) as { step: number; setpoint: number }[];
    return rows.map((r) => ({ step: r.step, setpoint: r.setpoint }));
  }

  saveLoopState(versionId: number, state: LoopState, now: string): void {
    this.db
      .prepare("UPDATE versions SET loop_state = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(state), now, versionId);
  }

  setStatus(
    versionId: number,
    status: RunStatus,
    stopReason: StopReason,
    lastError: string | null,
    now: string,
  ): void {
    this.db
      .prepare("UPDATE versions SET status = ?, stop_reason = ?, last_error = ?, updated_at = ? WHERE id = ?")
      .run(status, stopReason, lastError, now, versionId);
  }

  insertSample(s: SampleRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO samples
          (version_id, step, setpoint, measurement, error, p, i, d, demand, control, disturbance)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.versionId,
        s.step,
        s.setpoint,
        s.measurement,
        s.error,
        s.p,
        s.i,
        s.d,
        s.demand,
        s.control,
        s.disturbance,
      );
  }

  countSamples(versionId: number): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM samples WHERE version_id = ?").get(versionId) as { c: number }).c;
  }

  listSamples(versionId: number, limit: number, offset: number): { rows: SampleRow[]; total: number } {
    const raw = this.db
      .prepare(
        `SELECT version_id AS versionId, step, setpoint, measurement, error, p, i, d,
                demand, control, disturbance
           FROM samples WHERE version_id = ? ORDER BY step ASC LIMIT ? OFFSET ?`,
      )
      .all(versionId, limit, offset) as SampleRow[];
    const total = this.countSamples(versionId);
    return { rows: raw, total };
  }

  allSamples(versionId: number): SampleRow[] {
    return this.db
      .prepare(
        `SELECT version_id AS versionId, step, setpoint, measurement, error, p, i, d,
                demand, control, disturbance
           FROM samples WHERE version_id = ? ORDER BY step ASC`,
      )
      .all(versionId) as SampleRow[];
  }

  upsertReport(versionId: number, toleranceBand: number, payload: unknown, now: string): void {
    this.db
      .prepare(
        `INSERT INTO reports (version_id, tolerance_band, payload, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(version_id, tolerance_band) DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at`,
      )
      .run(versionId, toleranceBand, JSON.stringify(payload), now);
  }

  getReport(versionId: number, toleranceBand: number): { payload: unknown } | undefined {
    const row = this.db
      .prepare("SELECT payload FROM reports WHERE version_id = ? AND tolerance_band = ?")
      .get(versionId, toleranceBand) as { payload: string } | undefined;
    return row ? { payload: JSON.parse(row.payload) as unknown } : undefined;
  }

  findIdempotency(key: string): { statusCode: number; body: string } | undefined {
    const row = this.db
      .prepare("SELECT status_code, response_body FROM idempotency_keys WHERE key = ?")
      .get(key) as { status_code: number; response_body: string } | undefined;
    return row ? { statusCode: row.status_code, body: row.response_body } : undefined;
  }

  saveIdempotency(
    key: string,
    method: string,
    path: string,
    requestHash: string,
    statusCode: number,
    body: string,
    now: string,
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO idempotency_keys
          (key, method, path, request_hash, status_code, response_body, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(key, method, path, requestHash, statusCode, body, now);
  }

  idempotencyExistsWithDifferentHash(key: string, requestHash: string): boolean {
    const row = this.db
      .prepare("SELECT request_hash FROM idempotency_keys WHERE key = ?")
      .get(key) as { request_hash: string } | undefined;
    return row !== undefined && row.request_hash !== requestHash;
  }
}
