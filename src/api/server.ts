import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Router } from './http.js';
import { registerRoutes } from './routes.js';
import { openDatabase } from '../db/database.js';
import { RunService } from '../core/service.js';

/**
 * All runtime artifacts stay inside this project:
 *   data/app.sqlite   database
 *   .local/server.json  pid + bound port (used only by the stop script)
 * The server binds 127.0.0.1 only; port 0 lets the OS pick a free port.
 */
const ROOT = process.cwd();
const DATA_DIR = process.env.PID_EVAL_HOME
  ? process.env.PID_EVAL_HOME
  : join(ROOT, 'data');
const LOCAL_DIR = join(DATA_DIR, '..', '.local');
const DB_PATH = join(DATA_DIR, 'app.sqlite');
const PID_FILE = process.env.PID_EVAL_PIDFILE ?? join(LOCAL_DIR, 'server.json');
const HOST = '127.0.0.1';

/** Injectable clock for tests: PID_EVAL_NOW=epoch_ms advances deterministically. */
function makeClock(): () => number {
  if (process.env.PID_EVAL_NOW !== undefined) {
    let t = Number.parseInt(process.env.PID_EVAL_NOW, 10);
    return () => (t += 1);
  }
  return () => Date.now();
}

export function buildApp(dbPath = DB_PATH) {
  const db = openDatabase(dbPath, { now: makeClock() });
  const svc = new RunService(db, makeClock());
  const router = new Router();
  registerRoutes(router, svc);
  return { db, svc, router };
}

function start(): void {
  mkdirSync(LOCAL_DIR, { recursive: true });
  if (existsSync(PID_FILE)) {
    try {
      const prev = JSON.parse(readFileSync(PID_FILE, 'utf8'));
      if (prev.pid && isAlive(prev.pid)) {
        console.error(
          `server already running (pid ${prev.pid}, http://${HOST}:${prev.port})`,
        );
        process.exit(1);
      }
    } catch {
      // stale/corrupt file -> overwrite
    }
  }

  const { router } = buildApp();
  const server = createServer((req, res) => {
    void router.handle(req, res);
  });

  const requestedPort = Number.parseInt(process.env.PID_EVAL_PORT ?? '0', 10);
  server.listen(requestedPort, HOST, () => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : requestedPort;
    writeFileSync(
      PID_FILE,
      JSON.stringify({ pid: process.pid, port, host: HOST, startedAt: Date.now() }, null, 2),
    );
    console.log(`PID evaluation API listening on http://${HOST}:${port}`);
    console.log(`database: ${DB_PATH}`);
  });

  const shutdown = () => {
    server.close(() => {
      try {
        rmSync(PID_FILE, { force: true });
      } catch {
        // best effort
      }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start();
}
