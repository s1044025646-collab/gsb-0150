/**
 * Stop a server started by this project, using .local/server.json.
 * Only ever signals the pid recorded by our own start script.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const pidFile = process.env.PID_EVAL_PIDFILE ?? join(process.cwd(), '.local', 'server.json');
if (!existsSync(pidFile)) {
  console.log('no pid file; server does not appear to be running');
  process.exit(0);
}
try {
  const info = JSON.parse(readFileSync(pidFile, 'utf8')) as { pid: number; port: number };
  try {
    process.kill(info.pid, 'SIGTERM');
    console.log(`sent SIGTERM to pid ${info.pid} (was on port ${info.port})`);
  } catch (err: any) {
    if (err.code === 'ESRCH') console.log(`pid ${info.pid} already stopped`);
    else throw err;
  }
} finally {
  rmSync(pidFile, { force: true });
}
