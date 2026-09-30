import type { PlantConfig, PlantState } from "./types.ts";

/** Discrete pole of the first-order lag under zero-order hold. */
export function plantPole(cfg: PlantConfig): number {
  return Math.exp(-cfg.ts / cfg.tau);
}

export function initialPlantState(cfg: PlantConfig, y0: number): PlantState {
  // The output of the lag is initialized at y0; the delay line is filled with a
  // zero command so an integer transport delay is honored from the first sample.
  return { x: y0, delayLine: Array.from({ length: cfg.delaySteps }, () => 0) };
}

/**
 * Resolve the actuator command that actually drives the lag during the advance
 * from sample k to k+1.
 *
 * Sample ordering (documented and enforced by the engine):
 *   1. measurement y[k] is read from the current plant state,
 *   2. the controller computes u[k] from y[k],
 *   3. the integer delay is applied to u[k],
 *   4. the plant is advanced exactly one ZOH step to y[k+1].
 *
 * delaySteps = 0: u[k] is applied during THIS advance (queue untouched).
 * delaySteps = 1: u[k] is queued and a previously queued command is applied, so
 *                  u[k] cannot affect the output until the NEXT advance.
 * The two cases are therefore never conflated.
 */
export function applyDelay(state: PlantState, cfg: PlantConfig, command: number): { input: number; next: PlantState } {
  if (cfg.delaySteps === 0) {
    return { input: command, next: { x: state.x, delayLine: state.delayLine } };
  }
  const delayLine = state.delayLine.slice();
  const input = delayLine.shift() as number;
  delayLine.push(command);
  return { input, next: { x: state.x, delayLine } };
}
/**
 * Advance the first-order lag by one sampling period with a held input.
 *
 * Continuous plant:  T * dy/dt + y = K * (u + d)
 * ZOH recursion:      x[k+1] = a*x[k] + (1-a)*K*(uDelayed[k] + disturbance[k])
 * with a = exp(-Ts/T). The additive disturbance is a process-input disturbance.
 */
export function advancePlant(state: PlantState, cfg: PlantConfig, heldInput: number, disturbance: number): PlantState {
  const a = plantPole(cfg);
  const driven = cfg.gain * (heldInput + disturbance);
  const x = a * state.x + (1 - a) * driven;
  return { x, delayLine: state.delayLine };
}

/** Analytic steady-state output for a constant held input. */
export function steadyOutput(cfg: PlantConfig, heldInput: number): number {
  return cfg.gain * heldInput;
}
