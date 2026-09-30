import type { PidConfig, PlantConfig, RunConfig } from './types.js';
import { validation } from './errors.js';

const isNum = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

/** Validate a JSON-ish object against the config shapes. Throws VALIDATION. */
export function validatePlant(input: any): PlantConfig {
  if (!input || typeof input !== 'object') validation('plant must be an object');
  const p: PlantConfig = {
    gain: num(input.gain, 'plant.gain'),
    tau: positive(input.tau, 'plant.tau'),
    ts: positive(input.ts, 'plant.ts'),
    delaySamples: nonNegInt(input.delaySamples, 'plant.delaySamples'),
    uMin: num(input.uMin, 'plant.uMin'),
    uMax: num(input.uMax, 'plant.uMax'),
  };
  if (!(p.uMax > p.uMin)) validation('plant.uMax must be strictly greater than plant.uMin');
  return p;
}

export function validatePid(input: any): PidConfig {
  if (!input || typeof input !== 'object') validation('pid must be an object');
  const aw = input.antiWindup ?? 'freeze';
  if (aw !== 'freeze' && aw !== 'backcalc') {
    validation("pid.antiWindup must be 'freeze' or 'backcalc'");
  }
  const p: PidConfig = {
    kp: num(input.kp ?? 0, 'pid.kp'),
    ki: num(input.ki ?? 0, 'pid.ki'),
    kd: num(input.kd ?? 0, 'pid.kd'),
    tf: nonNegative(input.tf ?? 0, 'pid.tf'),
    antiWindup: aw,
    kaw: positive(input.kaw ?? 1, 'pid.kaw'),
  };
  if (p.tf > 0 && p.tf < 0) validation('pid.tf invalid');
  return p;
}

export function validateRunInput(input: any): {
  plant: PlantConfig;
  pid: PidConfig;
  setpoint: number;
  y0: number;
  maxSamples: number;
  settlingFraction: number;
  events: RunConfig['events'];
  idempotencyKey: string;
} {
  if (!input || typeof input !== 'object') validation('body must be an object');
  const key = typeof input.idempotencyKey === 'string' && input.idempotencyKey.trim()
    ? input.idempotencyKey.trim()
    : validation('idempotencyKey is required');
  const setpoint = num(input.setpoint ?? 0, 'setpoint');
  const y0 = num(input.y0 ?? 0, 'y0');
  const maxSamples = posInt(input.maxSamples ?? 500, 'maxSamples');
  if (maxSamples > 1_000_000) validation('maxSamples too large');
  const settlingFraction = positive(input.settlingFraction ?? 0.02, 'settlingFraction');
  const events = validateEvents(input.events ?? []);
  return {
    plant: validatePlant(input.plant),
    pid: validatePid(input.pid),
    setpoint,
    y0,
    maxSamples,
    settlingFraction,
    events,
    idempotencyKey: key,
  };
}

function validateEvents(input: any): RunConfig['events'] {
  if (!Array.isArray(input)) validation('events must be an array');
  const keys = new Set<string>();
  return input.map((e, i) => {
    if (!e || typeof e !== 'object') validation(`events[${i}] must be an object`);
    const key = String(e.key ?? '');
    if (!key) validation(`events[${i}].key required`);
    if (keys.has(key)) validation(`duplicate event key: ${key}`);
    keys.add(key);
    if (e.kind !== 'setpoint' && e.kind !== 'disturbance') {
      validation(`events[${i}].kind must be setpoint or disturbance`);
    }
    return {
      key,
      atSample: nonNegInt(e.atSample, `events[${i}].atSample`),
      kind: e.kind as 'setpoint' | 'disturbance',
      value: num(e.value, `events[${i}].value`),
    };
  });
}

function num(v: unknown, name: string): number {
  if (!isNum(v)) validation(`${name} must be a finite number`);
  return v as number;
}
function positive(v: unknown, name: string): number {
  const x = num(v, name);
  if (!(x > 0)) validation(`${name} must be > 0`);
  return x;
}
function nonNegative(v: unknown, name: string): number {
  const x = num(v, name);
  if (x < 0) validation(`${name} must be >= 0`);
  return x;
}
function nonNegInt(v: unknown, name: string): number {
  const x = num(v, name);
  if (!Number.isInteger(x) || x < 0) validation(`${name} must be a non-negative integer`);
  return x;
}
function posInt(v: unknown, name: string): number {
  const x = num(v, name);
  if (!Number.isInteger(x) || x <= 0) validation(`${name} must be a positive integer`);
  return x;
}

/** Re-check that stored numeric params remain usable (defends against divergence). */
export function assertFiniteParams(cfg: { plant: PlantConfig; pid: PidConfig }): void {
  const all = [
    cfg.plant.gain, cfg.plant.tau, cfg.plant.ts, cfg.plant.uMin, cfg.plant.uMax,
    cfg.pid.kp, cfg.pid.ki, cfg.pid.kd, cfg.pid.tf, cfg.pid.kaw,
  ];
  if (!all.every(Number.isFinite)) validation('config contains non-finite parameters');
}
