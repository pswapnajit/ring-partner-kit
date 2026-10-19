import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { SimClock } from './clock.ts';
import type { SimDevice, SimWorld } from './world.ts';

// A local stand-in for https://api.amazonvision.com that follows the documented
// contract: JSON:API documents, ?include= sideloading, time-gated and paginated
// event history with composite event_types filters, the 303 + pre-signed URL
// media flow, chime playback, and JSON:API errors. Media is always PNG.

export interface SimServerOptions {
  world: SimWorld;
  /** Bearer token the API accepts. Defaults to "sim-token". */
  token?: string;
  port?: number;
  host?: string;
  /** Page size for event history. */
  pageSize?: number;
}

export interface RunningSimServer {
  server: Server;
  url: string;
  close(): Promise<void>;
}

const HISTORY_SUBTYPES = new Set(['human', 'vehicle', 'animal', 'other_motion', 'package_delivery', 'motion']);
const MAX_MEDIA_AGE_MS = 180 * 24 * 60 * 60 * 1000;

export async function startSimServer(opts: SimServerOptions): Promise<RunningSimServer> {
  const downloads = new Map<string, { deviceId: string; t: number; expires: number }>();
  const token = opts.token ?? 'sim-token';
  const world = opts.world;
  const pageSize = opts.pageSize ?? 50;
  let baseUrl = '';

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      sendError(res, 500, 'INTERNAL_ERROR', String(err?.message ?? err));
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://sim.local');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (path.startsWith('/sim/download/')) return serveDownload(path.slice('/sim/download/'.length), res);
    if (path.startsWith('/sim/')) return control(method, path, req, res);

    if (req.headers.authorization !== `Bearer ${token}`) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication credentials are missing or invalid');
    }
    res.setHeader('X-RateLimit-Limit', '100');
    res.setHeader('X-RateLimit-Remaining', '99');
    res.setHeader('X-Request-ID', randomUUID());

    if (method === 'GET' && path === '/v1/users/me') {
      return sendJson(res, 200, { data: { type: 'users', id: world.accountId, attributes: world.user } });
    }
    if (method === 'GET' && path === '/v1/devices') {
      const include = parseInclude(url);
      const devices = [...world.devices.values()];
      return sendJson(res, 200, {
        meta: { time: iso(world.clock.now()) },
        data: devices.map(deviceResource),
        ...(include.length ? { included: devices.flatMap((d) => includedFor(d, include)) } : {}),
      });
    }

    let m = path.match(/^\/v1\/history\/devices\/([^/]+)\/events$/);
    if (m && method === 'GET') return history(decodeURIComponent(m[1]), url, res);

    m = path.match(/^\/v1\/devices\/([^/]+)(?:\/(.+))?$/);
    if (!m) return sendError(res, 404, 'NOT_FOUND', `No route for ${method} ${path}`);
    const device = world.device(decodeURIComponent(m[1]));
    const sub = m[2];
    if (!device) return sendError(res, 404, 'DEVICE_NOT_FOUND', `Unknown device provided: ${decodeURIComponent(m[1])}`);

    if (method === 'GET' && !sub) {
      const include = parseInclude(url);
      return sendJson(res, 200, {
        meta: { time: iso(world.clock.now()) },
        data: deviceResource(device),
        ...(include.length ? { included: includedFor(device, include) } : {}),
      });
    }
    if (method === 'GET' && sub === 'status') return sendJson(res, 200, doc(statusResource(device)));
    if (method === 'GET' && sub === 'capabilities') return sendJson(res, 200, doc(capabilitiesResource(device)));
    if (method === 'GET' && sub === 'configurations') return sendJson(res, 200, doc(configurationsResource(device)));
    if (method === 'GET' && sub === 'location') return sendJson(res, 200, doc(locationResource(device)));
    if (method === 'POST' && sub === 'media/image/download') return imageDownload(device, req, res);
    if (method === 'POST' && sub === 'media/video/download') {
      return sendError(res, 416, 'MEDIA_NOT_FOUND', 'The simulator does not record video clips; use image snapshots');
    }
    if (method === 'POST' && sub === 'media/audio/playback') return playback(device, req, res);
    if (sub?.startsWith('media/streaming/whep/sessions')) {
      return sendError(res, 501, 'NOT_IMPLEMENTED', 'Live video is not simulated; use the Ring Developer Playground or a device');
    }
    return sendError(res, 404, 'NOT_FOUND', `No route for ${method} ${path}`);
  }

  function history(deviceId: string, url: URL, res: ServerResponse): void {
    const device = world.device(deviceId);
    if (!device) return sendError(res, 404, 'DEVICE_NOT_FOUND', `Unknown device provided: ${deviceId}`);
    const filters = (url.searchParams.get('event_types') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const f of filters) {
      const [type, subType] = f.split('.');
      if (!['motion', 'ding', 'on_demand'].includes(type) || (subType && (type !== 'motion' || !HISTORY_SUBTYPES.has(subType)))) {
        return sendError(res, 400, 'INVALID_PAYLOAD', `Unsupported event_types value: ${f}`);
      }
    }
    const pageKey = url.searchParams.get('page[key]');
    const before = pageKey ? Date.parse(pageKey) : Number.POSITIVE_INFINITY;
    if (pageKey && !Number.isFinite(before)) return sendError(res, 400, 'INVALID_PAYLOAD', 'page[key] must be an ISO timestamp');
    const now = world.clock.now();
    const matches = world.history
      .filter((e) => e.deviceId === deviceId && e.start >= world.consentAt && e.start <= now && e.start < before)
      .filter((e) => !filters.length || filters.some((f) => matchesFilter(e.eventType, e.subType, f)))
      .sort((a, b) => b.start - a.start);
    const page = matches.slice(0, pageSize);
    const cursor = page.length ? page[page.length - 1].start : Number.isFinite(before) ? before : now;
    const next = new URLSearchParams();
    if (filters.length) next.set('event_types', filters.join(','));
    next.set('page[key]', iso(cursor));
    sendJson(res, 200, {
      data: page.map((e) => ({
        type: 'history-events',
        id: e.id,
        attributes: { event_type: e.eventType, is_third_party_reviewed: e.reviewed, start: e.start, end: e.end },
        relationships: { source: { data: { type: 'devices', id: e.deviceId } } },
      })),
      // Like the real API, links.next is present even when there is nothing left.
      links: { next: `/v1/history/devices/${deviceId}/events?${next.toString().replace(/%5B/g, '[').replace(/%5D/g, ']')}` },
    });
  }

  async function imageDownload(device: SimDevice, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!world.isCamera(device)) return sendError(res, 400, 'INVALID_PAYLOAD', 'This device has no camera');
    const body = await readJson(req);
    if (!body || typeof body !== 'object') return sendError(res, 400, 'INVALID_PAYLOAD', 'Body must be a JSON object');
    const now = world.clock.now();
    const b = body as Record<string, unknown>;
    let t: number;
    if (b.type === 'at_timestamp') {
      if (typeof b.timestamp !== 'number') return sendError(res, 400, 'INVALID_PAYLOAD', 'timestamp is required for at_timestamp', 'timestamp');
      t = b.timestamp;
    } else if (b.type === 'latest_in_range') {
      if (typeof b.start_timestamp !== 'number') return sendError(res, 400, 'INVALID_PAYLOAD', 'start_timestamp is required for latest_in_range', 'start_timestamp');
      const end = typeof b.end_timestamp === 'number' ? b.end_timestamp : now;
      if (end - b.start_timestamp > 24 * 60 * 60 * 1000) return sendError(res, 400, 'INVALID_PAYLOAD', 'range must be 24 hours or less', 'end_timestamp');
      t = Math.min(end, now);
    } else {
      return sendError(res, 400, 'INVALID_PAYLOAD', 'type must be at_timestamp or latest_in_range', 'type');
    }
    if (t > now || now - t > MAX_MEDIA_AGE_MS) return sendError(res, 400, 'INVALID_PAYLOAD', 'timestamp must be within the last 180 days and not in the future', 'timestamp');
    if (Array.isArray(b.components) && b.components.length !== 1) return sendError(res, 400, 'INVALID_PAYLOAD', 'components takes exactly one entry', 'components');
    if (t < world.consentAt) return sendError(res, 416, 'MEDIA_NOT_FOUND', 'No media found in time range');
    const key = randomBytes(16).toString('hex');
    downloads.set(key, { deviceId: device.id, t, expires: Date.now() + 5 * 60_000 });
    res.writeHead(303, { Location: `${baseUrl}/sim/download/${key}?security_token=${key.slice(0, 8)}&req_type=image_download`, 'X-Request-ID': randomUUID() });
    res.end();
  }

  function serveDownload(rest: string, res: ServerResponse): void {
    const key = rest.split('?')[0];
    const entry = downloads.get(key);
    if (!entry || entry.expires < Date.now()) return sendError(res, 403, 'REQUEST_FORBIDDEN', 'Download URL expired or invalid');
    downloads.delete(key);
    const device = world.device(entry.deviceId);
    if (!device) return sendError(res, 404, 'DEVICE_NOT_FOUND', 'Unknown device');
    const headers = { 'X-Media-Timestamp': String(entry.t), 'X-Media-Origin': 'snapshot', 'X-Request-ID': randomUUID() };
    if (device.e2eEncrypted) {
      // Encrypted devices still answer, with content the partner cannot read.
      res.writeHead(200, { ...headers, 'Content-Type': 'image/jpeg' });
      res.end(randomBytes(4096));
      return;
    }
    const png = world.snapshotPng(entry.deviceId, entry.t);
    res.writeHead(200, { ...headers, 'Content-Type': 'image/png', 'Content-Length': String(png.length) });
    res.end(png);
  }

  async function playback(device: SimDevice, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await readJson(req)) as { data?: { type?: string; attributes?: { audio_ref?: string } } } | undefined;
    const audioRef = body?.data?.attributes?.audio_ref;
    if (body?.data?.type !== 'audio' || typeof audioRef !== 'string') {
      return sendError(res, 400, 'INVALID_PAYLOAD', 'Expected {"data":{"type":"audio","attributes":{"audio_ref":"..."}}}');
    }
    const result = world.playChime(device.id, audioRef);
    if (!result.ok) return sendError(res, result.status, result.code, result.detail);
    sendJson(res, 200, { data: { type: 'audio', id: audioRef, attributes: { status: 'completed' } }, meta: { time: iso(world.clock.now()) } });
  }

  async function control(method: string, path: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const clock = world.clock instanceof SimClock ? world.clock : undefined;
    if (method === 'GET' && path === '/sim/state') {
      return sendJson(res, 200, {
        now: world.clock.now(),
        speed: clock?.speed ?? 1,
        paused: clock?.paused ?? false,
        devices: [...world.devices.values()],
        pending: clock?.pending() ?? [],
        deliveries: world.deliveries.slice(-50),
        chimePlays: world.chimePlays.slice(-50),
      });
    }
    const body = ((await readJson(req)) ?? {}) as Record<string, any>;
    if (method === 'POST' && path === '/sim/clock' && clock) {
      if (typeof body.set === 'number') clock.set(body.set);
      if (typeof body.speed === 'number') clock.setSpeed(body.speed);
      if (body.pause) clock.pause();
      if (body.resume) clock.resume();
      if (typeof body.advanceMs === 'number') await clock.advance(body.advanceMs);
      return sendJson(res, 200, { now: clock.now(), speed: clock.speed, paused: clock.paused });
    }
    if (method === 'POST' && path === '/sim/webhooks') {
      world.webhookTargets = Array.isArray(body.targets) ? body.targets : body.url ? [{ url: body.url, signingKey: body.signingKey }] : [];
      return sendJson(res, 200, { targets: world.webhookTargets.map((t) => t.url) });
    }
    if (method === 'POST' && path === '/sim/actions') {
      const id = String(body.deviceId ?? '');
      switch (body.action) {
        case 'motion':
          await world.motion(id, String(body.subType ?? 'human'));
          break;
        case 'ding':
          await world.ding(id);
          break;
        case 'live_view':
          world.liveView(id);
          break;
        case 'door':
          await world.setDoor(id, Boolean(body.open));
          break;
        case 'reading':
          await world.setReading(id, body.kind === 'humidity' ? 'humidity' : 'temperature', Number(body.value));
          break;
        case 'online':
          await world.setOnline(id, Boolean(body.online));
          break;
        case 'place':
          world.place(id, body.object, world.clock.now(), body.durationMs ? world.clock.now() + Number(body.durationMs) : undefined);
          break;
        case 'remove':
          world.remove(id, body.object);
          break;
        default:
          return sendError(res, 400, 'INVALID_PAYLOAD', `unknown action ${body.action}`);
      }
      return sendJson(res, 200, { ok: true, now: world.clock.now() });
    }
    return sendError(res, 404, 'NOT_FOUND', `No route for ${method} ${path}`);
  }

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://${opts.host ?? '127.0.0.1'}:${address.port}`;
  return {
    server,
    url: baseUrl,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ------------------------------------------------------------- resources --

function deviceResource(d: SimDevice) {
  const rel = (name: string, type: string) => ({ data: { type, id: `${d.id}.${name}` }, links: { related: `/v1/devices/${d.id}/${name}` } });
  return {
    type: 'devices',
    id: d.id,
    attributes: { name: d.name, image_url: `https://sim.invalid/devices/${d.kind}.png` },
    relationships: {
      status: rel('status', 'device-status'),
      capabilities: rel('capabilities', 'device-capabilities'),
      configurations: rel('configurations', 'device-configurations'),
      location: rel('location', 'locations'),
    },
  };
}

function statusResource(d: SimDevice) {
  const attributes: Record<string, unknown> = { online: d.online };
  if (d.kind === 'chime') {
    attributes.audio = { snooze: { active: d.snoozeUntil != null, until: d.snoozeUntil != null ? iso(d.snoozeUntil) : null } };
  } else if (!['doorbell', 'camera', 'indoor_camera'].includes(d.kind)) {
    Object.assign(attributes, {
      reported_at: iso(d.reportedAt),
      signal_strength: { value: d.signal ?? 'good' },
      battery_status: { percentage: d.kind === 'air_quality' ? 255 : (d.batteryPercent ?? 100) },
      audio: { snooze: { active: null, until: null } },
      state: null,
    });
    if (d.kind === 'contact_sensor') {
      attributes.contact_detection = { faulted: Boolean(d.doorOpen) };
      attributes.tamper_detection = { detected: Boolean(d.tamper) };
      attributes.sensor_reporting_state = { value: 'active' };
    }
    if (d.kind === 'flood_freeze') {
      attributes.flood_detection = { faulted: Boolean(d.flood) };
      attributes.freeze_detection = { faulted: Boolean(d.freeze) };
      attributes.tamper_detection = { detected: Boolean(d.tamper) };
      attributes.sensor_reporting_state = { value: 'active' };
    }
    if (d.kind === 'temp_humidity' || d.kind === 'air_quality') {
      attributes.temperature = d.temperature ?? 21.5;
      attributes.humidity = d.humidity ?? 45;
    }
    if (d.kind === 'air_quality') {
      attributes.pm2_5 = d.pm25 ?? 4;
      attributes.co = d.co ?? 0;
    }
  } else if (d.batteryPercent !== undefined) {
    attributes.battery_status = { percentage: d.batteryPercent };
  }
  return { type: 'device-status', id: `${d.id}.status`, attributes };
}

function capabilitiesResource(d: SimDevice) {
  let attributes: Record<string, unknown>;
  if (['doorbell', 'camera', 'indoor_camera'].includes(d.kind)) {
    attributes = {
      video: { configurations: ['resolution_mode'], codecs: ['AVC'], ratio: '16:9', max_resolution: 1080, supported_resolutions: [1080] },
      motion_detection: { configurations: ['enabled', 'motion_zones'] },
      image_enhancements: { configurations: ['color_night_vision', 'hdr', 'ir_led_night_vision', 'privacy_zones'] },
    };
  } else if (d.kind === 'chime') {
    attributes = {
      video: { configurations: null, codecs: null, ratio: null, max_resolution: null, supported_resolutions: null },
      motion_detection: { configurations: null },
      image_enhancements: { configurations: null },
      audio: { customizable_slots: d.chimeSlots?.length ?? 0 },
    };
  } else {
    attributes = {
      video: null,
      motion_detection: null,
      image_enhancements: null,
      battery_status: d.kind === 'air_quality' ? null : { supported: true },
    };
  }
  return {
    type: 'device-capabilities',
    id: `${d.id}.capabilities`,
    attributes,
    relationships: { configurations: { links: { related: `/v1/devices/${d.id}/configurations` } } },
  };
}

function configurationsResource(d: SimDevice) {
  let attributes: Record<string, unknown>;
  if (['doorbell', 'camera', 'indoor_camera'].includes(d.kind)) {
    attributes = {
      e2e_encryption: { enabled: Boolean(d.e2eEncrypted) },
      motion_detection: { enabled: 'on', motion_zones: d.motionZones ?? [], component_id: '0' },
      video: { component_id: '0' },
      image_enhancements: { color_night_vision: 'off', hdr: 'off', ir_led_night_vision: 'on', auto_zoom_track: 'off', privacy_zones: d.privacyZones ?? [] },
    };
  } else if (d.kind === 'chime') {
    attributes = {
      motion_detection: { enabled: null },
      audio: { customizable_slots: d.chimeSlots ?? [], volume: d.volume ?? 4 },
      image_enhancements: { color_night_vision: null, hdr: null, ir_led_night_vision: null, auto_zoom_track: null },
    };
  } else {
    attributes = { motion_detection: null, image_enhancements: null, audio: null };
    if (d.temperatureThreshold) attributes.temperature_threshold = d.temperatureThreshold;
    if (d.humidityThreshold) attributes.humidity_threshold = d.humidityThreshold;
  }
  return { type: 'device-configurations', id: `${d.id}.configurations`, attributes };
}

function locationResource(d: SimDevice) {
  return { type: 'locations', id: `${d.id}.location`, attributes: { ...d.location } };
}

function includedFor(d: SimDevice, include: string[]) {
  const out = [];
  if (include.includes('status')) out.push(statusResource(d));
  if (include.includes('capabilities')) out.push(capabilitiesResource(d));
  if (include.includes('configurations')) out.push(configurationsResource(d));
  if (include.includes('location')) out.push(locationResource(d));
  return out;
}

function doc(data: unknown) {
  return { meta: { time: new Date().toISOString() }, data };
}

function matchesFilter(eventType: string, subType: string | undefined, filter: string): boolean {
  const [type, sub] = filter.split('.');
  if (type !== eventType) return false;
  return !sub || sub === subType;
}

function parseInclude(url: URL): string[] {
  return (url.searchParams.get('include') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

function iso(t: number): string {
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (!chunks.length) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, code: string, detail: string, pointer?: string): void {
  sendJson(res, status, {
    errors: [{ id: randomUUID(), status: String(status), code, detail, ...(pointer ? { source: { pointer } } : {}), meta: { timestamp: new Date().toISOString() } }],
  });
}
