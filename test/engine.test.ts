import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLoopStep, openLoopStepValue, plantCoeffs, initialState, step, restoreSnapshot } from '../src/core/engine.js';
import type { RunConfig } from '../src/core/types.js';

const plant = { gain: 2, tau: 4, ts: 1, delaySamples: 0, uMin: -10, uMax: 10 };

function cfg(over: Partial<RunConfig> = {}): RunConfig {
  return {
    id: 'r1',
    idempotencyKey: 'k',
    plant,
    pid: { kp: 0, ki: 0, kd: 0, tf: 0, antiWindup: 'freeze', kaw: 1 },
    setpoint: 1,
    y0: 0,
    maxSamples: 50,
    settlingFraction: 0.05,
    events: [],
    ...over,
  };
}

test('ZOH recursion matches analytic first-order open-loop step response', () => {
  const p = { ...plant };
  const { a } = plantCoeffs(p);
  let y = 0;
  for (let k = 0; k < 12; k++) {
    y = openLoopStep(p, y, 1, 0); // held input u=1 -> steady state K*u = 2
    const analytic = openLoopStepValue(p, 0, 1, k + 1);
    assert.ok(Math.abs(y - analytic) < 1e-12, `k=${k}`);
  }
  assert.ok(Math.abs(y - 2 * (1 - Math.pow(a, 12))) < 1e-12);
});

test('open-loop analytic value tends to K*u and respects load', () => {
  const v = openLoopStepValue(plant, 0, 1, 500, 0);
  assert.ok(Math.abs(v - 2) < 1e-9);
  const vLoad = openLoopStepValue(plant, 2, 1, 500, -0.5);
  assert.ok(Math.abs(vLoad - 1.5) < 1e-9);
});

test('d=0 acts same sample; d=1 acts exactly one sample later', () => {
  const p0 = cfg({ plant: { ...plant, delaySamples: 0 } });
  const p1 = cfg({ plant: { ...plant, delaySamples: 1 } });

  // Controller outputs a constant nonzero demand from sample 0.
  for (const c of [p0, p1]) {
    c.pid = { kp: 1, ki: 0, kd: 0, tf: 0, antiWindup: 'freeze', kaw: 1 };
    c.setpoint = 1;
  }
  const s0 = restoreSnapshot(p0, initialState(p0), 0);
  const r0 = step(s0);
  const s1 = restoreSnapshot(p1, initialState(p1), 0);
  const r1 = step(s1);

  // d=0: u=1 applied immediately -> y1 = (1-a)*K = 2(1-a)
  const a = Math.exp(-plant.ts / plant.tau);
  assert.ok(Math.abs(r0.sample!.y - 2 * (1 - a)) < 1e-12);
  // d=1: plant still sees the initial steady input u0=0 -> y1 = 0
  assert.equal(r1.sample!.y, 0);
  assert.equal(r1.state.uApplied, 0);
  const r1b = step(s1);
  assert.ok(Math.abs(r1b.sample!.y - 2 * (1 - a)) < 1e-12);
});

test('pure proportional closed loop reaches the analytic biased steady state', () => {
  const c = cfg({
    maxSamples: 2000,
    pid: { kp: 0.8, ki: 0, kd: 0, tf: 0, antiWindup: 'freeze', kaw: 1 },
  });
  const snap = restoreSnapshot(c, initialState(c), 0);
  let lastY = 0;
  for (let i = 0; i < 2000; i++) lastY = step(snap).sample!.y;
  // y_ss = a*y + (1-a)*K*Kp*(1-y) -> y_ss = b*K*Kp / (1 - a + b*K*Kp)
  const a = Math.exp(-plant.ts / plant.tau);
  const b = 1 - a;
  const expected = (b * 2 * 0.8) / (1 - a + b * 2 * 0.8);
  assert.ok(Math.abs(lastY - expected) < 1e-9);
});

test('derivative is on measurement: a setpoint step causes no derivative kick', () => {
  // Compare two otherwise identical runs: one with an SP jump at k=10, one
  // without. D-on-measurement means the jump cannot change D until the
  // MEASUREMENT actually moves; derivative-on-error would kick immediately.
  const mk = (events: RunConfig['events']) =>
    cfg({
      plant: { gain: 1, tau: 5, ts: 0.5, delaySamples: 0, uMin: -10, uMax: 10 },
      pid: { kp: 0.5, ki: 0.1, kd: 1, tf: 0, antiWindup: 'freeze', kaw: 1 },
      setpoint: 1,
      events,
    });
  const run = (c: RunConfig) => {
    const snap = restoreSnapshot(c, initialState(c), 0);
    const ds: number[] = [];
    for (let i = 0; i <= 10; i++) ds.push(step(snap).sample!.dTerm);
    return ds;
  };
  const withJump = run(mk([{ key: 'sp', atSample: 10, kind: 'setpoint', value: 3 }]));
  const noJump = run(mk([]));
  assert.ok(Math.abs(withJump[10]! - noJump[10]!) < 1e-12, 'D must ignore the SP jump');
});

test('derivative filter smooths a measurement jump', () => {
  const c = cfg({
    plant: { gain: 1, tau: 5, ts: 1, delaySamples: 0, uMin: -10, uMax: 10 },
    pid: { kp: 0, ki: 0, kd: 2, tf: 1, antiWindup: 'freeze', kaw: 1 },
    setpoint: 10,
  });
  const snap = restoreSnapshot(c, initialState(c), 0);
  const r = step(snap);
  // yf at k0 with y jump 0..y1: alpha=0.5 => yf = 0.5*y1, D = -Kd*(yf-0)/Ts
  const y1 = r.sample!.y;
  const expectedD = -2 * (0.5 * y1) / 1;
  assert.ok(Math.abs(r.sample!.dTerm - expectedD) < 1e-12);
});

test('non-finite produced values fail the run with a reason', () => {
  const c = cfg({ plant: { ...plant, tau: Number.NaN } });
  const snap = restoreSnapshot(c, initialState(c), 0);
  const r = step(snap);
  assert.equal(r.state.status, 'failed');
  assert.match(r.state.failureReason ?? '', /non-finite/);
});
