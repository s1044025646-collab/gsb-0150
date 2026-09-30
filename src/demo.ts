import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { migrate, openDatabase } from "./db.ts";
import { loadDisturbance, setpointStep, stablePid, stepScenario, unstablePid } from "./fixtures.ts";
import { Repository } from "./repo.ts";
import { Service } from "./service.ts";
import { startServer, type AppContext } from "./server.ts";

const DATA_DIR = resolve("data");
const DB_PATH = resolve(DATA_DIR, "demo.db");

async function apiCall(port: number, method: string, path: string, body?: unknown, idempotencyKey?: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

async function main(): Promise<void> {
  rmSync(DB_PATH, { force: true });
  let fixedTick = 0;
  const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, fixedTick++));

  const db = openDatabase(DB_PATH);
  migrate(db, clock);
  const repo = new Repository(db);
  const service = new Service(repo, clock);
  const ctx: AppContext = { repo, service };
  const { server, port } = await startServer(ctx, 0);
  console.log(`demo API: http://127.0.0.1:${port}`);

  try {
    const scenario = stepScenario({ maxSamples: 80 });
    const created = await apiCall(port, "POST", "/scenarios", scenario, "create-scenario-1");
    const createdAgain = await apiCall(port, "POST", "/scenarios", scenario, "create-scenario-1");
    console.log("idempotent create statuses:", created.status, createdAgain.status,
      (created.json as { id?: number }).id === (createdAgain.json as { id?: number }).id ? "IDENTICAL" : "DIFFER");

    const scenarioId = (created.json as { id: number }).id;
    await apiCall(port, "POST", `/scenarios/${scenarioId}/setpoints`, setpointStep(20, 1.4));
    await apiCall(port, "POST", `/scenarios/${scenarioId}/disturbances`, loadDisturbance(40, -0.4, 50));

    const v1 = await apiCall(port, "POST", `/scenarios/${scenarioId}/versions`, {
      label: "stable",
      ...stablePid(),
      active: true,
    });
    if (v1.status !== 201) throw new Error(`stable version create failed: ${JSON.stringify(v1.json)}`);
    const v2 = await apiCall(port, "POST", `/scenarios/${scenarioId}/versions`, {
      label: "aggressive",
      ...unstablePid(),
    });
    const stableId = (v1.json as { id: number }).id;
    const aggressiveId = (v2.json as { id: number }).id;

    // Continue in chunks to exercise checkpoint continuation.
    console.log("stable run:", await apiCall(port, "POST", `/versions/${stableId}/run`, { steps: 30 }));
    console.log("stable resume:", await apiCall(port, "POST", `/versions/${stableId}/resume`, { steps: 50 }));
    const aggressive = await apiCall(port, "POST", `/versions/${aggressiveId}/run`, { steps: 80 });
    console.log("aggressive result:", aggressive.json);

    const report = await apiCall(port, "GET", `/versions/${stableId}/report?band=0.05`);
    console.log("stable report:", JSON.stringify(report.json));
    const components = await apiCall(port, "GET", `/versions/${stableId}/samples?limit=3&offset=18`);
    console.log("paginated samples near setpoint change:", JSON.stringify(components.json));

    const bad = await apiCall(port, "POST", "/scenarios", { ...scenario, plant: { ...scenario.plant, tau: -1 } });
    console.log("invalid param response:", bad.status, JSON.stringify(bad.json));
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    db.close();
  }

  // Re-open to demonstrate restart persistence.
  const db2 = openDatabase(DB_PATH);
  migrate(db2, clock);
  const repo2 = new Repository(db2);
  const scenarios = repo2.listScenarios(10, 0);
  console.log(`after restart: ${scenarios.total} scenario(s) persisted at ${DB_PATH}`);
  db2.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
