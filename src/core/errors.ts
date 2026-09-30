/** Typed application errors with stable machine-readable codes. */

export type ErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RUN_FAILED'
  | 'RUN_NOT_RUNNING'
  | 'BAD_JSON'
  | 'INTERNAL';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

export function validation(message: string, details?: unknown): never {
  throw new AppError('VALIDATION', message, details);
}
