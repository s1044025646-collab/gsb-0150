#!/usr/bin/env node
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { openDatabase } from '../db/database.js';
import { RunService } from '../core/service.js';
import { validatePid, validatePlant, validateRunInput } from '../core/validation.js';
import { SCENARIOS, scenario, COMPARISON_CANDIDATES, type ScenarioName } from '../fixtures/fixtures.js';
import type { StoredRun } from '../db/repository.js';

const ROOT = process.cwd();
const DB_PATH = process.env.PID_EVAL_DB ?? join(ROOT, 'data', 'cli.sqlite');

function parseArgs(argv: string[]): { cmd: string[]; flags: Map<string, string> } {
  const cmd: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(a.slice(2), next);
        i++;
      } else {
        flags.set(a.slice(2), 'true');
      }
    } else {
      cmd.push(a);
    }
  }
  return { cmd, flags };
}

function readJsonFlag(flags: Map<string, string>, key: string): any {
  const v = flags.get(key);
  if (v === undefined) return undefined;
  if (v.startsWith('@')) {
    try {
      return JSON.parse(readFileSync(v.slice(1), 'utf8'));
    } catch (err: any) {
      fatal(`cannot read JSON file ${v}: ${err.message}`);
    }
  }
  try {
    return JSON.parse(v);
  } catch {
    fatal(`--${key} must be valid JSON`);
  }
}

function fmt(x: number, digits = 4): string {
  if (!Number.isFinite(x)) return String(x);
  return x.toFixed(digits);
}

function runSummary(r: StoredRun): string {
  const s = r.state;
  return [
    `run=${r.id} status=${s.status} k=${s.k} sp=${fmt(s.sp)} y=${fmt(s.y)}`,
    `  u_cmd=${fmt(s.uCommand)} u_applied=${fmt(s.uApplied)} load=${fmt(s.load)}`,
    `  P=${fmt(s.pid.pTerm)} I=${fmt(s.pid.iTerm)} D=${fmt(s.pid.dTerm)}`,
    s.failureReason ? `  FAILURE: ${s.failureReason}` : '',
  ].filter(Boolean).join('\n');
}

