/** Configuration of a first-order plant sampled with zero-order hold and integer delay. */
export interface PlantConfig {
  /** Static gain K (non-zero finite). */
  gain: number;
  /** Time constant T in seconds (> 0). */
  tau: number;
  /** Sampling period Ts in seconds (> 0). */
  ts: number;
  /** Integer number of whole-sample input/output delay (>= 0). 0 and 1 are distinct. */
  delaySteps: number;
  /** Actuator lower saturation bound u_min. */
  uMin: number;
  /** Actuator upper saturation bound u_max. */
  uMax: number;
}

export type AntiWindupMode = "freeze" | "backcalc";

export interface PidParams {
  /** Proportional gain. */
  kp: number;
  /** Integral gain ki = Kp / Ti, units per second of integrated error. */
  ki: number;
  /** Derivative gain kd = Kp * Td. */
  kd: number;
  /**
   * First-order derivative filter time constant N form: derivative is passed through
   * a low-pass filter with time constant tdFilter (> 0 when kd != 0; 0 disables filtering).
   */
  tdFilter: number;
  /** Integral anti-windup rule used while the actuator is saturated. */
  antiWindup: AntiWindupMode;
  /** Back-calculation tracking time constant Tt, used only for the backcalc rule. */
  tt: number;
}

export type RunStatus = "running" | "paused" | "finished" | "stopped";
export type StopReason = "completed" | "diverged" | "invalid" | "aborted" | null;

export interface ScenarioSpec {
  name: string;
  plant: PlantConfig;
  /** Constant setpoint at k=0. */
  setpoint: number;
  /** Initial plant output y(0) before the first sample. */
  y0: number;
  /** Total samples to simulate (sample indices k = 0 .. maxSamples-1). */
  maxSamples: number;
}

/** Disturbance injection. A disturbance enters the plant as an additive process input. */
export interface Disturbance {
  /** First sample index at which the disturbance is applied (inclusive). */
  startStep: number;
  /** Last sample index (inclusive). null means "until the end". */
  endStep: number | null;
  /** Additive disturbance amplitude on the process-input side. */
  amplitude: number;
}

/** Scheduled setpoint change applied when the sample index equals `step`. */
export interface SetpointChange {
  step: number;
  setpoint: number;
}

/** Full internal controller state needed for bit-exact continuation. */
export interface PidState {
 /** Integrator term I in output units. */
  integrator: number;
  /** Previous measurement used for the measurement derivative. */
  prevMeas: number;
  /** Filtered derivative state. */
  dFilt: number;
  /** Previous delivered (saturated) control, used for back-calculation. */
  prevU: number;
}

/** Plant internal state: first-order lag state plus integer delay queue. */
export interface PlantState {
  /** Continuous-state-equivalent output of the lag before the delay line. */
  x: number;
  /**
   * Delay line of commanded actuator values, oldest first. Length equals delaySteps.
   * With delaySteps = 0 the queue is empty and the command applies immediately.
   */
  delayLine: number[];
}

export interface LoopState {
  /** Next sample index that will be produced (k). */
  step: number;
  setpoint: number;
  plant: PlantState;
  pid: PidState;
  /** Last measured output y[k]. */
  measurement: number;
}

export interface PidComponents {
  p: number;
  i: number;
  d: number;
  /** Unsaturated controller demand. */
  v: number;
  /** Saturated, delivered actuator command. */
  u: number;
  saturatedHigh: boolean;
  saturatedLow: boolean;
}

export interface SampleRow {
  scenarioId: number;
  versionId: number;
  step: number;
  setpoint: number;
  measurement: number;
  error: number;
  p: number;
  i: number;
  d: number;
  demand: number;
  control: number;
  disturbance: number;
}

export interface PerformanceReport {
  overshoot: number | null;
  steadyStateError: number | null;
  iae: number;
  settlingTime: number | null;
  settled: boolean;
  finalStep: number;
  finalError: number;
  peakAbsolute: number;
}
