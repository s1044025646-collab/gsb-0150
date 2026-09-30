import type { PerformanceReport, SampleRow } from "./types.ts";

/**
 * Compute response performance metrics.
 *
 * @param samples ordered samples (k ascending)
 * @param toleranceBand absolute error band that must be ENTERED and then HELD
 *        for all subsequent samples. A first crossing is not settling.
 */
export function computeReport(samples: SampleRow[], toleranceBand: number, ts: number): PerformanceReport {
  if (samples.length === 0) {
    throw new Error("computeReport requires at least one sample");
  }
  if (!(toleranceBand > 0) || !Number.isFinite(toleranceBand)) {
    throw new Error("toleranceBand must be a finite positive number");
  }
  if (!(ts > 0) || !Number.isFinite(ts)) {
    throw new Error("ts must be a finite positive number");
  }

  const first = samples[0] as SampleRow;
  const last = samples[samples.length - 1] as SampleRow;
  const y0 = first.measurement;

  let iae = 0;
  let peakAbsolute = 0;
  let overshoot: number | null = null;

  for (let idx = 0; idx < samples.length; idx++) {
    const s = samples[idx] as SampleRow;
    iae += Math.abs(s.error);
    const absY = Math.abs(s.measurement);
    if (absY > peakAbsolute) peakAbsolute = absY;

    // Overshoot relative to the setpoint magnitude actually demanded at that sample.
    const span = s.setpoint - y0;
    if (Math.abs(span) > 0) {
      const achieved = s.measurement - y0;
      const ratio = (achieved - span) / Math.abs(span);
      if (ratio > 0 && (overshoot === null || ratio > overshoot)) overshoot = ratio;
    }
  }
  // Settling: earliest index after which |error| <= band for ALL remaining samples.
  let settleIdx = -1;
  for (let idx = 0; idx < samples.length; idx++) {
    let holds = true;
    for (let j = idx; j < samples.length; j++) {
      if (Math.abs((samples[j] as SampleRow).error) > toleranceBand) {
        holds = false;
        break;
      }
    }
    if (holds) {
      settleIdx = idx;
      break;
    }
  }

  const settled = settleIdx >= 0;

  return {
    overshoot,
    steadyStateError: last.error,
    iae,
    settlingTime: settled ? (settleIdx as number) * ts : null,
    settled,
    finalStep: last.step,
    finalError: last.error,
    peakAbsolute,
  };
}
