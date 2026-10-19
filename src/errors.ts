/** A JSON:API error object as returned by the Ring Partner API. */
export interface ApiErrorObject {
  id?: string;
  status?: string;
  code?: string;
  title?: string;
  detail?: string;
  source?: { pointer?: string };
  meta?: Record<string, unknown>;
}

export interface RingApiErrorInit {
  method: string;
  path: string;
  status: number;
  errors?: ApiErrorObject[];
  body?: string;
  requestId?: string;
  retryAfterMs?: number;
}

/**
 * Thrown for any non-success response. `code` carries the documented error
 * code when Ring sends one (for example MEDIA_NOT_FOUND or RECORDING_NOT_READY).
 */
export class RingApiError extends Error {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly code?: string;
  readonly detail?: string;
  readonly errors: ApiErrorObject[];
  readonly requestId?: string;
  readonly retryAfterMs?: number;

  constructor(init: RingApiErrorInit) {
    const first = init.errors?.[0];
    const summary = first?.detail ?? first?.title ?? init.body?.slice(0, 200) ?? '';
    super(`${init.method} ${init.path} -> ${init.status}${first?.code ? ` ${first.code}` : ''}${summary ? `: ${summary}` : ''}`);
    this.name = 'RingApiError';
    this.method = init.method;
    this.path = init.path;
    this.status = init.status;
    this.errors = init.errors ?? [];
    this.code = first?.code;
    this.detail = first?.detail;
    this.requestId = init.requestId;
    this.retryAfterMs = init.retryAfterMs;
  }

  /** 429 and 5xx are worth retrying; 4xx are not. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }

  /** 401: the access token is missing, invalid or expired. */
  get unauthorized(): boolean {
    return this.status === 401;
  }
}

/** Parses a Retry-After header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return undefined;
}

/**
 * Exponential backoff starting at 1 s, as the rate-limit docs recommend,
 * with Retry-After taking precedence when the server sends it.
 */
export function backoffDelay(attempt: number, retryAfterMs?: number, baseMs = 1000, capMs = 30_000): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, capMs);
  return Math.min(baseMs * 2 ** attempt, capMs);
}
