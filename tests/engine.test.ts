import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { advancePlant, applyDelay, initialPlantState, plantPole } from "../src/plant.ts";
import { initialPidState, pidStep } from "../src/pid.ts";
import { initialLoopState, stepLoop } from "../src/engine.ts";
import { computeReport } from "../src/metrics.ts";
import { defaultPlant, pureProportionalPid, stablePid } from "../src/fixtures.ts";
import type { LoopState, PidParams, PlantConfig, SampleRow } from "../src/types.ts";

function runToEnd(
  plantCfg: PlantConfig,
  pid: PidParams,
  setpoint: number,
  y0: number,
  n: number,
  opts: { disturbances?: never[]; setpointChanges?: { step: number; setpoint: number }[] } = {},
): { samples: SampleRow[]; states: LoopState[] } {
  let state = initialLoopState(plantCfg, setpoint, y0);
  const samples: SampleRow[] = [];
  const states: LoopState[] = [];
  for (let k = 0; k < n; k++) {
    const res = stepLoop({
      state,
      plantCfg,
      pidParams: pid,
      disturbances: opts.disturbances ?? [],
      setpointChanges: opts.setpointChanges ?? [],
      scenarioId: 1,
      versionId: 1,
    });
    samples.push(res.sample);
    states.push(state);
    state = res.state;
  }
  return { samples, states };
}

describe("first-order ZOH plant", () => {
  it("matches the analytic open-loop step recursion", () => {
    const cfg = defaultPlant({ gain: 3, tau: 4, ts: 1, delaySteps: 0 });
    let state = initialPlantState(cfg, 0);
    const a = plantPole(cfg);
    for (let k = 0; k < 10; k++) {
      const delayed = applyDelay(state, cfg, 1);
      state = advancePlant(delayed.next, cfg, delayed.input, 0);
      const expected = 3 * (1 - Math.pow(a, k + 1));
      assert.ok(Math.abs(state.x - expected) < 1e-12, `k=${k} got ${state.x} expected ${expected}`);
    }
  });

  it("distinguishes delay 0 from delay 1 at the first sample", () => {
    const cfg0 = defaultPlant({ gain: 2, tau: 5, ts: 1, delaySteps: 0 });
    const cfg1 = defaultPlant({ gain: 2, tau: 5, ts: 1, delaySteps: 1 });
    const pid = pureProportionalPid(1);

    const r0 = runToEnd(cfg0, pid, 1, 0, 2);
    const r1 = runToEnd(cfg1, pid, 1, 0, 2);

    // Zero delay: the first command already drives y[1] above zero.
    assert.ok(r0.samples[1]!.measurement > 0);
    // One-step delay: the queue was initialized with zero command so y[1] stays zero.
    assert.equal(r1.samples[1]!.measurement, 0);
    // By y[2] the delayed first command arrives.
    assert.ok(r1.samples[1]!.control > 0);
  });
});

