import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Repository, type StoredRun } from '../db/repository.js';
import { AppError } from './errors.js';
import { initialState, step, restoreSnapshot } from './engine.js';
import { buildReport } from './report.js';
import { assertFiniteParams, validateRunInput } from './validation.js';
import type {
  PidConfig,
  PlantConfig,
  RunConfig,
  RunReport,
  RunState,
  SampleRow,
} from './types.js';

export interface CreateRunInput {
  idempotencyKey: string;
  plant: PlantConfig;
  pid: PidConfig;
  setpoint: number;
  y0: number;
  maxSamples: number;
  settlingFraction: number;
  events: RunConfig['events'];
}

export class RunService {
  readonly repo: Repository;

  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: () => number = () => Date.now(),
  ) {
    this.repo = new Repository(db, clock);
  }

  createPlant(name: string, config: PlantConfig) {
    return this.repo.upsertNextPlant(name, config);
  }
  createController(name: string, config: PidConfig, note = '') {
    return this.repo.upsertNextController(name, config, note);
  }

  /** Idempotent run creation keyed by idempotencyKey. */
  createRun(input: CreateRunInput): { run: StoredRun; created: boolean } {
    // Full validation so both API and CLI callers get identical guarantees.
    validateRunInput(input);
    assertFiniteParams({ plant: input.plant, pid: input.pid });
    const id = randomUUID();
    const config: RunConfig = { id, ...input };
    const state = initialState(config);
    const result = this.repo.createRun(id, input.idempotencyKey, config, state);
    if (result.created) this.repo.logOp(result.run.id, 'create', input.idempotencyKey, 0);
    return result;
  }

  /**
   * Advance a running run by up to n samples (or until it finishes/fails).
   * State and samples are committed in ONE transaction so a crash mid-batch
   * never leaves stored samples ahead of the checkpointed state.
   */
  advance(runId: string, n: number): StoredRun {
    if (!Number.isInteger(n) || n <= 0)
      throw new AppError('VALIDATION', 'n must be a positive integer');
    const stored = this.repo.getRun(runId);
    if (stored.state.status !== 'running') {
      throw new AppError(
        'RUN_NOT_RUNNING',
        `cannot advance run with status ${stored.state.status}`,
      );
    }
    const produced: SampleRow[] = [];
    const snap = restoreSnapshot(stored.config, stored.state, stored.iae);
    for (let i = 0; i < n && stored.state.status === 'running'; i++) {
      const { sample } = step(snap);
      if (sample) produced.push(sample);
    }
    stored.iae = snap.iae;
    stored.state = snap.state;
    stored.status = snap.state.status;
    stored.failureReason = snap.state.failureReason;
    this.repo.persistAdvance(stored, produced);
    this.repo.logOp(runId, 'advance', `${produced.length} sample(s)`, stored.state.k);
    return this.repo.getRun(runId);
  }

  /** Advance until finished/failed or maxSamples reached. */
  runToEnd(runId: string): StoredRun {
    const stored = this.repo.getRun(runId);
    const remaining = stored.config.maxSamples - stored.state.k;
    if (remaining <= 0) return stored;
    return this.advance(runId, remaining);
  }

  pause(runId: string): StoredRun {
    return this.setStatus(runId, 'paused', 'pause');
  }

  /** Continue from a paused run; integrator/filter/queue state is preserved. */
  resume(runId: string): StoredRun {
    const stored = this.repo.getRun(runId);
    if (stored.state.status !== 'paused') {
      throw new AppError(
        'CONFLICT',
        `only paused runs can resume (status=${stored.state.status})`,
      );
    }
    stored.state.status = 'running';
    stored.state.failureReason = null;
    stored.status = 'running';
    this.repo.saveRun(stored);
    this.repo.logOp(runId, 'resume', '', stored.state.k);
    return this.repo.getRun(runId);
  }

  private setStatus(runId: string, status: RunState['status'], op: string): StoredRun {
    const stored = this.repo.getRun(runId);
    if (stored.state.status !== 'running' && status === 'paused') {
      throw new AppError('CONFLICT', `cannot pause run with status ${stored.state.status}`);
    }
    stored.state.status = status;
    stored.status = status;
    this.repo.saveRun(stored);
    this.repo.logOp(runId, op, '', stored.state.k);
    return this.repo.getRun(runId);
  }

  report(runId: string): RunReport {
    const stored = this.repo.getRun(runId);
    const samples = this.repo.getAllSamples(runId);
    return buildReport(
      stored.config,
      samples,
      stored.state.status,
      stored.state.failureReason,
      stored.iae,
    );
  }

  /**
   * Compare several PIDs on an identical scenario. Fresh runs are created with
   * deterministic idempotency keys and each is run to its end.
   */
  compare(
    base: Omit<CreateRunInput, 'idempotencyKey' | 'pid'>,
    scenarioKey: string,
    candidates: { name: string; pid: PidConfig }[],
  ): { name: string; runId: string; report: RunReport }[] {
    if (candidates.length === 0)
      throw new AppError('VALIDATION', 'at least one candidate required');
    return candidates.map((c, i) => {
      const { run } = this.createRun({
        ...base,
        pid: c.pid,
        idempotencyKey: `compare-${scenarioKey}-${i}-${c.name}`,
      });
      this.runToEnd(run.id);
      return { name: c.name, runId: run.id, report: this.report(run.id) };
    });
  }
}
