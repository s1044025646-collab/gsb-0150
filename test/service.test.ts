import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, samples, approx, type Harness } from './helpers.js';
import { scenario } from '../src/fixtures/fixtures.js';
import { AppError } from '../src/core/errors.js';
import { openDatabase } from '../src/db/database.js';
import { RunService } from '../src/core/service.js';
import type { CreateRunInput } from '../src/core/service.js';

function setup(): Harness {
  const harness = makeHarness();
  after(() => harness.cleanup());
  return harness;
}

function runEnd(h: Harness, input: CreateRunInput): string {
  const { run } = h.svc.createRun(input);
  h.svc.runToEnd(run.id);
  return run.id;
}

test('IAE accumulates time-weighted absolute error', () => {
  const h = setup();
  const id = runEnd(h, scenario('pureProportionalStep'));
  const rows = samples(h.svc, id);
  let iae = 0;
  for (const r of rows) iae += Math.abs(r.error) * 0.5;
  assert.ok(approx(iae, h.svc.repo.getRun(id).iae, 1e-12));
  assert.ok(approx(rows[rows.length - 1]!.iae, iae, 1e-12));
  assert.ok(iae > 0);
});

test('integrator windup is bounded and recovers without unbounded residue', () => {
  const h = setup();
  const id = runEnd(h, scenario('integralWindup'));
  const rows = samples(h.svc, id);
  assert.ok(rows.some((r) => r.saturated === 1), 'scenario must saturate');
  const maxI = Math.max(...rows.map((r) => r.iTerm));
  assert.ok(Number.isFinite(maxI) && maxI < 100);
  const maxTailErr = Math.max(...rows.slice(-20).map((r) => Math.abs(r.error)));
  assert.ok(maxTailErr < 0.5, `tail error ${maxTailErr}`);
});

test('back-calculation anti-windup also recovers', () => {
  const h = setup();
  const input = scenario('integralWindup');
  input.idempotencyKey = 'backcalc-1';
  input.pid = { kp: 0.2, ki: 2.5, kd: 0, tf: 0, antiWindup: 'backcalc', kaw: 0.8 };
  const id = runEnd(h, input);
  const rows = samples(h.svc, id);
  assert.ok(Math.max(...rows.slice(-20).map((r) => Math.abs(r.error))) < 0.6);
  assert.ok(rows.every((r) => Number.isFinite(r.iTerm)));
});

test('setpoint step never injects a derivative spike', () => {
  const h = setup();
  const jumped = scenario('setpointChange');
  const flat = scenario('setpointChange');
  flat.idempotencyKey = 'no-sp-jump';
  flat.events = [];
  const a = samples(h.svc, runEnd(h, jumped)).find((r) => r.k === 40)!;
  const b = samples(h.svc, runEnd(h, flat)).find((r) => r.k === 40)!;
  assert.ok(Math.abs(a.dTerm - b.dTerm) < 1e-12, 'setpoint jump changed the D term');
});

test('settling requires staying inside the band after the reported time', () => {
  const h = setup();
  const id = runEnd(h, scenario('delayed'));
  const rep = h.svc.report(id);
  const rows = samples(h.svc, id);
  if (rep.settled) {
    const band = Math.abs(rows[rows.length - 1]!.sp) * 0.05;
    for (let i = rep.settlingSample!; i < rows.length; i++) {
      assert.ok(Math.abs(rows[i]!.error) <= band + 1e-9, `violation at k=${i}`);
    }
  }
});

test('a never-settling run is marked settled=false, not first-crossing time', () => {
  const h = setup();
  const input = scenario('pureProportionalStep');
  input.idempotencyKey = 'p-only-offset';
  input.pid = { kp: 0.05, ki: 0, kd: 0, tf: 0, antiWindup: 'freeze', kaw: 1 };
  input.maxSamples = 60;
  const rep = h.svc.report(runEnd(h, input));
  assert.equal(rep.settled, false);
  assert.equal(rep.settlingTimeSeconds, null);
  assert.ok((rep.steadyStateError ?? 0) > 0.05);
});

test('unstable gains stop the run and record a divergence reason', () => {
  const h = setup();
  const id = runEnd(h, scenario('unstable'));
  const run = h.svc.repo.getRun(id);
  assert.equal(run.state.status, 'failed');
  assert.match(run.state.failureReason ?? '', /divergence|non-finite/);
  assert.equal(h.svc.report(id).failureReason, run.state.failureReason);
  assert.throws(
    () => h.svc.advance(id, 1),
    (e: unknown) => e instanceof AppError && e.code === 'RUN_NOT_RUNNING',
  );
});