function fatal(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const HELP = `discrete-pid-eval CLI (all data stays in this project)

plants:
  plant create --name N --json '{"gain":2,"tau":5,"ts":0.5,"delaySamples":0,"uMin":-5,"uMax":5}'
  plant show   --name N [--version V]
  plant list
controllers:
  controller create --name N --json '{...pid...}' [--note TEXT]
  controller show   --name N [--version V]
  controller list
runs:
  run create --scenario pureProportionalStep
  run create --json '{...run input incl. idempotencyKey...}'
  run show     --id ID
  run advance  --id ID [--n 20]      show BEFORE -> AFTER state
  run pause    --id ID
  run resume   --id ID
  run terms    --id ID               P/I/D terms of the latest sample
  run samples  --id ID [--limit 10] [--offset 0]
  run report   --id ID
  run export   --id ID --out seq.csv
compare:
  compare --scenario pureProportionalStep
fixtures:
  fixtures list
`;

function main(): void {
  const { cmd, flags } = parseArgs(process.argv.slice(2));
  const [group, action] = cmd;
  if (!group || group === 'help' || group === '--help') {
    console.log(HELP);
    return;
  }

  const db = openDatabase(DB_PATH);
  const svc = new RunService(db);

  try {
    if (group === 'fixtures' && (action === 'list' || !action)) {
      console.log(Object.keys(SCENARIOS).join('\n'));
      return;
    }

    if (group === 'plant') {
      if (action === 'create') {
        const name = flags.get('name') ?? fatal('--name required');
        const config = validatePlant(readJsonFlag(flags, 'json') ?? fatal('--json required'));
        const out = svc.createPlant(name, config);
        console.log(`created plant ${name} v${out.version}`);
      } else if (action === 'show') {
        const name = flags.get('name') ?? fatal('--name required');
        const v = flags.has('version') ? Number(flags.get('version')) : undefined;
        console.log(JSON.stringify(svc.repo.getPlant(name, v), null, 2));
      } else if (action === 'list') {
        for (const p of svc.repo.listPlants()) {
          console.log(`${p.name} v${p.version}`);
        }
      } else fatal(`unknown plant action ${action}`);
      return;
    }

    if (group === 'controller') {
      if (action === 'create') {
        const name = flags.get('name') ?? fatal('--name required');
        const config = validatePid(readJsonFlag(flags, 'json') ?? fatal('--json required'));
        const note = flags.get('note') ?? '';
        const out = svc.createController(name, config, note);
        console.log(`created controller ${name} v${out.version}`);
      } else if (action === 'show') {
        const name = flags.get('name') ?? fatal('--name required');
        const v = flags.has('version') ? Number(flags.get('version')) : undefined;
        console.log(JSON.stringify(svc.repo.getController(name, v), null, 2));
      } else if (action === 'list') {
        for (const c of svc.repo.listControllers()) {
          console.log(`${c.name} v${c.version} ${c.note}`);
        }
      } else fatal(`unknown controller action ${action}`);
      return;
    }

    if (group === 'compare') {
      const scName = (flags.get('scenario') ?? 'pureProportionalStep') as ScenarioName;
      if (!(scName in SCENARIOS)) fatal(`unknown scenario ${scName}`);
      const input = scenario(scName);
      const { idempotencyKey: _omit, ...base } = input;
      const results = svc.compare(base, scName, COMPARISON_CANDIDATES.map((c) => ({ ...c })));
      console.log('name            settled  overshoot  sse       IAE       t_settle(s)');
      for (const r of results) {
        const rep = r.report;
        console.log(
          [
            r.name.padEnd(16),
            String(rep.settled).padEnd(8),
            (rep.overshoot === null ? '-' : fmt(rep.overshoot, 4)).padEnd(10),
            (rep.steadyStateError === null ? '-' : fmt(rep.steadyStateError, 5)).padEnd(10),
            (rep.iae === null ? '-' : fmt(rep.iae, 4)).padEnd(10),
            rep.settlingTimeSeconds === null ? '-' : fmt(rep.settlingTimeSeconds, 3),
          ].join(''),
        );
      }
      return;
    }

    if (group === 'run') {
      handleRun(svc, action ?? fatal('run action required'), flags);
      return;
    }

    fatal(`unknown command '${group}'`);
  } catch (err) {
    if (err instanceof Error) fatal(err.message);
    throw err;
  } finally {
    db.close();
  }
}

function handleRun(svc: RunService, action: string, flags: Map<string, string>): void {
  const createFromScenario = () => {
    const scName = flags.get('scenario') as ScenarioName | undefined;
    if (scName) {
      if (!(scName in SCENARIOS)) fatal(`unknown scenario ${scName}`);
      return scenario(scName);
    }
    return validateRunInput(readJsonFlag(flags, 'json') ?? fatal('--scenario or --json required'));
  };

  if (action === 'create') {
    const input = createFromScenario();
    const { run, created } = svc.createRun(input);
    console.log(created ? 'created run' : 'idempotent replay -> existing run');
    console.log(runSummary(run));
    return;
  }

  const id = flags.get('id') ?? fatal('--id required');

  if (action === 'show') {
    console.log(runSummary(svc.repo.getRun(id)));
    return;
  }

  if (action === 'advance') {
    const before = svc.repo.getRun(id);
    console.log('BEFORE');
    console.log(runSummary(before));
    const n = Number(flags.get('n') ?? 1);
    const after = svc.advance(id, n);
    console.log('AFTER');
    console.log(runSummary(after));
    return;
  }

  if (action === 'pause') {
    const before = svc.repo.getRun(id);
    console.log('BEFORE', before.state.status, `k=${before.state.k}`);
    const after = svc.pause(id);
    console.log('AFTER ', after.state.status, `k=${after.state.k}`);
    return;
  }

  if (action === 'resume') {
    const before = svc.repo.getRun(id);
    console.log('BEFORE', before.state.status, `k=${before.state.k}`);
    const after = svc.resume(id);
    console.log('AFTER ', after.state.status, `k=${after.state.k}`);
    return;
  }

  if (action === 'terms') {
    const r = svc.repo.getRun(id);
    const page = svc.repo.getSamples(id, 1, Math.max(0, r.state.k - 1));
    const s = page.items[0];
    if (!s) fatal('no samples yet');
    console.log(
      `k=${s.k} P=${fmt(s.pTerm)} I=${fmt(s.iTerm)} D=${fmt(s.dTerm)} ` +
        `v_unsat=${fmt(s.vUnsat)} u_cmd=${fmt(s.uCommand)} saturated=${s.saturated}`,
    );
    return;
  }

  if (action === 'samples') {
    const limit = Number(flags.get('limit') ?? 10);
    const offset = Number(flags.get('offset') ?? 0);
    const page = svc.repo.getSamples(id, limit, offset);
    console.log(`k\tsp\ty\te\tP\tI\tD\tu_cmd\tu_app\tsat`);
    for (const s of page.items) {
      console.log(
        [s.k, fmt(s.sp, 3), fmt(s.y, 4), fmt(s.error, 4), fmt(s.pTerm, 4),
         fmt(s.iTerm, 4), fmt(s.dTerm, 4), fmt(s.uCommand, 4),
         fmt(s.uApplied, 4), s.saturated].join('\t'),
      );
    }
    console.log(`total=${page.total} limit=${page.limit} offset=${page.offset}`);
    return;
  }

  if (action === 'report') {
    console.log(JSON.stringify(svc.report(id), null, 2));
    return;
  }

  if (action === 'export') {
    const out = flags.get('out') ?? fatal('--out required');
    const rows = svc.repo.getAllSamples(id);
    const header = 'k,sp,y,error,pTerm,iTerm,dTerm,vUnsat,uCommand,uApplied,load,saturated,iae';
    const lines = rows.map((s) =>
      [s.k, s.sp, s.y, s.error, s.pTerm, s.iTerm, s.dTerm, s.vUnsat,
       s.uCommand, s.uApplied, s.load, s.saturated, s.iae].join(','),
    );
    writeFileSync(out, [header, ...lines].join('\n') + '\n');
    console.log(`exported ${rows.length} samples to ${out}`);
    return;
  }

  fatal(`unknown run action ${action}`);
}

main();
