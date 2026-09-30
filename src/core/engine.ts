import { AppError } from './errors.js';
import type {
  PidConfig,
  PlantConfig,
  RunConfig,
  RunState,
  SampleRow,
  StepResult,
} from './types.js';

/**
 * First-order inertial plant with integer sample delay, zero-order hold.
 *
 * Continuous:   tau * dy/dt = -y + K * u(t-d) + load
 * With ZOH over Ts:
 *   a   = exp(-Ts/tau)
 *   b   = 1 - a
 *   y[k+1] = a*y[k] + b*(K*uDelayed[k] + load[k])
 *
 * Delay d is an INTEGER number of samples on the actuator path:
 *   d = 0 -> u[k] acts on the plant within the SAME sample;
 *   d = 1 -> u[k] acts only from sample k+1 onward.
 * The delay line is initialised at the steady actuator value u0 = sat(y0 / K),
 * assuming the run starts at rest with zero load.
 */

export interface DiscreteCoeffs {
  a: number;
  b: number;
  k: number;
}

export function plantCoeffs(p: PlantConfig): DiscreteCoeffs {
  const a = Math.exp(-p.ts / p.tau);
  return { a, b: 1 - a, k: p.gain };
}

/** Open-loop (controller disabled) plant update used by fixtures and tests. */
export function openLoopStep(p: PlantConfig, y: number, uDelayed: number, load: number): number {
  const { a, b, k } = plantCoeffs(p);
  return a * y + b * (k * uDelayed + load);
}

/** Closed-form open-loop unit/arbitrary step response: y[k] after k samples held at u. */
export function openLoopStepValue(
  p: PlantConfig,
  y0: number,
  u: number,
  kSamples: number,
  load = 0,
): number {
  const { a, b, k } = plantCoeffs(p);
  const yInf = k * u + load;
  return yInf + (y0 - yInf) * Math.pow(a, kSamples);
}

