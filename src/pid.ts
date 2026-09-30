import type { PidComponents, PidParams, PidState } from "./types.ts";

export function initialPidState(y0: number): PidState {
  return { integrator: 0, prevMeas: y0, dFilt: 0, prevU: 0 };
}

function saturate(u: number, uMin: number, uMax: number): { u: number; low: boolean; high: boolean } {
  if (u < uMin) return { u: uMin, low: true, high: false };
  if (u > uMax) return { u: uMax, low: false, high: true };
  return { u, low: false, high: false };
}

/**
 * One PID update using the MEASUREMENT derivative (derivative-on-measurement),
 * which avoids a derivative kick when the setpoint changes.
 *
 *   e[k]   = sp - y[k]
 *   dRaw   = kd * (y[k-1] - y[k]) / Ts      (measurement derivative)
 *   dFilt  = low-pass first-order update with time constant tdFilter
 *   v      = kp*e + I + dFilt
 *   u      = sat(v)
 *
 * Anti-windup:
 *   "freeze"    : while saturated in the wrong direction the integrator is held;
 *                 it can still integrate toward unsaturating, so recovery leaves
 *                 no stale, unbounded integral.
 *   "backcalc"  : after saturation I is corrected with I -= ki*Ts*(u - v)/tt-like
 *                 tracking (conditional back-calculation), clamped so the
 *                 correction never pushes further into saturation.
 */
export function pidStep(
  state: PidState,
  params: PidParams,
  setpoint: number,
  measurement: number,
  ts: number,
  uMin: number,
  uMax: number,
): { components: PidComponents; state: PidState } {
  const error = setpoint - measurement;

  // Measurement derivative with first-order low-pass filter.
  const dRaw = params.kd * (state.prevMeas - measurement) / ts;
  let dFilt: number;
  if (params.tdFilter > 0) {
    const alpha = ts / (params.tdFilter + ts);
    dFilt = state.dFilt + alpha * (dRaw - state.dFilt);
  } else {
    dFilt = dRaw;
  }

  // Tentative integrator increment (positional form).
  const deltaI = params.ki * ts * error;
  let integrator = state.integrator + deltaI;

  const p = params.kp * error;
  const vUnsat = p + integrator + dFilt;
  const sat = saturate(vUnsat, uMin, uMax);

  let saturatedHigh = false;
  let saturatedLow = false;
  if (sat.high) {
    saturatedHigh = true;
    if (params.antiWindup === "freeze") {
      // Only freeze when the error would wind the integrator up further.
      if (deltaI > 0) integrator = state.integrator;
    } else {
      // Conditional back-calculation: remove the part of the integral that
      // drove the demand beyond the upper bound.
      const excess = vUnsat - uMax;
      const correction = Math.min(excess, Math.max(0, deltaI));
      integrator -= correction;
    }
  } else if (sat.low) {
    saturatedLow = true;
    if (params.antiWindup === "freeze") {
      if (deltaI < 0) integrator = state.integrator;
    } else {
      const excess = uMin - vUnsat;
      const correction = Math.min(excess, Math.max(0, -deltaI));
      integrator += correction;
    }
  }

  const demand = p + integrator + dFilt;
  const finalSat = saturate(demand, uMin, uMax);
  const u = finalSat.u;

  const next: PidState = {
    integrator,
    prevMeas: measurement,
    dFilt,
    prevU: u,
  };

  const components: PidComponents = {
    p,
    i: integrator,
    d: dFilt,
    v: demand,
    u,
    saturatedHigh: finalSat.high,
    saturatedLow: finalSat.low,
  };

  return { components, state: next };
}
