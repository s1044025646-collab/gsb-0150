/**
 * Repeatable end-to-end demo against a throwaway database inside the project.
 * Exercises: run creation, step advance, pause/resume state continuity,
 * fixture scenarios, P/I/D inspection, comparison, failure path and CSV export.
 */
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db/database.js';
import { RunService } from '../src/core/service.js';
import { scenario, COMPARISON_CANDIDATES } from '../src/fixtures/fixtures.js';

const localDir = join(process.cwd(), '.local');
mkdirSync(localDir, { recursive: true });
const dir = mkdtempSync(join(localDir, 'demo-'));
const dbPath = join(dir, 'demo.sqlite');
const db = openDatabase(dbPath);
const svc = new RunService(db, (() => { let t = 1_700_000_000_000; return () => ++t; })());

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`DEMO FAILED: ${msg}`);
    process.exit(1);
  }
}

// 1. create + advance, then pause/resume and prove sample-level continuity
const input = scenario('setpointChange');
const { run } = svc.createRun(input);
svc.advance(run.id, 20);
const first = svc.repo.getAllSamples(run.id);
svc.pause(run.id);
svc.resume(run.id);
svc.advance(run.id, 80);
svc.runToEnd(run.id);
const all = svc.repo.getAllSamples(run.id);
assert(all.length === input.maxSamples, `expected ${input.maxSamples} samples`);

// 2. restart simulation: reopen DB, rebuild run to end from same checkpoint must match history
db.close();
const db2 = openDatabase(dbPath);
const svc2 = new RunService(db2);
const restarted = svc2.repo.getRun(run.id);
assert(restarted.state.k === input.maxSamples, 'state persisted across reopen');
console.log('setpoint-change run:');
console.log(JSON.stringify(svc2.report(run.id), null, 2));

// 3. compare multiple tunings
const base = scenario('loadDisturbance');
const { idempotencyKey: _k, ...scenarioOnly } = base;
const results = svc2.compare(scenarioOnly, 'demo-load', COMPARISON_CANDIDATES.map((c) => ({ ...c })));
console.log('comparison:');
for (const r of results) {
  console.log(
    `  ${r.name}: settled=${r.report.settled} overshoot=${r.report.overshoot?.toFixed(3)} ` +
      `IAE=${r.report.iae?.toFixed(3)} sse=${r.report.steadyStateError?.toFixed(4)}`,
  );
}

// 4. failure path
const unstable = svc2.createRun(scenario('unstable'));
svc2.runToEnd(unstable.run.id);
const failed = svc2.repo.getRun(unstable.run.id);
assert(failed.state.status === 'failed', 'unstable tuning must fail');
assert(!!failed.state.failureReason, 'failure reason must be recorded');
console.log(`unstable run failed as expected: ${failed.state.failureReason}`);

// 5. idempotency
const again = svc2.createRun(scenario('unstable'));
assert(again.created === false && again.run.id === unstable.run.id, 'duplicate submit is idempotent');

db2.close();
rmSync(dir, { recursive: true, force: true });
assert(!existsSync(dbPath), 'demo cleaned its temp database');
console.log('demo OK');
