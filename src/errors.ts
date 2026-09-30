/** Typed application error carrying a stable machine-readable code. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, httpStatus = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export type ErrorCode =
  | "INVALID_PARAM"
  | "NOT_FOUND"
  | "RUN_STOPPED"
  | "RUN_FINISHED"
  | "RUN_NOT_PAUSED"
  | "ALREADY_PAUSED"
  | "NUMERIC_DIVERGED"
  | "INVALID_STATE_TRANSITION"
  | "CONFLICT"
  | "BAD_JSON"
  | "VERSION_MISMATCH"
  | "INVALID_IDEMPOTENCY_KEY"
  | "INTERNAL";

export const errorHttpStatus: Record<ErrorCode, number> = {
  INVALID_PARAM: 400,
  NOT_FOUND: 404,
  RUN_STOPPED: 409,
  RUN_FINISHED: 409,
  RUN_NOT_PAUSED: 409,
  ALREADY_PAUSED: 409,
  NUMERIC_DIVERGED: 422,
  INVALID_STATE_TRANSITION: 409,
  CONFLICT: 409,
  BAD_JSON: 400,
  VERSION_MISMATCH: 409,
  INVALID_IDEMPOTENCY_KEY: 409,
  INTERNAL: 500,
};
