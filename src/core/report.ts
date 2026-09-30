import type { RunConfig, RunReport, SampleRow } from './types.js';

/**
 * Performance report computed from the recorded samples.
 *
 * - Overshoot: max excursion beyond the final setpoint as a fraction of the
 *   commanded step size |spFinal - y0| (null if the step size is zero).
 * - Steady-state error: mean |error| over the last 10% of samples (min 1).
 * - IAE: trapezoid-style time-weighted integral of |e| accumulated during run.
 * - Settling time: FIRST time after which |e| stays within the band FOREVER.
 *   Briefly crossing inside the band does NOT count; the response must remain
 *   inside through the final recorded sample. Runs that never stay in band are
 *   marked settled=false with a null settling time.
 */
export function buildReport(
  cfg: RunConfig,
  samples: SampleRow[],
  status: RunReport['status'],
  failureReason: string | null,
  iae: number,
): RunReport {
  if (samples.length === 0) {
    return {
      status,
      samples: 0,
      overshoot: null,
      steadyStateError: null,
      iae: null,
      settlingTimeSeconds: null,
      settlingSample: null,
      settled: false,
      failureReason,
    };
  }

  const spFinal = samples[samples.length - 1]!.sp;
  const stepSize = spFinal - cfg.y0;
  const band = Math.abs(stepSize) * cfg.settlingFraction;

  let overshoot: number | null = null;
  if (stepSize !== 0) {
    let worst = 0;
    for (const s of samples) {
      const beyond = stepSize > 0 ? s.y - spFinal : spFinal - s.y;
      if (beyond > worst) worst = beyond;
    }
    overshoot = worst / Math.abs(stepSize);
  }

  const tailCount = Math.max(1, Math.ceil(samples.length * 0.1));
  let tailSum = 0;
  for (let i = samples.length - tailCount; i < samples.length; i++) {
    tailSum += Math.abs(samples[i]!.error);
  }
  const steadyStateError = tailSum / tailCount;

  // Settling: last violating sample; settled just after it, and never violated after.
  const tolerance = band === 0 ? 0 : band;
  let lastOutside = -1;
  for (const s of samples) {
    if (Math.abs(s.error) > tolerance) lastOutside = s.k;
  }
  const settled = lastInsideForever(lastOutside, samples, status);
  const settleK = settled ? lastOutside + 1 : null;

  return {
    status,
    samples: samples.length,
    overshoot,
    steadyStateError,
    iae,
    settlingSample: settleK,
    settlingTimeSeconds: settleK === null ? null : settleK * cfg.plant.ts,
    settled,
    failureReason,
  };
}

function lastInsideForever(
  lastOutside: number,
  samples: SampleRow[],
  status: RunReport['status'],
): boolean {
  if (status !== 'finished') return false;
  const last = samples[samples.length - 1]!.k;
  return lastOutside < last;
}
