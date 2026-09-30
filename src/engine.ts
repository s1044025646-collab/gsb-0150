import { advancePlant, applyDelay, initialPlantState } from "./plant.ts";
import { initialPidState, pidStep } from "./pid.ts";
import { AppError } from "./errors.ts";
import type {
  LoopState,
  PidParams,
  PlantConfig,
  SampleRow,
  SetpointChange,
  Disturbance,
} from "./types.ts";

export { initialPidState, initialPlantState };

export function initialLoopState(cfg: PlantConfig, setpoint: number, y0: number): LoopState {
  return {
    step: 0,
    setpoint,
    plant: initialPlantState(cfg, y0),
    pid: initialPidState(y0),
    measurement: y0,
  };
}

/** Active process-input disturbance at a given sample, 0 when none is scheduled. */
export function disturbanceAt(schedule: Disturbance[], step: number): number {
  let amplitude = 0;
  for (const d of schedule) {
    if (step >= d.startStep && (d.endStep === null || step <= d.endStep)) {
      amplitude += d.amplitude;
    }
  }
  return amplitude;
}

function setpointAt(changes: SetpointChange[], step: number, current: number): number {
  let sp = current;
  for (const c of changes) {
    if (c.step === step) sp = c.setpoint;
  }
  return sp;
}

function assertFinite(value: number, label: string, step: number): void {
  if (!Number.isFinite(value)) {
    throw new AppError(
      "NUMERIC_DIVERGED",
      `Non-finite ${label} produced at sample ${step}`,
      422,
      { step, field: label },
    );
  }
  if (Math.abs(value) > 1e12) {
    throw new AppError(
      "NUMERIC_DIVERGED",
      `Diverging ${label} (|value| > 1e12) at sample ${step}`,
      422,
      { step, field: label },
    );
  }
}

export interface StepInput {
  state: LoopState;
  plantCfg: PlantConfig;
  pidParams: PidParams;
  disturbances: Disturbance[];
  setpointChanges: SetpointChange[];
  scenarioId: number;
  versionId: number;
}

/**
 * Advance the loop by exactly one sample.
 *
 * Explicit ordering within sample k (must match applyDelay semantics):
 *   read y[k] -> resolve setpoint/disturbance -> PID computes u[k]
 *   -> integer delay consumes/queues u[k] -> ZOH plant advances to y[k+1].
 * The recorded sample holds y[k], e[k], P/I/D and u[k]; state.step then
 * becomes k+1.
 */
export function stepLoop(input: StepInput): { sample: SampleRow; state: LoopState } {
  const { state, plantCfg, pidParams } = input;
  const k = state.step;
  const setpoint = setpointAt(input.setpointChanges, k, state.setpoint);
  const measurement = state.measurement;

  const { components, state: nextPid } = pidStep(
    state.pid,
    pidParams,
    setpoint,
    measurement,
    plantCfg.ts,
    plantCfg.uMin,
    plantCfg.uMax,
  );

  assertFinite(components.u, "control", k);
  assertFinite(measurement, "measurement", k);

  const delayed = applyDelay(state.plant, plantCfg, components.u);
  const disturbance = disturbanceAt(input.disturbances, k);
  const nextPlant = advancePlant(delayed.next, plantCfg, delayed.input, disturbance);

  assertFinite(nextPlant.x, "measurement", k + 1);

  const sample: SampleRow = {
    scenarioId: input.scenarioId,
    versionId: input.versionId,
    step: k,
    setpoint,
    measurement,
    error: setpoint - measurement,
    p: components.p,
    i: components.i,
    d: components.d,
    demand: components.v,
    control: components.u,
    disturbance,
  };

  const nextState: LoopState = {
    step: k + 1,
    setpoint,
    plant: nextPlant,
    pid: nextPid,
    measurement: nextPlant.x,
  };

  return { sample, state: nextState };
}
