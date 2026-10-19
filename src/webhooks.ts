import { createHmac, timingSafeEqual } from 'node:crypto';
import type { KnownMotionSubType, WebhookPayload } from './types.ts';

/**
 * Ring signs every webhook with HMAC-SHA256 over the raw request body, hex
 * encoded, sent as `X-Signature: sha256=<hex>`. (Account-linking nonces use the
 * same key with URL-safe Base64 instead; do not mix the two encodings.)
 */
export function computeSignature(signingKey: string, rawBody: Uint8Array | string): string {
  return createHmac('sha256', signingKey).update(rawBody).digest('hex');
}

/** Value for the X-Signature header, e.g. for tests and simulators. */
export function signatureHeader(signingKey: string, rawBody: Uint8Array | string): string {
  return `sha256=${computeSignature(signingKey, rawBody)}`;
}

/**
 * Verifies X-Signature against the raw body bytes, in constant time.
 * Pass the body exactly as received: re-serialized JSON changes the bytes and
 * every check fails.
 */
export function verifySignature(signingKey: string, rawBody: Uint8Array | string, header: string | null | undefined): boolean {
  if (!signingKey || !header) return false;
  const received = header.trim().replace(/^sha256=/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(received)) return false;
  const expected = Buffer.from(computeSignature(signingKey, rawBody), 'hex');
  return timingSafeEqual(expected, Buffer.from(received, 'hex'));
}

export class WebhookError extends Error {
  /** HTTP status to answer Ring with. 4xx stops retries, so only use it for permanent problems. */
  readonly httpStatus: number;
  constructor(message: string, httpStatus: number) {
    super(message);
    this.name = 'WebhookError';
    this.httpStatus = httpStatus;
  }
}

/**
 * Verify first, parse second. Throws WebhookError(401) on a bad signature and
 * WebhookError(400) on a body that is not a v1.x Ring webhook.
 */
export function verifyAndParse(signingKey: string, rawBody: Uint8Array | string, header: string | null | undefined): WebhookPayload {
  if (!verifySignature(signingKey, rawBody, header)) throw new WebhookError('invalid X-Signature', 401);
  return parseWebhook(rawBody);
}

export function parseWebhook(rawBody: Uint8Array | string): WebhookPayload {
  const text = typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody).toString('utf8');
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new WebhookError('body is not JSON', 400);
  }
  const p = payload as Partial<WebhookPayload>;
  if (!p || typeof p !== 'object' || !p.meta || !p.data) throw new WebhookError('missing meta or data', 400);
  if (typeof p.meta.request_id !== 'string' || !p.meta.request_id) throw new WebhookError('missing meta.request_id', 400);
  if (typeof p.data.type !== 'string' || !p.data.type) throw new WebhookError('missing data.type', 400);
  if (!p.data.attributes || typeof p.data.attributes !== 'object') throw new WebhookError('missing data.attributes', 400);
  return p as WebhookPayload;
}

// ------------------------------------------------------------ normalizing --

export type EventFamily = 'camera' | 'doorbell' | 'sensor' | 'connectivity' | 'device' | 'integration' | 'subscription' | 'unknown';

const SENSOR_TYPES = new Set([
  'contact_sensor_faulted', 'contact_sensor_cleared', 'tamper_detected', 'tamper_cleared',
  'flood_detected', 'flood_cleared', 'freeze_detected', 'freeze_cleared',
  'temperature_exceeded', 'temperature_cleared', 'humidity_exceeded', 'humidity_cleared',
  'pm25_exceeded', 'pm25_cleared', 'co_exceeded', 'co_cleared',
]);

export function eventFamily(type: string): EventFamily {
  if (type === 'motion_detected') return 'camera';
  if (type === 'button_press') return 'doorbell';
  if (SENSOR_TYPES.has(type)) return 'sensor';
  if (type === 'device_online' || type === 'device_offline') return 'connectivity';
  if (type === 'device_added' || type === 'device_removed') return 'device';
  if (type === 'app_integration_added' || type === 'app_integration_removed') return 'integration';
  if (type === 'subscription_activated' || type === 'subscription_deactivated') return 'subscription';
  return 'unknown';
}

