import type { CreateRunInput } from '../core/service.js';
import type { PidConfig, PlantConfig } from '../core/types.js';

/**
 * Fictitious plants, disturbances and controller presets used by the demo,
 * CLI quick-start and automated tests. Everything here is synthetic; no real
 * device is ever touched.
 */

export const PLANTS = {
  /** Well-behaved first-order lag, modest actuator range. */
  standardLag: {
    gain: 2,
    tau: 5,
    ts: 0.5,
    delaySamples: 0,
    uMin: -5,
    uMax: 5,
  } satisfies PlantConfig,
  /** Same lag but one-sample actuator delay. */
  delayedLag: {
    gain: 2,
    tau: 5,
    ts: 0.5,
    delaySamples: 1,
    uMin: -5,
    uMax: 5,
  } satisfies PlantConfig,
  /** Slow lag with a tight actuator range -> easy to saturate. */
  tightActuator: {
    gain: 1,
    tau: 10,
    ts: 1,
    delaySamples: 0,
    uMin: -1.5,
    uMax: 1.5,
  } satisfies PlantConfig,
} satisfies Record<string, PlantConfig>;

export const CONTROLLERS = {
  conservative: {
    kp: 0.4, ki: 0.08, kd: 0.1, tf: 0.5, antiWindup: 'freeze', kaw: 1,
  } satisfies PidConfig,
  aggressive: {
    kp: 1.5, ki: 0.6, kd: 0.4, tf: 0.3, antiWindup: 'backcalc', kaw: 0.5,
  } satisfies PidConfig,
  pureProportional: {
    kp: 0.8, ki: 0, kd: 0, tf: 0, antiWindup: 'freeze', kaw: 1,
  } satisfies PidConfig,
  integralHeavy: {
    kp: 0.2, ki: 2.5, kd: 0, tf: 0, antiWindup: 'freeze', kaw: 1,
  } satisfies PidConfig,
  /** Intentionally destabilising gain for failure-path tests. */
  unstable: {
    kp: 500, ki: 2000, kd: 0, tf: 0, antiWindup: 'freeze', kaw: 1,
  } satisfies PidConfig,
} satisfies Record<string, PidConfig>;

const base = {
  y0: 0,
  maxSamples: 120,
  settlingFraction: 0.05,
  events: [],
};

/** Named, deterministic scenarios. `key` doubles as the run idempotency key. */
export const SCENARIOS = {
  /** Open-loop-style check: pure P controller on a unity setpoint step. */
  pureProportionalStep: {
    idempotencyKey: 'fixture-pure-p-step',
    plant: PLANTS.standardLag,
    pid: CONTROLLERS.pureProportional,
    setpoint: 1,
    ...base,
  } satisfies CreateRunInput,

  /** Large step with a tight actuator -> integrator must wind up then recover. */
  integralWindup: {
    idempotencyKey: 'fixture-integral-windup',
    plant: PLANTS.tightActuator,
    pid: CONTROLLERS.integralHeavy,
    setpoint: 1.2,
    maxSamples: 200,
    settlingFraction: 0.05,
    events: [],
    y0: 0,
  } satisfies CreateRunInput,

  /** Closed-loop step, then an abrupt setpoint change (derivative-on-PV test). */
  setpointChange: {
    idempotencyKey: 'fixture-setpoint-change',
    plant: PLANTS.standardLag,
    pid: CONTROLLERS.conservative,
    setpoint: 1,
    ...base,
    events: [
      { key: 'sp-up', atSample: 40, kind: 'setpoint', value: 2 },
    ],
  } satisfies CreateRunInput,

  /** Held output load disturbance applied mid-run. */
  loadDisturbance: {
    idempotencyKey: 'fixture-load-disturbance',
    plant: PLANTS.standardLag,
    pid: CONTROLLERS.conservative,
    setpoint: 1,
    ...base,
    events: [
      { key: 'load', atSample: 30, kind: 'disturbance', value: -0.8 },
    ],
  } satisfies CreateRunInput,

  /** One-sample actuator delay with an aggressive tuning. */
  delayed: {
    idempotencyKey: 'fixture-delayed',
    plant: PLANTS.delayedLag,
    pid: CONTROLLERS.aggressive,
    setpoint: 1,
    ...base,
  } satisfies CreateRunInput,

  /** Destabilising gains -> run must fail with a recorded divergence reason. */
  unstable: {
    idempotencyKey: 'fixture-unstable',
    plant: { gain: 2, tau: 5, ts: 0.5, delaySamples: 0, uMin: -1e15, uMax: 1e15 },
    pid: CONTROLLERS.unstable,
    setpoint: 1,
    maxSamples: 400,
    settlingFraction: 0.05,
    events: [],
    y0: 0,
  } satisfies CreateRunInput,
} satisfies Record<string, CreateRunInput>;

export type ScenarioName = keyof typeof SCENARIOS;

export function scenario(name: ScenarioName): CreateRunInput {
  // Deep clone so callers can mutate freely.
  return JSON.parse(JSON.stringify(SCENARIOS[name])) as CreateRunInput;
}

/** Comparison presets used by `compare` / CLI. */
export const COMPARISON_CANDIDATES = [
  { name: 'conservative', pid: CONTROLLERS.conservative },
  { name: 'aggressive', pid: CONTROLLERS.aggressive },
  { name: 'pureP', pid: CONTROLLERS.pureProportional },
] as const;
