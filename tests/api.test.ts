import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { migrate, openDatabase, withTransaction } from "../src/db.ts";
import { stablePid, stepScenario } from "../src/fixtures.ts";
import { Repository } from "../src/repo.ts";
import { Service } from "../src/service.ts";
import { startServer } from "../src/server.ts";

describe("HTTP API", () => {
  const dir = mkdtempSync(join(tmpdir(), "pid-api-"));
  const db = openDatabase(join(dir, "api.db"));
  let tick = 0;
  const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));
  migrate(db, clock);
  const repo = new Repository(db);
  const service = new Service(repo, clock);

  let server: Server;
  let port: number;

  before(async () => {
    const started = await startServer({ repo, service }, 0);
    server = started.server;
    port = started.port;
  });
  after(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function call(method: string, path: string, body?: unknown, key?: string) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  it("creates a scenario and validates input with an explicit error code", async () => {
    const ok = await call("POST", "/scenarios", stepScenario());
    assert.equal(ok.status, 201);
    assert.equal(typeof (ok.json as { id: number }).id, "number");

    const bad = await call("POST", "/scenarios", { ...stepScenario(), plant: { ...stepScenario().plant, delaySteps: -1 } });
    assert.equal(bad.status, 400);
    assert.equal((bad.json as { error: { code: string } }).error.code, "INVALID_PARAM");

    const malformed = await fetch(`http://127.0.0.1:${port}/scenarios`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const badJson = (await malformed.json()) as { error: { code: string } };
    assert.equal(malformed.status, 400);
    assert.equal(badJson.error.code, "BAD_JSON");
  });

  it("paginates scenarios", async () => {
    const res = await call("GET", "/scenarios?limit=1&offset=0");
    const body = res.json as { data: unknown[]; pagination: { total: number; hasMore: boolean } };
    assert.equal(body.data.length, 1);
    assert.ok(body.pagination.total >= 1);
    assert.equal(body.pagination.hasMore, body.pagination.total > 1);
  });

  it("runs a PID version chunked and returns the final report", async () => {
    const created = await call("POST", "/scenarios", stepScenario({ maxSamples: 40, name: "api-run" }));
    const sid = (created.json as { id: number }).id;
    const pv = await call("POST", `/scenarios/${sid}/versions`, { label: "p", ...stablePid() });
    const vid = (pv.json as { id: number }).id;
    const first = await call("POST", `/versions/${vid}/run`, { steps: 15 });
    assert.equal((first.json as { produced: number }).produced, 15);
    const resumed = await call("POST", `/versions/${vid}/resume`, { steps: 25 });
    assert.equal((resumed.json as { status: string }).status, "finished");

    const report = await call("GET", `/versions/${vid}/report?band=0.05`);
    assert.equal(report.status, 200);
    const rpt = report.json as { settled: boolean; settlingTime: number | null; iae: number };
    assert.equal(typeof rpt.iae, "number");
    assert.ok(rpt.settled === true || rpt.settlingTime === null);
  });

  it("returns 404 for missing resources", async () => {
    const res = await call("GET", "/scenarios/999999");
    assert.equal(res.status, 404);
    assert.equal((res.json as { error: { code: string } }).error.code, "NOT_FOUND");
  });

  it("deduplicates repeated POST submissions via idempotency key", async () => {
    const payload = stepScenario({ name: "idempotent" });
    const a = await call("POST", "/scenarios", payload, "fixed-key-123");
    const b = await call("POST", "/scenarios", payload, "fixed-key-123");
    assert.equal(a.status, b.status);
    assert.deepEqual(a.json, b.json);

    const conflict = await call("POST", "/scenarios", { ...payload, name: "different" }, "fixed-key-123");
    assert.equal(conflict.status, 409);
    assert.equal((conflict.json as { error: { code: string } }).error.code, "INVALID_IDEMPOTENCY_KEY");
  });

  it("rolls back a transaction when a statement fails", () => {
    const before = repo.listScenarios(1000, 0).total;
    assert.throws(() =>
      withTransaction(db, () => {
        repo.createScenario({
          name: "tx",
          plant: stepScenario().plant,
          setpoint: 1,
          y0: 0,
          maxSamples: 10,
          now: new Date().toISOString(),
        });
        throw new Error("force rollback");
      }),
    );
    assert.equal(repo.listScenarios(1000, 0).total, before);
  });
});