/** A flat, typed view of one webhook delivery. Unknown types and sub_types pass through. */
export interface RingEvent {
  /** data.id: stable per event. */
  id: string;
  /** meta.request_id: unique per delivery; use it for idempotency. */
  requestId: string;
  accountId?: string;
  type: string;
  family: EventFamily;
  /** Read from data.attributes.source, never parsed out of data.id. */
  deviceId?: string;
  /** Epoch ms when the state change happened (data.attributes.timestamp), else meta.time. */
  timestamp: number;
  subType?: KnownMotionSubType | (string & {});
  componentIds?: string[];
  reading?: { temperature?: number; humidity?: number; pm25?: number };
  thresholdType?: 'min' | 'max';
  raw: WebhookPayload;
}

export function normalizeWebhook(payload: WebhookPayload): RingEvent {
  const a = payload.data.attributes ?? {};
  const timestamp = typeof a.timestamp === 'number' ? a.timestamp : Date.parse(payload.meta.time);
  const reading: RingEvent['reading'] = {};
  if (typeof a.temperature === 'number') reading.temperature = a.temperature;
  if (typeof a.humidity === 'number') reading.humidity = a.humidity;
  // The webhook calls PM2.5 `pm25_level`; the status endpoint calls it `pm2_5`.
  if (typeof a.pm25_level === 'number') reading.pm25 = a.pm25_level;
  return {
    id: payload.data.id,
    requestId: payload.meta.request_id,
    accountId: payload.meta.account_id,
    type: payload.data.type,
    family: eventFamily(payload.data.type),
    deviceId: typeof a.source === 'string' ? a.source : undefined,
    timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
    subType: payload.data.type === 'motion_detected' ? (typeof a.sub_type === 'string' ? a.sub_type : 'motion') : undefined,
    componentIds: Array.isArray(a.component_ids) ? a.component_ids : undefined,
    reading: Object.keys(reading).length ? reading : undefined,
    thresholdType: a.threshold_type === 'min' || a.threshold_type === 'max' ? a.threshold_type : undefined,
    raw: payload,
  };
}

// ------------------------------------------------------------ idempotency --

export interface IdempotencyStore {
  has(key: string): boolean | Promise<boolean>;
  add(key: string): void | Promise<void>;
}

/** Bounded in-memory store. Mark a request_id only after processing succeeds, so a retry of a failed delivery is not dropped. */
export class MemoryIdempotencyStore implements IdempotencyStore {
  readonly #keys = new Set<string>();
  readonly #max: number;

  constructor(max = 10_000) {
    this.#max = max;
  }

  has(key: string): boolean {
    return this.#keys.has(key);
  }

  add(key: string): void {
    this.#keys.add(key);
    if (this.#keys.size > this.#max) {
      const oldest = this.#keys.values().next().value;
      if (oldest !== undefined) this.#keys.delete(oldest);
    }
  }
}

export interface WebhookHandlerResult {
  status: number;
  body: { status: string; error?: string; request_id?: string };
  event?: RingEvent;
}

/**
 * Framework-agnostic webhook handling with the documented semantics:
 * verify the signature on the raw bytes, parse, deduplicate on meta.request_id,
 * run your handler, and only then mark the delivery processed. Bad signatures and
 * malformed bodies get 4xx (no retry); handler failures get 500 (Ring retries).
 * Keep `onEvent` fast: Ring gives you 5 seconds.
 */
export async function handleWebhook(opts: {
  signingKey: string;
  rawBody: Uint8Array | string;
  signature: string | null | undefined;
  store: IdempotencyStore;
  onEvent: (event: RingEvent) => void | Promise<void>;
}): Promise<WebhookHandlerResult> {
  let payload: WebhookPayload;
  try {
    payload = verifyAndParse(opts.signingKey, opts.rawBody, opts.signature);
  } catch (err) {
    const status = err instanceof WebhookError ? err.httpStatus : 400;
    return { status, body: { status: 'rejected', error: (err as Error).message } };
  }
  const requestId = payload.meta.request_id;
  if (await opts.store.has(requestId)) {
    return { status: 200, body: { status: 'duplicate', request_id: requestId } };
  }
  const event = normalizeWebhook(payload);
  try {
    await opts.onEvent(event);
  } catch (err) {
    return { status: 500, body: { status: 'error', error: (err as Error).message, request_id: requestId }, event };
  }
  await opts.store.add(requestId);
  return { status: 200, body: { status: 'processed', request_id: requestId }, event };
}