function sat(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function initialState(cfg: RunConfig): RunState {
  const { plant, y0, setpoint } = cfg;
  // Steady actuator for initial output y0 with zero load; K=0 -> 0.
  const u0 = plant.gain !== 0 ? sat(y0 / plant.gain, plant.uMin, plant.uMax) : 0;
  const queue = new Array<number>(plant.delaySamples).fill(u0);
  return {
    k: 0,
    y: y0,
    sp: setpoint,
    load: 0,
    delayQueue: queue,
    uApplied: u0,
    uCommand: u0,
    pid: {
      integral: 0,
      prevError: setpoint - y0,
      prevFilteredY: y0,
      prevY: y0,
      pTerm: 0,
      iTerm: 0,
      dTerm: 0,
      vUnsat: 0,
    },
    status: 'running',
    failureReason: null,
  };
}

export interface EngineSnapshot {
  config: RunConfig;
  state: RunState;
  iae: number;
}

/**
 * Advance exactly one sample with a fixed, documented order:
 *
 *  1. Apply scheduled events at sample k (setpoint / held load disturbance).
 *  2. READ measurement y[k].
 *  3. COMPUTE PID demand from sp[k], y[k] and the controller's internal state:
 *       P = Kp * e               (e = sp - y)
 *       I += Ki * e * Ts         (then corrected by the anti-windup rule)
 *       D = -Kd * (yf[k]-yf[k-1]) / Ts   -> derivative on MEASUREMENT, so a
 *             setpoint step causes NO derivative kick.
 *       yf is a first-order filter with time constant tf (alpha = tf/(tf+Ts));
 *       tf = 0 falls back to the raw one-step measurement difference.
 *  4. SATURATE demand into [uMin, uMax].
 *  5. ANTI-WINDUP:
 *       freeze    -> keep the pre-update integrator while saturated in the
 *                     push-away direction (conditional integration);
 *       backcalc  -> I[k] = Iprev + Ki*e*Ts - Kaw*(uSat - vUnsat)*Ts.
 *  6. APPLY DELAY: u[k] enters the tail; the head (u[k-d]) drives the plant.
 *  7. ADVANCE plant with ZOH recursion and the held load disturbance.
 *  8. Persist the sample; non-finite/exploding values fail the run.
 */
export function step(snap: EngineSnapshot): StepResult {
  const { config, state } = snap;
  if (state.status !== 'running') {
    throw new AppError('RUN_NOT_RUNNING', `run is ${state.status}`);
  }
  const k = state.k;
  const { plant, pid } = config;

  // 1. events
  for (const ev of config.events) {
    if (ev.atSample === k) {
      if (ev.kind === 'setpoint') state.sp = ev.value;
      else state.load = ev.value;
    }
  }

  // 2. read
  const y = state.y;
  const sp = state.sp;
  const e = sp - y;

  // 3. PID
  const ts = plant.ts;
  const integralTrial = state.pid.integral + pid.ki * e * ts;

  let yf: number;
  if (pid.tf > 0) {
    const alpha = pid.tf / (pid.tf + ts);
    yf = alpha * state.pid.prevFilteredY + (1 - alpha) * y;
  } else {
    yf = y;
  }
  const dTerm = -pid.kd * ((yf - state.pid.prevFilteredY) / ts);
  const pTerm = pid.kp * e;
  const vUnsat = pTerm + integralTrial + dTerm;

  // 4. saturate
  const uSat = sat(vUnsat, plant.uMin, plant.uMax);
  const saturated = uSat !== vUnsat ? 1 : 0;

  // 5. anti-windup
  let integralFinal = integralTrial;
  if (saturated) {
    if (pid.antiWindup === 'freeze') {
      // Conditional integration: while the actuator is against a limit,
      // reject integral updates whose sign would push into that same limit.
      const pushesHigh = uSat >= plant.uMax && e > 0;
      const pushesLow = uSat <= plant.uMin && e < 0;
      if (pushesHigh || pushesLow) integralFinal = state.pid.integral;
    } else {
      // Back-calculation tracking (e.g. Åström):
      //   I += Ki*e*Ts + Kaw*(uSat - vUnsat)*Ts
      // While saturated the tracking term pulls the integrator toward a value
      // consistent with the achievable actuator output, so it stays bounded
      // and self-corrects once the loop leaves saturation.
      integralFinal = integralTrial + pid.kaw * (uSat - vUnsat) * ts;
    }
  }

  // 6. delay line (d = 0 => same-sample actuation; d = 1 => one sample later)
  state.delayQueue.push(uSat);
  const uApplied = state.delayQueue.shift() as number;

  // 7. plant
  const { a, b } = plantCoeffs(plant);
  const yNext = a * y + b * (plant.gain * uApplied + state.load);

  // 8. bookkeeping + divergence guard
  state.pid.prevError = e;
  state.pid.prevY = y;
  state.pid.prevFilteredY = yf;
  state.pid.integral = integralFinal;
  state.pid.pTerm = pTerm;
  state.pid.iTerm = integralFinal;
  state.pid.dTerm = dTerm;
  state.pid.vUnsat = vUnsat;
  state.uCommand = uSat;
  state.uApplied = uApplied;
  state.y = yNext;
  state.k = k + 1;

  const values = [
    yNext, integralFinal, pTerm, integralFinal, dTerm, vUnsat, uSat, uApplied, sp, state.load,
  ];
  if (!values.every(Number.isFinite) || Math.abs(yNext) > 1e12) {
    state.status = 'failed';
    state.failureReason = !values.every(Number.isFinite)
      ? `non-finite value produced at sample ${k}`
      : `numerical divergence at sample ${k} (|y| > 1e12)`;
  } else if (state.k >= config.maxSamples) {
    state.status = 'finished';
  }

  snap.iae += Math.abs(e) * ts;
  const sample: SampleRow = {
    runId: config.id,
    k,
    sp,
    // Record the state AFTER this sample's plant advance; error and terms
    // still correspond to the measurement read at the start of the sample.
    y: state.y,
    error: e,
    pTerm,
    iTerm: integralFinal,
    dTerm,
    vUnsat,
    uCommand: uSat,
    uApplied,
    load: state.load,
    saturated: saturated as 0 | 1,
    iae: snap.iae,
  };
  return { state, sample: state.status === 'failed' ? sample : sample };
}

/** Restore an engine snapshot from persisted state (checkpoint resume). */
export function restoreSnapshot(config: RunConfig, state: RunState, iae: number): EngineSnapshot {
  return { config, state, iae };
}

export { sat };
