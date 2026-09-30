/** Domain types for the discrete control loop evaluator. */

export interface PlantConfig {
  /** Static process gain K. */
  gain: number;
  /** Process time constant T (seconds, > 0). */
  tau: number;
  /** Sampling period Ts (seconds, > 0). */
  ts: number;
  /** Integer sample delay d in actuator path (>= 0). d=0 means current-sample actuation. */
  delaySamples: number;
  /** Actuator lower limit u_min. */
  uMin: number;
  /** Actuator upper limit u_max (must be > uMin). */
  uMax: number;
}

export interface PidConfig {
  /** Proportional gain. */
  kp: number;
  /** Integral gain (Ki, units of 1/second in the parallel form). */
  ki: number;
  /** Derivative gain (Kd, seconds in the parallel form). */
  kd: number;
  /**
   * Derivative filter time constant N convention: filter pole is ts / (kd / N).
   * We use `tf` directly: filtered measurement derivative pole alpha = tf/(tf+ts).
   * tf = 0 disables the extra filter (equivalent to tf -> 0, raw one-step dPV).
   */
  tf: number;
  /** Anti-windup rule. */
  antiWindup: 'freeze' | 'backcalc';
  /** Back-calculation tracking gain (1/s) when rule is backcalc; must be > 0. */
  kaw: number;
}

/** A scheduled setpoint change or load disturbance, applied before sample k. */
export interface EventSpec {
  /** Client-supplied idempotency key; unique within a run. */
  key: string;
  /** Sample index at which the event takes effect (>= 0). */
  atSample: number;
  kind: 'setpoint' | 'disturbance';
  /** For setpoint: new sp. For disturbance: additive output load applied at that sample and held. */
  value: number;
}

export interface RunConfig {
  id: string;
  idempotencyKey: string;
  plant: PlantConfig;
  pid: PidConfig;
  /** Initial setpoint held from sample 0. */
  setpoint: number;
  /** Initial process output y(0) at steady state before any event. */
  y0: number;
  /** Maximum number of samples the run may advance to. */
  maxSamples: number;
  /** Settling band as a fraction of |final sp - y0| (> 0), e.g. 0.02. */
  settlingFraction: number;
  events: EventSpec[];
}

export interface PidState {
 /** Integrator state I (in output units: I = Ki * integral e dt). */
  integral: number;
  /** Previous error sample e[k-1] (unused for D-on-PV, kept for inspection). */
  prevError: number;
  /** Previous filtered measurement y_f[k-1]. */
  prevFilteredY: number;
  /** Previous raw measurement y[k-1]. */
  prevY: number;
  /** P component at the latest sample. */
  pTerm: number;
  /** I component at the latest sample. */
  iTerm: number;
  /** D component at the latest sample. */
  dTerm: number;
  /** Unsaturated controller demand at the latest sample. */
  vUnsat: number;
}

export interface RunState {
  /** Next sample index to compute (number of completed samples). */
  k: number;
  /** Current process output y[k]. */
  y: number;
  /** Current setpoint sp[k]. */
  sp: number;
  /** Current held additive load disturbance. */
  load: number;
  /** Delay queue: delayed u seen by the plant input slot at each future sample. */
  delayQueue: number[];
  /** Delayed actuator value actually applied to the plant this sample. */
  uApplied: number;
  /** Final saturated command produced this sample (also newest queue entry). */
  uCommand: number;
  pid: PidState;
  status: 'running' | 'paused' | 'finished' | 'failed';
  failureReason: string | null;
}

export interface SampleRow {
  runId: string;
  k: number;
  sp: number;
  y: number;
  error: number;
  pTerm: number;
  iTerm: number;
  dTerm: number;
  vUnsat: number;
  uCommand: number;
  uApplied: number;
  load: number;
  saturated: 0 | 1;
  iae: number;
}

export interface RunReport {
  status: RunState['status'];
  samples: number;
  overshoot: number | null;
  steadyStateError: number | null;
  iae: number | null;
  settlingTimeSeconds: number | null;
  settlingSample: number | null;
  settled: boolean;
  failureReason: string | null;
}

export interface StepResult {
  state: RunState;
  sample: SampleRow | null;
}
