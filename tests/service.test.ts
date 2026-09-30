import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDatabase } from "../src/db.ts";
import { divergencePid, hugeScalePlant, loadDisturbance, stablePid, stepScenario } from "../src/fixtures.ts";
import { Repository } from "../src/repo.ts";
import { Service } from "../src/service.ts";
import { AppError } from "../src/errors.ts";

describe("service persistence and failure paths", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pid-eval-"));
    dbPath = join(dir, "test.db");
  });

  function build() {
    const db = openDatabase(dbPath);
    let tick = 0;
    const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));
    migrate(db, clock);
    const repo = new Repository(db);
    const service = new Service(repo, clock);
    return { db, repo, service };
  }

  it("rejects invalid plant parameters with a stable error code", () => {
    const { service } = build();
    assert.throws(
      () => service.createScenario({ ...stepScenario(), plant: { ...stepScenario().plant, tau: 0 } }),
      (err: unknown) => err instanceof AppError && err.code === "INVALID_PARAM",
    );
  });

  it("stops and records non-finite divergence while keeping prior history", () => {
    const { db, service } = build();
    const spec = stepScenario({ maxSamples: 1000, plant: hugeScalePlant() });
    const scenario = service.createScenario(spec);
    const version = service.addPidVersion(scenario.id, "wild", divergencePid());
    const result = service.run(version.id, 1000);
    assert.equal(result.status, "stopped");
    assert.equal(result.reason, "diverged");

    const stored = service.requireVersion(version.id);
    assert.equal(stored.status, "stopped");
    assert.equal(stored.stop_reason, "diverged");
    assert.ok(stored.last_error && stored.last_error.includes("sample"));
    assert.ok(service.exportSamples(version.id).length > 0);

    assert.throws(() => service.run(version.id, 1), (err: unknown) => err instanceof AppError && err.code === "RUN_STOPPED");
    db.close();
  });

  it("rolls a failing batch back so continuation remains consistent", () => {
    const { db, repo, service } = build();
    const scenario = service.createScenario(stepScenario());
    const version = service.addPidVersion(scenario.id, "stable", stablePid());
    service.run(version.id, 20);
    const countBefore = repo.countSamples(version.id);

    // Corrupt the persisted resume state so JSON.parse fails inside the run
    // transaction; the whole batch must roll back (sample count unchanged).
    db.prepare("UPDATE versions SET loop_state = ? WHERE id = ?").run("{broken-json", version.id);
    assert.throws(() => service.run(version.id, 5));
    assert.equal(repo.countSamples(version.id), countBefore);
    db.close();
  });

  it("restart reproduces identical history and resume state from disk", () => {
    const built = build();
    const scenario = built.service.createScenario(stepScenario({ maxSamples: 60 }));
    const version = built.service.addPidVersion(scenario.id, "stable", stablePid());
    built.service.addDisturbance(scenario.id, loadDisturbance(20, -0.3, 25));
    built.service.run(version.id, 25);
    const partialSamples = built.service.exportSamples(version.id);
    const partialState = (built.repo.getVersion(version.id) as { loop_state: string }).loop_state;
    built.db.close();

    const restarted = build();
    assert.deepEqual(restarted.service.exportSamples(version.id), partialSamples);
    assert.equal((restarted.repo.getVersion(version.id) as { loop_state: string }).loop_state, partialState);
    const resumed = restarted.service.resume(version.id, 35);
    assert.equal(resumed.status, "finished");

    // Continuous reference from scratch must match the chunked/restarted trajectory.
    const reference = build();
    const refScenario = reference.service.createScenario(stepScenario({ maxSamples: 60 }));
    const refVersion = reference.service.addPidVersion(refScenario.id, "stable", stablePid());
    reference.service.addDisturbance(refScenario.id, loadDisturbance(20, -0.3, 25));
    reference.service.run(refVersion.id, 60);

    const a = restarted.service.exportSamples(version.id);
    const b = reference.service.exportSamples(refVersion.id);
    assert.equal(a.length, b.length);
    for (let k = 0; k < a.length; k++) {
      const { scenarioId: _s1, versionId: _v1, ...left } = a[k] as Record<string, unknown> & { scenarioId: number; versionId: number };
      const { scenarioId: _s2, versionId: _v2, ...right } = b[k] as Record<string, unknown> & { scenarioId: number; versionId: number };
      assert.deepEqual(left, right, `sample ${k} differs after resume/restart`);
    }
    restarted.db.close();
    reference.db.close();
  });

  it("running migrations twice is a no-op", () => {
    const { db } = build();
    assert.doesNotThrow(() => migrate(db, () => new Date().toISOString()));
    db.close();
  });

  it("cleans temp directory", () => {
    rmSync(dir, { recursive: true, force: true });
  });
});
