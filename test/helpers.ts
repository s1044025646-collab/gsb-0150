import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/database.js';
import { RunService } from '../src/core/service.js';
import type { CreateRunInput } from '../src/core/service.js';
import type { SampleRow } from '../src/core/types.js';

export interface Harness {
  db: DatabaseSync;
  svc: RunService;
  dir: string;
  cleanup: () => void;
  createAndRun: (input: CreateRunInput) => string;
}

export function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'pid-eval-'));
  const db = openDatabase(join(dir, 't.sqlite'));
  let t = 1_700_000_000_000;
  const svc = new RunService(db, () => ++t);
  let closed = false;
  return {
    db,
    svc,
    dir,
    cleanup: () => {
      try {
        if (!closed) {
          db.close();
          closed = true;
        }
      } catch {
        // already closed by the test itself
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort on Windows
      }
    },
    createAndRun(input: CreateRunInput) {
      const { run } = svc.createRun(input);
      svc.runToEnd(run.id);
      return run.id;
    },
  };
}

export function samples(svc: RunService, runId: string): SampleRow[] {
  return svc.repo.getAllSamples(runId);
}

export function approx(a: number, b: number, tol = 1e-9): boolean {
  return Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
}
