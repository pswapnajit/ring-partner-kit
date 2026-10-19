import { StaticTokenProvider, type TokenProvider } from './auth.ts';
import { RingApiError, backoffDelay, parseRetryAfter, type ApiErrorObject } from './errors.ts';
import { indexIncluded, nextPageKey, resolveOne } from './jsonapi.ts';
import type {
  CapabilitiesAttributes,
  ChimePlaybackResult,
  ConfigurationsAttributes,
  Device,
  DeviceResource,
  DeviceStatusAttributes,
  Document,
  HistoryEvent,
  IncludeKey,
  LocationAttributes,
  MediaDownload,
  Resource,
  SnapshotRequest,
  UserAttributes,
} from './types.ts';

export const RING_API_BASE_URL = 'https://api.amazonvision.com';

/** One line per HTTP exchange, for logs and for showing judges what the app actually calls. */
export interface RequestLog {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  attempt: number;
  requestId?: string;
  error?: string;
}

export interface RingClientOptions {
  /** A raw access token (Playground) or a TokenProvider (refresh-token flow). */
  token: string | TokenProvider;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Retries for 429 / 5xx on safe requests. Defaults to 3. */
  maxRetries?: number;
  onRequest?: (log: RequestLog) => void;
  sleep?: (ms: number) => Promise<void>;
  userAgent?: string;
}

interface RequestOptions {
  method?: string;
  query?: Record<string, string | undefined>;
  json?: unknown;
  body?: string;
  contentType?: string;
  accept?: string;
  /** false for requests with side effects that must never repeat (chime playback). */
  retry?: boolean;
  redirect?: 'follow' | 'manual' | 'error';
}

export interface HistoryOptions {
  /** Composite filters such as ['ding', 'motion.human']; combined with OR by the API. */
  eventTypes?: string[];
  pageKey?: string;
  /** Safety valve: the API returns links.next even on an empty page. Defaults to 20. */
  maxPages?: number;
}

/**
 * Client for the Ring Partner API. Every call is server-to-server: Ring blocks
 * browser-initiated requests with CORS, so never ship a token to a web page.
 */
export class RingClient {
  readonly baseUrl: string;
  readonly #tokens: TokenProvider;
  readonly #fetch: typeof fetch;
  readonly #maxRetries: number;
  readonly #onRequest?: (log: RequestLog) => void;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #userAgent: string;

  constructor(opts: RingClientOptions) {
    this.baseUrl = (opts.baseUrl ?? RING_API_BASE_URL).replace(/\/+$/, '');
    this.#tokens = typeof opts.token === 'string' ? new StaticTokenProvider(opts.token) : opts.token;
    this.#fetch = opts.fetch ?? fetch;
    this.#maxRetries = opts.maxRetries ?? 3;
    this.#onRequest = opts.onRequest;
    this.#sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#userAgent = opts.userAgent ?? 'ring-partner-kit/0.1';
  }

  // ------------------------------------------------------------- devices --