test('pause/resume yields sample-identical output to one continuous run', () => {
  const h = setup();
  const cont = scenario('loadDisturbance');
  cont.idempotencyKey = 'cont';
  const cId = runEnd(h, cont);

  const split = scenario('loadDisturbance');
  split.idempotencyKey = 'split';
  const { run } = h.svc.createRun(split);
  h.svc.advance(run.id, 25);
  h.svc.pause(run.id);
  assert.equal(h.svc.repo.getRun(run.id).state.status, 'paused');
  h.svc.resume(run.id);
  h.svc.runToEnd(run.id);

  const a = samples(h.svc, cId);
  const b = samples(h.svc, run.id);
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assert.ok(approx(a[i]!.y, b[i]!.y, 1e-12), `y mismatch k=${i}`);
    assert.ok(approx(a[i]!.uCommand, b[i]!.uCommand, 1e-12), `u mismatch k=${i}`);
    assert.ok(approx(a[i]!.iTerm, b[i]!.iTerm, 1e-12), `I mismatch k=${i}`);
  }
});

test('history and checkpoint state survive a database reopen', () => {
  const h = setup();
  const input = scenario('setpointChange');
  const { run } = h.svc.createRun(input);
  h.svc.advance(run.id, 30);
  const before = samples(h.svc, run.id);
  const stateBefore = JSON.stringify(h.svc.repo.getRun(run.id).state);
  h.db.close();

  const db2 = openDatabase(`${h.dir}/t.sqlite`);
  const svc2 = new RunService(db2);
  assert.deepEqual(svc2.repo.getAllSamples(run.id), before);
  assert.equal(JSON.stringify(svc2.repo.getRun(run.id).state), stateBefore);
  svc2.advance(run.id, 5);
  assert.equal(svc2.repo.getRun(run.id).state.k, 35);
  db2.close();
});

test('repeated submission with the same key is idempotent', () => {
  const h = setup();
  const input = scenario('delayed');
  const r1 = h.svc.createRun(input);
  const r2 = h.svc.createRun(input);
  assert.equal(r1.created, true);
  assert.equal(r2.created, false);
  assert.equal(r1.run.id, r2.run.id);
});

test('invalid parameters are rejected with VALIDATION errors', () => {
  const h = setup();
  const badTau = scenario('delayed');
  badTau.plant = { ...badTau.plant, tau: 0 };
  assert.throws(
    () => h.svc.createRun(badTau),
    (e: unknown) => e instanceof AppError && e.code === 'VALIDATION',
  );
  const badAw = scenario('delayed');
  badAw.pid = { ...badAw.pid, antiWindup: 'nope' as 'freeze' };
  assert.throws(
    () => h.svc.createRun(badAw),
    (e: unknown) => e instanceof AppError && e.code === 'VALIDATION',
  );
});

test('rollback during advance leaves no partial samples or checkpoint shift', () => {
  const h = setup();
  const { run } = h.svc.createRun(scenario('delayed'));
  const count = () =>
    (h.db.prepare('SELECT COUNT(*) AS c FROM samples WHERE run_id = ?').get(run.id) as {
      c: number;
    }).c;
  assert.equal(count(), 0);
  assert.throws(() => {
    h.db.exec('BEGIN');
    try {
      h.svc.advance(run.id, 5); // nested BEGIN throws SQLITE_ERROR -> caught below
      h.db.exec('COMMIT');
    } catch (e) {
      h.db.exec('ROLLBACK');
      throw e;
    }
  });
  assert.equal(count(), 0);
  assert.equal(h.svc.repo.getRun(run.id).state.k, 0);
});

test('pagination returns stable pages and totals', () => {
  const h = setup();
  const id = runEnd(h, scenario('setpointChange'));
  const p1 = h.svc.repo.getSamples(id, 30, 0);
  const p2 = h.svc.repo.getSamples(id, 30, 30);
  assert.equal(p1.items.length, 30);
  assert.equal(p2.items.length, 30);
  assert.equal(p1.total, 120);
  assert.notEqual(p1.items[0]!.k, p2.items[0]!.k);
});
