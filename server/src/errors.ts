import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * An error that maps to a JSON response `{error: code, ...extra}`, with `message` when it differs from the code.
 * Messages are for humans and must not hold secrets.
 */
export class HttpError extends Error {
  override name = "HttpError";
  readonly status: ContentfulStatusCode;
  readonly code: string;
  readonly extra: Record<string, unknown>;
  readonly headers: Record<string, string>;

  constructor(
    status: ContentfulStatusCode,
    code: string,
    message?: string,
    extra: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ) {
    super(message ?? code);
    this.status = status;
    this.code = code;
    this.extra = extra;
    this.headers = headers;
  }
}

export function tooManyRequests(code: string, message: string, retryAfterSec: number): HttpError {
  return new HttpError(429, code, message, {}, { "Retry-After": String(retryAfterSec) });
}

export function unauthorized(realm: string, message: string): HttpError {
  return new HttpError(401, "unauthorized", message, {}, { "WWW-Authenticate": `Bearer realm="${realm}"` });
}

const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,59}$/;

/** The class name of a thrown value, if it is a plausible identifier; never its message. */
export function errorName(err: unknown): string {
  if (err instanceof Error) return ERROR_NAME.test(err.name) ? err.name : "Error";
  return err === null || typeof err !== "object" ? "NonError" : "Error";
}
