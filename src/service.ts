import { createHash } from "node:crypto";
import { withTransaction } from "./db.ts";
import { AppError } from "./errors.ts";
import { initialLoopState, stepLoop } from "./engine.ts";
import { computeReport } from "./metrics.ts";
import {
  pidFromRow,
  plantFromRow,
  Repository,
  type ScenarioRow,
  type VersionRow,
} from "./repo.ts";
import { parsePlantConfig } from "./validation.ts";
import type {
  Disturbance,
  LoopState,
  PerformanceReport,
  PidParams,
  SampleRow,
  SetpointChange,
} from "./types.ts";

export interface CreateScenarioInput {
  name: string;
  plant: ReturnType<typeof plantFromRow>;
  setpoint: number;
  y0: number;
  maxSamples: number;
}

export class Service {
  private readonly repo: Repository;
  private readonly clock: () => Date;

  constructor(repo: Repository, clock: () => Date = () => new Date()) {
    this.repo = repo;
    this.clock = clock;
  }

  private now(): string {
    return this.clock().toISOString();
  }

  createScenario(input: CreateScenarioInput): ScenarioRow {
    // Defense in depth: the service validates even when called outside the API.
    parsePlantConfig(input.plant);
    if (!(input.maxSamples >= 1)) {
      throw new AppError("INVALID_PARAM", "maxSamples must be >= 1", 400, { field: "maxSamples" });
    }
    return this.repo.createScenario({
      name: input.name,
      plant: input.plant,
      setpoint: input.setpoint,
      y0: input.y0,
      maxSamples: input.maxSamples,
      now: this.now(),
    });
  }

  requireScenario(id: number): ScenarioRow {
    const row = this.repo.getScenario(id);
    if (!row) throw new AppError("NOT_FOUND", `Scenario ${id} not found`, 404);
    return row;
  }

  requireVersion(id: number): VersionRow {
    const row = this.repo.getVersion(id);
    if (!row) throw new AppError("NOT_FOUND", `Version ${id} not found`, 404);
    return row;
  }

  addPidVersion(scenarioId: number, label: string, pid: PidParams, active = false): VersionRow {
    this.requireScenario(scenarioId);
    const existing = this.repo.listVersions(scenarioId).find((v) => v.label === label);
    if (existing) {
      throw new AppError("CONFLICT", `Version label '${label}' already exists for scenario ${scenarioId}`, 409);
    }
    return withTransaction(this.repo.db, () => {
      const version = this.repo.addVersion({ scenarioId, label, pid, active, now: this.now() });
      if (active) this.repo.setActiveVersion(scenarioId, version.id, this.now());
      return this.repo.getVersion(version.id) as VersionRow;
    });
  }

  addDisturbance(scenarioId: number, d: Disturbance): number {
    this.requireScenario(scenarioId);
    return this.repo.addDisturbance(scenarioId, d);
  }

  addSetpointChange(scenarioId: number, c: SetpointChange): number {
    this.requireScenario(scenarioId);
    return this.repo.addSetpointChange(scenarioId, c);
  }

  /**
   * Run (or continue) a version for up to `steps` samples.
   * All produced samples and the resume state are persisted in ONE transaction;
   * on divergence the produced history is kept, the run is marked stopped with a
   * reason, and the transaction still commits (a recorded failure, not a rollback).
   * Any unexpected error rolls the whole batch back, preserving continuation safety.
   */
  run(versionId: number, steps: number): { status: string; produced: number; reason: string | null; error: string | null } {
    const version = this.requireVersion(versionId);
    const scenario = this.requireScenario(version.scenario_id);
    if (version.status === "stopped") {
      throw new AppError("RUN_STOPPED", `Version ${versionId} is stopped: ${version.last_error ?? version.stop_reason}`, 409);
    }
    if (version.status === "finished") {
      throw new AppError("RUN_FINISHED", `Version ${versionId} already finished`, 409);
    }

    const plantCfg = plantFromRow(scenario);
    const pidParams = pidFromRow(version);

    return withTransaction(this.repo.db, () => {
      let state: LoopState = version.loop_state
        ? (JSON.parse(version.loop_state) as LoopState)
        : initialLoopState(plantCfg, scenario.setpoint, scenario.y0);

      const disturbances = this.repo.listDisturbances(scenario.id);
      const setpointChanges = this.repo.listSetpointChanges(scenario.id);

      let produced = 0;
      try {
        for (let n = 0; n < steps && state.step < scenario.max_samples; n++) {
          const { sample, state: next } = stepLoop({
            state,
            plantCfg,
            pidParams,
            disturbances,
            setpointChanges,
            scenarioId: scenario.id,
            versionId,
          });
          this.repo.insertSample(sample);
          state = next;
          produced++;
        }
      } catch (err) {
        if (err instanceof AppError && err.code === "NUMERIC_DIVERGED") {
          // Persist the state up to the failing point so history is reproducible.
          this.repo.saveLoopState(versionId, state, this.now());
          this.repo.setStatus(versionId, "stopped", "diverged", err.message, this.now());
          return { status: "stopped", produced, reason: "diverged", error: err.message };
        }
        throw err;
      }

      this.repo.saveLoopState(versionId, state, this.now());
      if (state.step >= scenario.max_samples) {
        this.repo.setStatus(versionId, "finished", "completed", null, this.now());
        return { status: "finished", produced, reason: "completed", error: null };
      }
      this.repo.setStatus(versionId, "paused", null, null, this.now());
      return { status: "paused", produced, reason: null, error: null };
    });
  }

  pause(versionId: number): VersionRow {
    const version = this.requireVersion(versionId);
    if (version.status !== "running") {
      // run() always persists in a paused/finished state, so this is defensive.
      throw new AppError("ALREADY_PAUSED", `Version ${versionId} is not running (status=${version.status})`, 409);
    }
    this.repo.setStatus(versionId, "paused", null, null, this.now());
    return this.requireVersion(versionId);
  }

  resume(versionId: number, steps: number) {
    const version = this.requireVersion(versionId);
    if (version.status === "stopped") {
      throw new AppError("RUN_STOPPED", `Version ${versionId} is stopped: ${version.last_error ?? ""}`, 409);
    }
    if (version.status === "finished") {
      throw new AppError("RUN_FINISHED", `Version ${versionId} already finished`, 409);
    }
    return this.run(versionId, steps);
  }

  samples(versionId: number, limit: number, offset: number) {
    this.requireVersion(versionId);
    return this.repo.listSamples(versionId, limit, offset);
  }

  report(versionId: number, toleranceBand: number): PerformanceReport {
    const version = this.requireVersion(versionId);
    const scenario = this.requireScenario(version.scenario_id);
    const cached = this.repo.getReport(versionId, toleranceBand);
    const samples = this.repo.allSamples(versionId);
    if (samples.length === 0) {
      throw new AppError("INVALID_STATE_TRANSITION", "No samples produced yet; run the version before reporting", 409);
    }
    const payload = computeReport(samples, toleranceBand, scenario.ts);
    this.repo.upsertReport(versionId, toleranceBand, payload, this.now());
    void cached;
    return payload;
  }

  exportSamples(versionId: number): SampleRow[] {
    this.requireVersion(versionId);
    return this.repo.allSamples(versionId);
  }

  hashBody(body: string): string {
    return createHash("sha256").update(body).digest("hex");
  }
}
