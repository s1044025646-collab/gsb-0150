#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { migrate, openDatabase } from "./db.ts";
import { stablePid, stepScenario, unstablePid } from "./fixtures.ts";
import { Repository } from "./repo.ts";
import { Service } from "./service.ts";
import { startServer } from "./server.ts";
import { parsePidParams, parseScenario } from "./validation.ts";

const DB_PATH = process.env.PID_DB_PATH ?? resolve("data/pid.db");

function makeService(dbPath = DB_PATH): { repo: Repository; service: Service } {
  const db = openDatabase(dbPath);
  migrate(db, () => new Date().toISOString());
  const repo = new Repository(db);
  const service = new Service(repo);
  return { repo, service };
}

function fmt(value: unknown): string {
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(4);
  if (value === null || value === undefined) return "-";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function printScenario(label: string, row: { id: number; name: string; gain: number; tau: number; ts: number; delay_steps: number; setpoint: number; y0: number; max_samples: number; u_min: number; u_max: number }): void {
  console.log(`[${label}] scenario#${row.id} ${row.name}`);
  console.log(
    `  K=${fmt(row.gain)} T=${fmt(row.tau)} Ts=${fmt(row.ts)} delay=${row.delay_steps} ` +
      `u=[${fmt(row.u_min)}, ${fmt(row.u_max)}] sp=${fmt(row.setpoint)} y0=${fmt(row.y0)} N=${row.max_samples}`,
  );
}

function printVersionState(label: string, v: {
  id: number;
  label: string;
  kp: number;
  ki: number;
  kd: number;
  status: string;
  stop_reason: string | null;
  last_error: string | null;
  loop_state: string | null;
}): void {
  let step = 0;
  if (v.loop_state) {
    step = (JSON.parse(v.loop_state) as { step: number }).step;
  }
  console.log(`[${label}] version#${v.id} (${v.label}) kp=${fmt(v.kp)} ki=${fmt(v.ki)} kd=${fmt(v.kd)}`);
  console.log(`  status=${v.status} nextStep=${step} stopReason=${v.stop_reason ?? "-"}${v.last_error ? ` error=${v.last_error}` : ""}`);
}

function printComponents(rows: { step: number; setpoint: number; measurement: number; error: number; p: number; i: number; d: number; control: number }[]): void {
  console.log("step | sp     y      err    P      I      D      u");
  for (const r of rows) {
    console.log(
      [r.step, r.setpoint, r.measurement, r.error, r.p, r.i, r.d, r.control]
        .map((v, idx) => (idx === 0 ? String(v).padStart(4) : fmt(v).padStart(6)))
        .join(" "),
    );
  }
}

function parseJsonArg(arg: string | undefined, fallback: unknown): unknown {
  if (arg === undefined) return fallback;
  try {
    return JSON.parse(arg) as unknown;
  } catch (err) {
    throw new Error(`Invalid JSON: ${(err as Error).message}`);
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { repo, service } = makeService();

  switch (command) {
    case "serve": {
      const portArg = rest.find((a) => a.startsWith("--port="));
      const port = portArg ? Number(portArg.split("=")[1]) : 0;
      const { server, port: bound } = await startServer({ repo, service }, Number.isFinite(port) ? port : 0);
      console.log(`PID eval API listening on http://127.0.0.1:${bound} (db=${DB_PATH})`);
      // Keep the CLI process alive until an explicit shutdown signal closes
      // only this project's server process.
      await new Promise<void>((resolveClose) => {
        const shutdown = () => {
          console.log("\nShutting down project API process...");
          server.close(() => resolveClose());
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
      });
      return 0;
    }

    case "create": {
  const json = parseJsonArg(rest[0], {});
      const spec = parseScenario(json);
      printScenario("before", {
        id: 0, name: spec.name, gain: spec.plant.gain, tau: spec.plant.tau, ts: spec.plant.ts,
        delay_steps: spec.plant.delaySteps, setpoint: spec.setpoint, y0: spec.y0,
        max_samples: spec.maxSamples, u_min: spec.plant.uMin, u_max: spec.plant.uMax,
      });
      const row = service.createScenario(spec);
      printScenario("after", row);
      console.log(`scenarioId=${row.id}`);
      return 0;
    }

    case "show": {
      const id = Number(rest[0]);
      printScenario("state", service.requireScenario(id));
      for (const v of repo.listVersions(id)) printVersionState("state", v);
      return 0;
    }

    case "add-pid": {
      const scenarioId = Number(rest[0]);
      const before = service.requireScenario(scenarioId);
      printScenario("before", before);
      const pid = parsePidParams(parseJsonArg(rest[1], stablePid()));
      const label = rest[2] ?? `pid-${repo.listVersions(scenarioId).length + 1}`;
      const v = service.addPidVersion(scenarioId, label, pid, rest.includes("--active"));
      printVersionState("after", v);
      console.log(`versionId=${v.id}`);
      return 0;
    }

    case "step": {
      const scenarioId = Number(rest[0]);
      const at = Number(rest[1]);
      const setpoint = Number(rest[2]);
      console.log(`[before] scenario#${scenarioId} scheduled setpoint change at k=${at} -> ${setpoint}`);
      const id = service.addSetpointChange(scenarioId, { step: at, setpoint });
      console.log(`[after] setpointChange id=${id}`);
      return 0;
    }

    case "disturb": {
      const scenarioId = Number(rest[0]);
      const start = Number(rest[1]);
      const amplitude = Number(rest[2]);
      const end = rest[3] !== undefined ? Number(rest[3]) : null;
      console.log(`[before] scenario#${scenarioId} disturbance d=${amplitude} for k=${start}..${end ?? "end"}`);
      const id = service.addDisturbance(scenarioId, { startStep: start, endStep: end, amplitude });
      console.log(`[after] disturbance id=${id}`);
      return 0;
    }

    case "run": {
      const versionId = Number(rest[0]);
      const steps = rest[1] ? Number(rest[1]) : 10;
      printVersionState("before", service.requireVersion(versionId));
      const result = service.run(versionId, steps);
      printVersionState("after", service.requireVersion(versionId));
      console.log(`produced=${result.produced} result=${result.status}${result.reason ? ` reason=${result.reason}` : ""}${result.error ? ` error=${result.error}` : ""}`);
      return 0;
    }

    case "pause": {
      const versionId = Number(rest[0]);
      printVersionState("before", service.requireVersion(versionId));
      const v = service.pause(versionId);
      printVersionState("after", v);
      return 0;
    }

    case "resume": {
      const versionId = Number(rest[0]);
      const steps = rest[1] ? Number(rest[1]) : 10;
      printVersionState("before", service.requireVersion(versionId));
      const result = service.resume(versionId, steps);
      printVersionState("after", service.requireVersion(versionId));
      console.log(`produced=${result.produced} result=${result.status}${result.reason ? ` reason=${result.reason}` : ""}`);
      return 0;
    }

    case "components": {
      const versionId = Number(rest[0]);
      const limit = rest[1] ? Number(rest[1]) : 30;
      const { rows } = service.samples(versionId, limit, 0);
      printComponents(rows);
      return 0;
    }

    case "export": {
      const versionId = Number(rest[0]);
      const outFile = rest[1] ? resolve(rest[1]) : resolve(`data/version-${versionId}-samples.json`);
      const samples = service.exportSamples(versionId);
      writeFileSync(outFile, JSON.stringify({ versionId, samples }, null, 2), "utf-8");
      console.log(`exported ${samples.length} samples to ${outFile}`);
      return 0;
    }

    case "report": {
      const versionId = Number(rest[0]);
      const band = rest[1] ? Number(rest[1]) : 0.05;
      const report = service.report(versionId, band);
      console.log(JSON.stringify(report, null, 2));
      return 0;
    }

    case "compare": {
      const scenarioId = Number(rest[0]);
      const band = rest[1] ? Number(rest[1]) : 0.05;
      const scenario = service.requireScenario(scenarioId);
      const versions = repo.listVersions(scenarioId);
      console.log(`comparing ${versions.length} PID versions for scenario#${scenarioId} (band=${band})`);
      for (const v of versions) {
        if (v.status === "running" || v.status === "paused") {
          try {
            service.run(v.id, scenario.max_samples);
          } catch (err) {
            console.log(`version#${v.id} stopped: ${(err as Error).message}`);
          }
        }
      }
      console.log("version | label | settled | settling(s) | overshoot | sse | IAE(sum) | status");
      for (const v of repo.listVersions(scenarioId)) {
        try {
          const rpt = service.report(v.id, band);
          console.log(
            [v.id, v.label, rpt.settled, rpt.settlingTime ?? "-", rpt.overshoot ?? 0, rpt.steadyStateError ?? "-", rpt.iae, v.status]
              .map((x) => (typeof x === "number" ? fmt(x) : String(x))).join(" | "),
          );
        } catch (err) {
          console.log(`version#${v.id} report unavailable: ${(err as Error).message}`);
        }
      }
      return 0;
    }

    case "demo": {
      const spec = stepScenario();
      const scenario = service.createScenario(spec);
      printScenario("created", scenario);
      const stable = service.addPidVersion(scenario.id, "stable", stablePid(), true);
      const wild = service.addPidVersion(scenario.id, "aggressive", unstablePid());
      service.run(stable.id, scenario.max_samples);
      printVersionState("stable", service.requireVersion(stable.id));
      try {
        service.run(wild.id, scenario.max_samples);
      } catch (err) {
        console.log(`aggressive run failed as expected: ${(err as Error).message}`);
      }
      printVersionState("aggressive", service.requireVersion(wild.id));
      console.log(JSON.stringify(service.report(stable.id, 0.05), null, 2));
      return 0;
    }

    default:
      console.log(`Unknown command: ${command ?? "(none)"}`);
      console.log(
        [
          "usage: pidctl <command> [args]",
          "  serve [--port=N]                start loopback API (default ephemeral port)",
          "  create '<scenario-json>'        create a plant scenario",
          "  show <scenarioId>               show scenario and versions",
          "  add-pid <sid> '<pid-json>' [label] [--active]",
          "  step <sid> <k> <setpoint>       schedule a setpoint change",
          "  disturb <sid> <startK> <amp> [endK]",
          "  run <versionId> [steps]",
          "  pause <versionId>",
          "  resume <versionId> [steps]",
          "  components <versionId> [limit]",
          "  export <versionId> [file]",
          "  report <versionId> [band]",
          "  compare <scenarioId> [band]",
          "  demo                            run an in-process end-to-end demo",
        ].join("\n"),
      );
      return command ? 1 : 0;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    if (err && typeof err === "object" && "code" in err) {
      const e = err as { code: string; message: string; details?: Record<string, unknown> };
      console.error(`error[${e.code}]: ${e.message}${e.details ? ` ${JSON.stringify(e.details)}` : ""}`);
    } else {
      console.error(`error: ${(err as Error).message}`);
    }
    process.exit(1);
  },
);