  /**
   * GET /v1/devices, optionally sideloading related resources in one round trip.
   * Returned devices have their included resources resolved onto them.
   */
  async devices(opts: { include?: IncludeKey[] } = {}): Promise<Device[]> {
    const doc = await this.#json<Document<DeviceResource[]>>('/v1/devices', {
      query: { include: opts.include?.length ? opts.include.join(',') : undefined },
    });
    const index = indexIncluded(doc.included);
    return doc.data.map((raw) => toDevice(raw, index));
  }

  async device(deviceId: string, opts: { include?: IncludeKey[] } = {}): Promise<Device> {
    const doc = await this.#json<Document<DeviceResource>>(`/v1/devices/${enc(deviceId)}`, {
      query: { include: opts.include?.length ? opts.include.join(',') : undefined },
    });
    return toDevice(doc.data, indexIncluded(doc.included));
  }

  async status(deviceId: string): Promise<DeviceStatusAttributes> {
    const doc = await this.#json<Document<Resource<DeviceStatusAttributes>>>(`/v1/devices/${enc(deviceId)}/status`);
    return doc.data.attributes;
  }

  async capabilities(deviceId: string, opts: { componentId?: string } = {}): Promise<CapabilitiesAttributes> {
    const doc = await this.#json<Document<Resource<CapabilitiesAttributes>>>(`/v1/devices/${enc(deviceId)}/capabilities`, {
      query: { component_id: opts.componentId },
    });
    return doc.data.attributes;
  }

  async configurations(deviceId: string, opts: { componentId?: string } = {}): Promise<ConfigurationsAttributes> {
    const doc = await this.#json<Document<Resource<ConfigurationsAttributes>>>(
      `/v1/devices/${enc(deviceId)}/configurations`,
      { query: { component_id: opts.componentId } },
    );
    return doc.data.attributes;
  }

  async location(deviceId: string): Promise<LocationAttributes> {
    const doc = await this.#json<Document<Resource<LocationAttributes>>>(`/v1/devices/${enc(deviceId)}/location`);
    return doc.data.attributes;
  }

  // ------------------------------------------------------- event history --

  /** One page of GET /v1/history/devices/{id}/events, newest first. */
  async historyPage(deviceId: string, opts: HistoryOptions = {}): Promise<{ events: HistoryEvent[]; nextPageKey?: string }> {
    const doc = await this.#json<Document<HistoryEvent[]>>(`/v1/history/devices/${enc(deviceId)}/events`, {
      query: {
        event_types: opts.eventTypes?.length ? opts.eventTypes.join(',') : undefined,
        'page[key]': opts.pageKey,
      },
    });
    return { events: doc.data ?? [], nextPageKey: nextPageKey(doc) };
  }

  /**
   * Iterates the whole history for a device, following links.next. Stops on an
   * empty page or a repeated cursor, because the API keeps returning links.next
   * even when there is nothing more to read.
   */
  async *history(deviceId: string, opts: HistoryOptions = {}): AsyncGenerator<HistoryEvent> {
    const seen = new Set<string>();
    let pageKey = opts.pageKey;
    for (let page = 0; page < (opts.maxPages ?? 20); page++) {
      const { events, nextPageKey: next } = await this.historyPage(deviceId, { ...opts, pageKey });
      for (const event of events) yield event;
      if (!events.length || !next || seen.has(next)) return;
      seen.add(next);
      pageKey = next;
    }
  }

  // --------------------------------------------------------------- media --

  /**
   * POST /v1/devices/{id}/media/image/download. Ring answers 303 with a
   * pre-signed URL; we follow it ourselves so the Bearer token is never sent
   * to the download host, and so the X-Media-* headers are kept.
   */
  async snapshot(deviceId: string, request: SnapshotRequest): Promise<MediaDownload> {
    return this.#download(`/v1/devices/${enc(deviceId)}/media/image/download`, request);
  }

  /** POST /v1/devices/{id}/media/video/download (MP4). */
  async clip(deviceId: string, request: Record<string, unknown>): Promise<MediaDownload> {
    return this.#download(`/v1/devices/${enc(deviceId)}/media/video/download`, request);
  }

  /**
   * POST /v1/devices/{id}/media/audio/playback. Produces sound in someone's home,
   * so it is never retried. Use `playChimeSlot` from chime.ts for the documented
   * pre-checks (online, snooze, disabled slot).
   */
  async playChimeAudio(deviceId: string, audioRef: string): Promise<ChimePlaybackResult> {
    const doc = await this.#json<Document<Resource<{ status: string }>>>(`/v1/devices/${enc(deviceId)}/media/audio/playback`, {
      method: 'POST',
      json: { data: { type: 'audio', attributes: { audio_ref: audioRef } } },
      retry: false,
    });
    return { audioRef: doc.data.id, status: doc.data.attributes.status };
  }

  /** Starts a WHEP live view. Send a recvonly SDP offer; returns Ring's answer and the session URL. */
  async startLiveView(deviceId: string, sdpOffer: string, opts: { componentId?: string } = {}): Promise<{ answer: string; sessionUrl?: string }> {
    const res = await this.#request(`/v1/devices/${enc(deviceId)}/media/streaming/whep/sessions`, {
      method: 'POST',
      body: sdpOffer,
      contentType: 'application/sdp',
      accept: 'application/sdp',
      query: { component_id: opts.componentId },
      retry: false,
    });
    const location = res.headers.get('location') ?? undefined;
    return { answer: await res.text(), sessionUrl: location ? new URL(location, this.baseUrl).toString() : undefined };
  }

  /** Closes a WHEP session early to save the device's battery. */
  async stopLiveView(sessionUrl: string): Promise<void> {
    const url = new URL(sessionUrl, this.baseUrl);
    if (url.origin !== new URL(this.baseUrl).origin) throw new Error('stopLiveView: session URL is not on the Ring API host');
    await this.#request(url.pathname, { method: 'DELETE', retry: false });
  }

  // ------------------------------------------------------------- account --

  async me(): Promise<UserAttributes & { id: string }> {
    const doc = await this.#json<Document<Resource<UserAttributes>>>('/v1/users/me');
    return { id: doc.data.id, ...doc.data.attributes };
  }

  async subscriptions(): Promise<Document<Resource[]>> {
    return this.#json<Document<Resource[]>>('/v1/accounts/me/subscriptions');
  }

  // ------------------------------------------------------------ plumbing --

  async #download(path: string, body: unknown): Promise<MediaDownload> {
    const first = await this.#request(path, { method: 'POST', json: body, redirect: 'manual', accept: '*/*' });
    let res = first;
    if (first.status >= 300 && first.status < 400) {
      const location = first.headers.get('location');
      if (!location) throw new RingApiError({ method: 'POST', path, status: first.status, body: 'redirect without Location' });
      await first.body?.cancel();
      const started = Date.now();
      // The pre-signed URL carries its own credentials: no Authorization header.
      res = await this.#fetch(new URL(location, this.baseUrl), { method: 'GET' });
      this.#onRequest?.({
        method: 'GET',
        path: '(pre-signed download URL)',
        status: res.status,
        durationMs: Date.now() - started,
        attempt: 0,
        requestId: res.headers.get('x-request-id') ?? undefined,
      });
      if (!res.ok) throw await toError('GET', '(download)', res);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const ts = Number(res.headers.get('x-media-timestamp'));
    return {
      bytes,
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
      mediaTimestamp: Number.isFinite(ts) && ts > 0 ? ts : undefined,
      mediaOrigin: res.headers.get('x-media-origin') ?? undefined,
      requestId: res.headers.get('x-request-id') ?? first.headers.get('x-request-id') ?? undefined,
    };
  }

  async #json<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.#request(path, opts);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async #request(path: string, opts: RequestOptions = {}): Promise<Response> {
    const method = opts.method ?? 'GET';
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    const canRetry = opts.retry ?? true;
    let refreshedAfter401 = false;

    for (let attempt = 0; ; attempt++) {
      const token = await this.#tokens.getAccessToken();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: opts.accept ?? 'application/json',
        'User-Agent': this.#userAgent,
      };
      let body: string | undefined;
      if (opts.json !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(opts.json);
      } else if (opts.body !== undefined) {
        headers['Content-Type'] = opts.contentType ?? 'text/plain';
        body = opts.body;
      }

      const started = Date.now();
      let res: Response;
      try {
        res = await this.#fetch(url, { method, headers, body, redirect: opts.redirect ?? 'follow' });
      } catch (err) {
        this.#onRequest?.({ method, path, status: 0, durationMs: Date.now() - started, attempt, error: String(err) });
        if (canRetry && attempt < this.#maxRetries) {
          await this.#sleep(backoffDelay(attempt));
          continue;
        }
        throw err;
      }
      const requestId = res.headers.get('x-request-id') ?? undefined;
      this.#onRequest?.({ method, path: url.pathname + url.search, status: res.status, durationMs: Date.now() - started, attempt, requestId });

      const isRedirect = res.status >= 300 && res.status < 400;
      if (res.ok || (isRedirect && opts.redirect === 'manual')) return res;

      if (res.status === 401 && this.#tokens.invalidate && !refreshedAfter401) {
        refreshedAfter401 = true;
        this.#tokens.invalidate();
        await res.body?.cancel();
        continue;
      }
      const error = await toError(method, url.pathname, res);
      // A 429 means the request was rejected, not executed, so even side-effecting calls may retry.
      const retryable = error.status === 429 || (canRetry && error.retryable);
      if (retryable && attempt < this.#maxRetries) {
        await this.#sleep(backoffDelay(attempt, error.retryAfterMs));
        continue;
      }
      throw error;
    }
  }
}

function toDevice(raw: DeviceResource, index: Map<string, Resource>): Device {
  const rel = raw.relationships ?? {};
  return {
    id: raw.id,
    name: raw.attributes?.name ?? 'Unnamed device',
    imageUrl: raw.attributes?.image_url,
    status: resolveOne<DeviceStatusAttributes>(rel.status, index),
    capabilities: resolveOne<CapabilitiesAttributes>(rel.capabilities, index),
    configurations: resolveOne<ConfigurationsAttributes>(rel.configurations, index),
    location: resolveOne<LocationAttributes>(rel.location, index),
    raw,
  };
}

async function toError(method: string, path: string, res: Response): Promise<RingApiError> {
  const text = await res.text().catch(() => '');
  let errors: ApiErrorObject[] | undefined;
  try {
    const parsed = JSON.parse(text) as { errors?: ApiErrorObject[] };
    if (Array.isArray(parsed.errors)) errors = parsed.errors;
  } catch {
    // Not JSON: keep the raw text.
  }
  return new RingApiError({
    method,
    path,
    status: res.status,
    errors,
    body: errors ? undefined : text,
    requestId: res.headers.get('x-request-id') ?? undefined,
    retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
  });
}

function enc(id: string): string {
  return encodeURIComponent(id);
}