describe("PID behavior", () => {
  it("pure proportional control leaves the analytic steady-state offset", () => {
    const cfg = defaultPlant({ gain: 2, tau: 2, ts: 0.2, delaySteps: 0, uMin: -100, uMax: 100 });
    const kp = 4;
    const { samples } = runToEnd(cfg, pureProportionalPid(kp), 1, 0, 400);
    const last = samples.at(-1) as SampleRow;
    // y_ss = K*kp/(1+K*kp) * sp
    const expectedY = (cfg.gain * kp) / (1 + cfg.gain * kp);
    assert.ok(Math.abs(last.measurement - expectedY) < 1e-9);
    assert.ok(Math.abs(last.error - (1 - expectedY)) < 1e-9);
  });

  it("measurement derivative produces no kick on a setpoint step", () => {
    // Measurement is identical at two consecutive samples; only the setpoint jumps.
    const pid = stablePid({ kp: 1, ki: 0, kd: 2 });
    const state = initialPidState(0.8);
    const atOldSetpoint = pidStep(state, pid, 1, 0.8, 0.5, -10, 10);
    const afterSetpointJump = pidStep(atOldSetpoint.state, pid, 3, 0.8, 0.5, -10, 10);
    assert.equal(afterSetpointJump.components.d, 0);
    // The proportional term alone reflects the setpoint change.
    assert.ok(Math.abs(afterSetpointJump.components.p - (3 - 0.8)) < 1e-12);
  });

  it("freeze anti-windup keeps the integrator bounded and lets it recover", () => {
    // Saturation binds initially, but the steady command u=sp/K=0.5 is feasible,
    // so the loop must recover to zero error without a runaway integral.
    const cfg = defaultPlant({ uMin: -0.2, uMax: 1 });
    const pid: PidParams = { kp: 1, ki: 2, kd: 0, tdFilter: 0, antiWindup: "freeze", tt: 1 };
    const { samples } = runToEnd(cfg, pid, 1, 0, 200);
    const last = samples.at(-1) as SampleRow;
    for (const s of samples) {
      assert.ok(Math.abs(s.i) < 100, `integrator blew up: ${s.i}`);
      assert.ok(s.control >= cfg.uMin - 1e-12 && s.control <= cfg.uMax + 1e-12);
    }
    assert.ok(Math.abs(last.error) < 1e-6, `did not converge, error=${last.error}`);
  });

  it("backcalc anti-windup also recovers to zero error", () => {
    const cfg = defaultPlant({ uMin: -0.2, uMax: 1 });
    const pid = stablePid({ kp: 1, ki: 2, kd: 0, tdFilter: 0, antiWindup: "backcalc", tt: 0.5 });
    const { samples } = runToEnd(cfg, pid, 1, 0, 200);
    const last = samples.at(-1) as SampleRow;
    assert.ok(Math.abs(last.error) < 1e-6);
  });

  it("checkpoint continuation is sample-identical to one continuous run", () => {
    const cfg = defaultPlant();
    const pid = stablePid();
    const continuous = runToEnd(cfg, pid, 1, 0, 60, {
      setpointChanges: [{ step: 25, setpoint: 1.5 }],
    });

    let state = initialLoopState(cfg, 1, 0);
    const chunked: SampleRow[] = [];
    const boundaries = [0, 10, 10, 17, 23];
    for (const count of boundaries) {
      for (let n = 0; n < count; n++) {
        const res = stepLoop({
          state,
          plantCfg: cfg,
          pidParams: pid,
          disturbances: [],
          setpointChanges: [{ step: 25, setpoint: 1.5 }],
          scenarioId: 1,
          versionId: 1,
        });
        chunked.push(res.sample);
        state = res.state;
      }
    }
    assert.equal(chunked.length, continuous.samples.length);
    for (let k = 0; k < continuous.samples.length; k++) {
      assert.deepEqual(chunked[k], continuous.samples[k], `mismatch at k=${k}`);
    }
  });
});

describe("metrics", () => {
  it("does not count a first crossing as settling when the band is later exited", () => {
    const make = (y: number, sp = 1): SampleRow => ({
      scenarioId: 1, versionId: 1, step: 0, setpoint: sp, measurement: y,
      error: sp - y, p: 0, i: 0, d: 0, demand: 0, control: 0, disturbance: 0,
    });
    const transient = [make(0), make(0.98), make(0.9), make(0.99), make(1)];
    const report = computeReport(transient, 0.05, 0.5);
    assert.equal(report.settled, true);
    // Settling begins only at the last in-band sample (index 3), not at index 1.
    assert.equal(report.settlingTime, 3 * 0.5);

    const never = [make(0), make(0.98), make(0.8), make(0.97), make(0.8)];
    const neverReport = computeReport(never, 0.05, 0.5);
    assert.equal(neverReport.settled, false);
    assert.equal(neverReport.settlingTime, null);
  });

  it("accumulates IAE across all samples", () => {
    const cfg = defaultPlant();
    const { samples } = runToEnd(cfg, stablePid({ kd: 0, tdFilter: 0 }), 1, 0, 30);
    const expected = samples.reduce((sum, s) => sum + Math.abs(s.error), 0);
    const report = computeReport(samples, 0.05, cfg.ts);
    assert.ok(Math.abs(report.iae - expected) < 1e-12);
  });
});
