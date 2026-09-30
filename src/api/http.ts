import type { IncomingMessage, ServerResponse } from 'node:http';
import { AppError, type ErrorCode } from '../core/errors.js';

export interface RequestContext {
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
}

type Handler = (ctx: RequestContext, raw: IncomingMessage) => Promise<unknown> | unknown;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: Handler): void {
    const keys: string[] = [];
    const pattern = new RegExp(
      `^${path.replace(/:([A-Za-z]+)/g, (_m, key: string) => {
        keys.push(key);
        return '([^/]+)';
      })}$`,
    );
    this.routes.push({ method, pattern, keys, handler });
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      for (const route of this.routes) {
        if (route.method !== req.method) continue;
        const match = route.pattern.exec(url.pathname);
        if (!match) continue;
        const params: Record<string, string> = {};
        route.keys.forEach((key, i) => {
          params[key] = decodeURIComponent(match![i + 1]!);
        });
        const body = await readJson(req);
        const result = await route.handler(
          { params, query: url.searchParams, body },
          req,
        );
        sendJson(res, result === undefined ? { ok: true } : result, 200);
        return;
      }
      throw new AppError('NOT_FOUND', `no route for ${req.method} ${url.pathname}`);
    } catch (err) {
      const { status, code, message, details } = normalizeError(err);
      sendJson(res, { error: { code, message, details } }, status);
    }
  }
}

async function readJson(req: IncomingMessage): Promise<any> {
  if (req.method === 'GET' || req.method === 'HEAD') return {};
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new AppError('BAD_JSON', 'request body is not valid JSON');
  }
}

export function sendJson(res: ServerResponse, payload: unknown, status = 200): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function normalizeError(err: unknown): {
  status: number;
  code: ErrorCode;
  message: string;
  details?: unknown;
} {
  if (err instanceof AppError) {
    const statusByCode: Record<ErrorCode, number> = {
      VALIDATION: 400,
      BAD_JSON: 400,
      NOT_FOUND: 404,
      CONFLICT: 409,
      RUN_FAILED: 409,
      RUN_NOT_RUNNING: 409,
      INTERNAL: 500,
    };
    return {
      status: statusByCode[err.code],
      code: err.code,
      message: err.message,
      details: err.details,
    };
  }
  const message = err instanceof Error ? err.message : 'unknown error';
  return { status: 500, code: 'INTERNAL', message };
}

export function pageParams(query: URLSearchParams): { limit: number; offset: number } {
  const limit = Number.parseInt(query.get('limit') ?? '50', 10);
  const offset = Number.parseInt(query.get('offset') ?? '0', 10);
  if (!Number.isFinite(limit) || limit < 1 || limit > 500) {
    throw new AppError('VALIDATION', 'limit must be an integer in [1,500]');
  }
  if (!Number.isFinite(offset) || offset < 0) {
    throw new AppError('VALIDATION', 'offset must be a non-negative integer');
  }
  return { limit, offset };
}
