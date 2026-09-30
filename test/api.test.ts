import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import { Router } from '../src/api/http.js';
import { registerRoutes } from '../src/api/routes.js';
import { openDatabase } from '../src/db/database.js';
import { RunService } from '../src/core/service.js';
import { scenario } from '../src/fixtures/fixtures.js';

interface TestServer {
  base: string;
  stop: () => Promise<void>;
  dbPath: string;
  dir: string;
}

async function startServer(): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), 'pid-api-'));
  const dbPath = join(dir, 'api.sqlite');
  const db = openDatabase(dbPath);
  let t = 1_700_000_000_000;
  const svc = new RunService(db, () => ++t);
  const router = new Router();
  registerRoutes(router, svc);
  const server = createServer((req, res) => void router.handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    dbPath,
    dir,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          db.close();
          rmSync(dir, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}

async function req(
  base: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers: init.body ? { 'content-type': 'application/json' } : undefined,
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

test('API: health, validation error codes and not found', async () => {
  const srv = await startServer();
  after(() => srv.stop());

  assert.equal((await req(srv.base, '/health')).status, 200);

  const bad = await req(srv.base, '/runs', {
    method: 'POST',
    body: { idempotencyKey: 'x', plant: {}, pid: {} },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'VALIDATION');

  const missing = await req(srv.base, '/runs/nope');
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'NOT_FOUND');

  const badJson = await fetch(`${srv.base}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  }).then(async (r) => ({ status: r.status, json: await r.json() }));
  assert.equal(badJson.status, 400);
  assert.equal(badJson.json.error.code, 'BAD_JSON');
});

test('API: create is idempotent, advance, report, paginated samples and P/I/D terms', async () => {
  const srv = await startServer();
  after(() => srv.stop());
  const body = scenario('pureProportionalStep');

  const c1 = await req(srv.base, '/runs', { method: 'POST', body });
  const c2 = await req(srv.base, '/runs', { method: 'POST', body });
  assert.equal(c1.status, 200);
  assert.equal(c1.json.created, true);
  assert.equal(c2.json.created, false);
  assert.equal(c1.json.run.id, c2.json.run.id);
  const id = c1.json.run.id as string;

  const adv = await req(srv.base, `/runs/${id}/advance`, { method: 'POST', body: { n: 10 } });
  assert.equal(adv.status, 200);
  assert.equal(adv.json.run.k, 10);

  const page = await req(srv.base, `/runs/${id}/samples?limit=4&offset=2`);
  assert.equal(page.json.items.length, 4);
  assert.equal(page.json.total, 10);
  assert.equal(page.json.items[0].k, 2);

  await req(srv.base, `/runs/${id}/advance`, { method: 'POST', body: { n: 500 } });
  const report = await req(srv.base, `/runs/${id}/report`);
  assert.equal(report.json.samples, 120);
  assert.equal(typeof report.json.iae, 'number');
});

test('API: pause/resume flow rejects illegal transitions', async () => {
  const srv = await startServer();
  after(() => srv.stop());
  const created = await req(srv.base, '/runs', {
    method: 'POST',
    body: scenario('delayed'),
  });
  const id = created.json.run.id;
  await req(srv.base, `/runs/${id}/advance`, { method: 'POST', body: { n: 5 } });
  const paused = await req(srv.base, `/runs/${id}/pause`, { method: 'POST' });
  assert.equal(paused.json.run.status, 'paused');
  const blocked = await req(srv.base, `/runs/${id}/advance`, {
    method: 'POST',
    body: { n: 1 },
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.error.code, 'RUN_NOT_RUNNING');
  const resumed = await req(srv.base, `/runs/${id}/resume`, { method: 'POST' });
  assert.equal(resumed.json.run.status, 'running');
});

test('API: unstable scenario reports failure with a reason', async () => {
  const srv = await startServer();
  after(() => srv.stop());
  const created = await req(srv.base, '/runs', {
    method: 'POST',
    body: scenario('unstable'),
  });
  const id = created.json.run.id;
  await req(srv.base, `/runs/${id}/advance`, { method: 'POST', body: { n: 1000 } });
  const rep = await req(srv.base, `/runs/${id}/report`);
  assert.equal(rep.json.status, 'failed');
  assert.match(rep.json.failureReason, /divergence|non-finite/);
});

test('API: compare endpoint evaluates multiple PIDs on one scenario', async () => {
  const srv = await startServer();
  after(() => srv.stop());
  const sc = scenario('loadDisturbance');
  const res = await req(srv.base, '/compare', {
    method: 'POST',
    body: {
      scenarioKey: 'api-cmp',
      plant: sc.plant,
      setpoint: sc.setpoint,
      y0: sc.y0,
      maxSamples: sc.maxSamples,
      settlingFraction: sc.settlingFraction,
      events: sc.events,
      candidates: [
        { name: 'soft', pid: sc.pid },
        { name: 'p', pid: { kp: 0.8, ki: 0, kd: 0, tf: 0, antiWindup: 'freeze', kaw: 1 } },
      ],
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.results.length, 2);
  // repeat with same key is idempotent
  const again = await req(srv.base, '/compare', {
    method: 'POST',
    body: {
      scenarioKey: 'api-cmp',
      plant: sc.plant,
      setpoint: sc.setpoint,
      y0: sc.y0,
      maxSamples: sc.maxSamples,
      settlingFraction: sc.settlingFraction,
      events: sc.events,
      candidates: [
        { name: 'soft', pid: sc.pid },
        { name: 'p', pid: { kp: 0.8, ki: 0, kd: 0, tf: 0, antiWindup: 'freeze', kaw: 1 } },
      ],
    },
  });
  assert.deepEqual(
    again.json.results.map((r: any) => r.runId),
    res.json.results.map((r: any) => r.runId),
  );
});
