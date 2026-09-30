import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { AppError, errorHttpStatus } from "./errors.ts";
import { Repository } from "./repo.ts";
import { Service } from "./service.ts";
import {
  asRecord,
  parseDisturbance,
  parsePagination,
  parsePidParams,
  parseScenario,
  parseSetpointChange,
  parseStepCount,
} from "./validation.ts";

interface RouteResult {
  status: number;
  body: unknown;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function errorBody(code: string, message: string, details?: Record<string, unknown>) {
  return { error: { code, message, ...(details ? { details } : {}) } };
}

export interface AppContext {
  repo: Repository;
  service: Service;
}

async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

function parseRaw(raw: string): unknown {
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new AppError("BAD_JSON", "Request body is not valid JSON", 400);
  }
}

function idParam(value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new AppError("INVALID_PARAM", "Resource id must be a positive integer", 400, { field: "id" });
  }
  return Number(value);
}

function paginated<T>(rows: T[], limit: number, offset: number, total: number) {
  return { data: rows, pagination: { limit, offset, total, hasMore: offset + rows.length < total } };
}

class Router {
  private readonly ctx: AppContext;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  async route(method: string, pathname: string, url: URL, body: unknown): Promise<RouteResult> {
    const segments = pathname.split("/").filter(Boolean);

    if (method === "GET" && segments[0] === "health") {
      return { status: 200, body: { status: "ok" } };
    }

    if (segments[0] === "scenarios") {
      if (method === "POST" && segments.length === 1) {
        const scenario = parseScenario(body);
        return { status: 201, body: this.ctx.service.createScenario(scenario) };
      }
      if (method === "GET" && segments.length === 1) {
        const { limit, offset } = parsePagination(url.searchParams);
        const { rows, total } = this.ctx.repo.listScenarios(limit, offset);
        return { status: 200, body: paginated(rows, limit, offset, total) };
      }
      if (segments.length === 2 && method === "GET") {
        return { status: 200, body: this.ctx.service.requireScenario(idParam(segments[1])) };
      }
      if (segments.length === 3 && segments[2] === "versions") {
        const id = idParam(segments[1]);
        if (method === "POST") {
          const o = asRecord(body);
          const label = typeof o.label === "string" && o.label.length > 0 ? o.label : "default";
          const active = o.active === true;
          const pid = parsePidParams(o.pid ?? o);
          const version = this.ctx.service.addPidVersion(id, label, pid, active);
          return { status: 201, body: version };
        }
        if (method === "GET") {
          this.ctx.service.requireScenario(id);
          return { status: 200, body: { versions: this.ctx.repo.listVersions(id) } };
        }
      }
      if (segments.length === 3 && segments[2] === "disturbances" && method === "POST") {
        const id = idParam(segments[1]);
        const d = parseDisturbance(body);
        const created = this.ctx.service.addDisturbance(id, d);
        return { status: 201, body: { id: created, ...d } };
      }
      if (segments.length === 3 && segments[2] === "setpoints" && method === "POST") {
        const id = idParam(segments[1]);
        const c = parseSetpointChange(body);
        const created = this.ctx.service.addSetpointChange(id, c);
        return { status: 201, body: { id: created, ...c } };
      }
    }

    if (segments[0] === "versions" && segments.length === 2 && method === "GET") {
      return { status: 200, body: this.ctx.service.requireVersion(idParam(segments[1])) };
    }
    if (segments[0] === "versions" && segments.length === 3) {
      const id = idParam(segments[1]);
      const action = segments[2];
      if (method === "POST" && action === "run") {
        const steps = parseStepCount(body);
        return { status: 200, body: this.ctx.service.run(id, steps) };
      }
      if (method === "POST" && action === "pause") {
        return { status: 200, body: this.ctx.service.pause(id) };
      }
      if (method === "POST" && action === "resume") {
        const steps = parseStepCount(body);
        return { status: 200, body: this.ctx.service.resume(id, steps) };
      }
      if (method === "GET" && action === "samples") {
        const { limit, offset } = parsePagination(url.searchParams);
        const { rows, total } = this.ctx.service.samples(id, limit, offset);
        return { status: 200, body: paginated(rows, limit, offset, total) };
      }
      if (method === "GET" && action === "export") {
        return { status: 200, body: { samples: this.ctx.service.exportSamples(id) } };
      }
      if (method === "GET" && action === "report") {
        const band = Number(url.searchParams.get("band") ?? "0.05");
        if (!Number.isFinite(band) || band <= 0) {
          throw new AppError("INVALID_PARAM", "band must be a positive finite number", 400, { field: "band" });
        }
        return { status: 200, body: this.ctx.service.report(id, band) };
      }
    }

    throw new AppError("NOT_FOUND", `No route for ${method} ${pathname}`, 404);
  }
}

/**
 * Start the API server. Binds only to the loopback address and uses an
 * ephemeral OS-assigned port (0) unless an explicit port is provided.
 */
export function startServer(ctx: AppContext, preferredPort = 0): Promise<{ server: Server; port: number }> {
  const router = new Router(ctx);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const keyHeader = req.headers["idempotency-key"];
      const key = Array.isArray(keyHeader) ? keyHeader[0] : keyHeader;
      const rawText = await readRawBody(req);
      const body = parseRaw(rawText);
      const bodyText = JSON.stringify(body);
      const requestHash = ctx.service.hashBody(bodyText);

      if (typeof key === "string" && key.length > 0) {
        if (key.length > 200) {
          throw new AppError("INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must be at most 200 characters", 409);
        }
        if (ctx.repo.idempotencyExistsWithDifferentHash(key, requestHash)) {
          throw new AppError(
            "INVALID_IDEMPOTENCY_KEY",
            "Idempotency-Key was already used with a different request body",
            409,
          );
        }
        const cached = ctx.repo.findIdempotency(key);
        if (cached) {
          res.writeHead(cached.statusCode, { "content-type": "application/json; charset=utf-8" });
          res.end(cached.body);
          return;
        }
      }

      const result = await router.route(req.method ?? "GET", url.pathname, url, body);
      const responseText = JSON.stringify(result.body);
      if (typeof key === "string" && key.length > 0 && req.method !== "GET") {
        ctx.repo.saveIdempotency(
          key,
          req.method ?? "GET",
          url.pathname,
          requestHash,
          result.status,
          responseText,
          new Date().toISOString(),
        );
      }
      send(res, result.status, result.body);
    } catch (err) {
      if (err instanceof AppError) {
        send(res, err.httpStatus || errorHttpStatus[err.code], errorBody(err.code, err.message, err.details));
      } else {
        const message = err instanceof Error ? err.message : "unknown error";
        send(res, 500, errorBody("INTERNAL", message));
      }
    }
  });

  return new Promise((resolve) => {
    server.listen(preferredPort, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, port: address.port });
    });
  });
}
