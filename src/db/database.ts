import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { applyMigrations } from './migrations.js';

export interface DbClock {
  now: () => number;
}

export function openDatabase(path: string, clock: DbClock = { now: () => Date.now() }): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  applyMigrations(db, clock.now);
  return db;
}
