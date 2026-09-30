import type { Disturbance, PidParams, PlantConfig, ScenarioSpec } from "./types.ts";

/** Fictional-but-physical plant and disturbance fixtures used by the demo and tests. */

export function defaultPlant(overrides: Partial<PlantConfig> = {}): PlantConfig {
  return {
    gain: 2,
    tau: 5,
    ts: 0.5,
    delaySteps: 0,
    uMin: -5,
    uMax: 5,
    ...overrides,
  };
}

export function stablePid(overrides: Partial<PidParams> = {}): PidParams {
  return {
    kp: 1.2,
    ki: 0.4,
    kd: 0.3,
    tdFilter: 0.5,
    antiWindup: "backcalc",
    tt: 1,
    ...overrides,
  };
}

export function pureProportionalPid(kp: number): PidParams {
  return { kp, ki: 0, kd: 0, tdFilter: 0, antiWindup: "freeze", tt: 1 };
}

/**
 * An aggressive gain. Against an ordinary saturated first-order plant it tends
 * to chatter; pair it with huge-scalePlant() to cross the numerical safety bound.
 */
export function unstablePid(): PidParams {
  return { kp: 20, ki: 50, kd: 0, tdFilter: 0, antiWindup: "freeze", tt: 1 };
}

/** Huge gain and wide actuator span so a step drives the state past the safety bound. */
export function hugeScalePlant(overrides: Partial<PlantConfig> = {}): PlantConfig {
  return defaultPlant({ gain: 1e7, tau: 5, ts: 0.5, delaySteps: 0, uMin: -1e7, uMax: 1e7, ...overrides });
}

export function divergencePid(): PidParams {
  return { kp: 2, ki: 0, kd: 0, tdFilter: 0, antiWindup: "freeze", tt: 1 };
}

export function stepScenario(overrides: Partial<ScenarioSpec> = {}): ScenarioSpec {
  return {
    name: "fictional-temp-loop",
    plant: defaultPlant(),
    setpoint: 1,
    y0: 0,
    maxSamples: 120,
    ...overrides,
  };
}

/** A finite-amplitude load disturbance applied as a process-input additive signal. */
export function loadDisturbance(startStep: number, amplitude: number, endStep: number | null = null): Disturbance {
  return { startStep, endStep, amplitude };
}

export function setpointStep(step: number, setpoint: number): { step: number; setpoint: number } {
  return { step, setpoint };
}
