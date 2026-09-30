import { AppError } from "./errors.ts";
import type { AntiWindupMode, PidParams, PlantConfig } from "./types.ts";

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function requireFiniteNumber(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  if (!isFiniteNumber(v)) {
    throw new AppError("INVALID_PARAM", `Field '${key}' must be a finite number`, 400, { field: key });
  }
  return v;
}

function requireOptionalFiniteNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (!isFiniteNumber(v)) {
    throw new AppError("INVALID_PARAM", `Field '${key}' must be a finite number`, 400, { field: key });
  }
  return v;
}

function requireInt(obj: Record<string, unknown>, key: string, min?: number): number {
  const v = requireFiniteNumber(obj, key);
  if (!Number.isInteger(v) || (min !== undefined && v < min)) {
    throw new AppError("INVALID_PARAM", `Field '${key}' must be an integer${min !== undefined ? ` >= ${min}` : ""}`, 400, {
      field: key,
    });
  }
  return v;
}

function requireString(obj: Record<string, unknown>, key: string, maxLen = 200): string {
  const v = obj[key];
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new AppError("INVALID_PARAM", `Field '${key}' must be a non-empty string`, 400, { field: key });
  }
  if (v.length > maxLen) {
    throw new AppError("INVALID_PARAM", `Field '${key}' must be at most ${maxLen} characters`, 400, { field: key });
  }
  return v;
}

export function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new AppError("INVALID_PARAM", "Request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

/** Validate a plant config coming from untrusted input. */
export function parsePlantConfig(input: unknown): PlantConfig {
  const o = asRecord(input);
  const gain = requireFiniteNumber(o, "gain");
  if (gain === 0) {
    throw new AppError("INVALID_PARAM", "Plant gain must be non-zero", 400, { field: "gain" });
  }
  const tau = requireFiniteNumber(o, "tau");
  const ts = requireFiniteNumber(o, "ts");
  if (tau <= 0) throw new AppError("INVALID_PARAM", "Plant time constant tau must be > 0", 400, { field: "tau" });
  if (ts <= 0) throw new AppError("INVALID_PARAM", "Sampling period ts must be > 0", 400, { field: "ts" });
  const delaySteps = requireInt(o, "delaySteps", 0);
  const uMin = requireFiniteNumber(o, "uMin");
  const uMax = requireFiniteNumber(o, "uMax");
  if (!(uMax > uMin)) {
    throw new AppError("INVALID_PARAM", "Actuator bound uMax must be strictly greater than uMin", 400, {
      field: "uMax",
    });
  }
  return { gain, tau, ts, delaySteps, uMin, uMax };
}

export function parsePidParams(input: unknown): PidParams {
  const o = asRecord(input);
  const kp = requireFiniteNumber(o, "kp");
  const ki = requireFiniteNumber(o, "ki");
  const kd = requireFiniteNumber(o, "kd");
  const tdFilter = requireFiniteNumber(o, "tdFilter");
  if (tdFilter < 0) {
    throw new AppError("INVALID_PARAM", "Derivative filter time constant tdFilter must be >= 0", 400, {
      field: "tdFilter",
    });
  }
  if (kd !== 0 && tdFilter === 0) {
    throw new AppError(
      "INVALID_PARAM",
      "A positive tdFilter is required when kd != 0 (explicit derivative filtering is mandatory)",
      400,
      { field: "tdFilter" },
    );
  }
  const antiWindup = o.antiWindup;
  if (antiWindup !== "freeze" && antiWindup !== "backcalc") {
    throw new AppError("INVALID_PARAM", "antiWindup must be 'freeze' or 'backcalc'", 400, { field: "antiWindup" });
  }
  const tt = requireFiniteNumber(o, "tt");
  if (tt <= 0) {
    throw new AppError("INVALID_PARAM", "Back-calculation time constant tt must be > 0", 400, { field: "tt" });
  }
  return { kp, ki, kd, tdFilter, antiWindup: antiWindup as AntiWindupMode, tt };
}

export interface ScenarioInput {
  name: string;
  plant: PlantConfig;
  setpoint: number;
  y0: number;
  maxSamples: number;
}

export function parseScenario(body: unknown): ScenarioInput {
  const o = asRecord(body);
  const name = requireString(o, "name");
  const plant = parsePlantConfig(o.plant);
  const setpoint = requireFiniteNumber(o, "setpoint");
  const y0 = o.y0 === undefined ? 0 : requireFiniteNumber(o, "y0");
  const maxSamples = requireInt(o, "maxSamples", 1);
  if (maxSamples > 1_000_000) {
    throw new AppError("INVALID_PARAM", "maxSamples must be <= 1000000", 400, { field: "maxSamples" });
  }
  return { name, plant, setpoint, y0, maxSamples };
}

export function parseSetpointChange(body: unknown): { step: number; setpoint: number } {
  const o = asRecord(body);
  return { step: requireInt(o, "step", 0), setpoint: requireFiniteNumber(o, "setpoint") };
}

export function parseDisturbance(body: unknown): {
  startStep: number;
  endStep: number | null;
  amplitude: number;
} {
  const o = asRecord(body);
  const startStep = requireInt(o, "startStep", 0);
  const endStepRaw = requireOptionalFiniteNumber(o, "endStep");
  let endStep: number | null = null;
  if (endStepRaw !== undefined) {
    if (!Number.isInteger(endStepRaw)) {
      throw new AppError("INVALID_PARAM", "endStep must be an integer", 400, { field: "endStep" });
    }
    if (endStepRaw < startStep) {
      throw new AppError("INVALID_PARAM", "endStep must be >= startStep", 400, { field: "endStep" });
    }
    endStep = endStepRaw;
  }
  const amplitude = requireFiniteNumber(o, "amplitude");
  return { startStep, endStep, amplitude };
}

export function parseStepCount(body: unknown): number {
  const o = asRecord(body);
  return requireInt(o, "steps", 1);
}

/** Parse limit/offset pagination query params. */
export function parsePagination(searchParams: URLSearchParams): { limit: number; offset: number } {
  const limitRaw = searchParams.get("limit");
  const offsetRaw = searchParams.get("offset");
  let limit = 100;
  let offset = 0;
  if (limitRaw !== null) {
    if (!/^\d+$/.test(limitRaw)) {
      throw new AppError("INVALID_PARAM", "limit must be a non-negative integer", 400, { field: "limit" });
    }
    limit = Number(limitRaw);
    if (limit > 10_000) {
      throw new AppError("INVALID_PARAM", "limit must be <= 10000", 400, { field: "limit" });
    }
  }
  if (offsetRaw !== null) {
    if (!/^\d+$/.test(offsetRaw)) {
      throw new AppError("INVALID_PARAM", "offset must be a non-negative integer", 400, { field: "offset" });
    }
    offset = Number(offsetRaw);
  }
  return { limit, offset };
}
