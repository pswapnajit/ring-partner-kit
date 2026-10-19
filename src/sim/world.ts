import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { signatureHeader } from '../webhooks.ts';
import type { ChimeSlot, WebhookPayload, Zone } from '../types.ts';
import type { Clock } from './clock.ts';
import { renderScenePng, type SceneObject } from './scene.ts';

export type SimDeviceKind =
  | 'doorbell'
  | 'camera'
  | 'indoor_camera'
  | 'chime'
  | 'contact_sensor'
  | 'temp_humidity'
  | 'air_quality'
  | 'flood_freeze';

export interface SimDevice {
  id: string;
  name: string;
  kind: SimDeviceKind;
  online: boolean;
  reportedAt: number;
  batteryPercent?: number;
  signal?: string;
  location: { country: string; state?: string };
  // cameras
  motionZones?: Zone[];
  privacyZones?: Zone[];
  e2eEncrypted?: boolean;
  smartAlerts?: boolean;
  // sensors
  doorOpen?: boolean;
  tamper?: boolean;
  flood?: boolean;
  freeze?: boolean;
  temperature?: number;
  humidity?: number;
  pm25?: number;
  co?: number;
  temperatureThreshold?: { low: number; high: number };
  humidityThreshold?: { low: number; high: number };
  // chimes
  chimeSlots?: ChimeSlot[];
  volume?: number;
  snoozeUntil?: number | null;
}

export interface SimHistoryEvent {
  id: string;
  deviceId: string;
  eventType: 'motion' | 'ding' | 'on_demand';
  subType?: string;
  start: number;
  end: number;
  reviewed: boolean;
}

export interface SceneInterval {
  deviceId: string;
  object: SceneObject;
  from: number;
  to: number;
}

export interface WebhookTarget {
  url: string;
  signingKey: string;
}

export interface WebhookDelivery {
  at: number;
  url: string;
  type: string;
  requestId: string;
  status: number;
  attempts: number;
  error?: string;
}

export interface ChimePlay {
  at: number;
  deviceId: string;
  audioRef: string;
  audioName?: string;
}

export interface SimWorldOptions {
  clock: Clock;
  accountId?: string;
  user?: { first_name: string; last_name: string; email: string };
  /** IANA zone used for snapshot captions and day/night lighting. */
  timeZone?: string;
  /** Event history before this time is hidden, like the real time-gated API. */
  consentAt?: number;
  /** Await webhook delivery inline (deterministic tests) instead of in the background. */
  syncWebhooks?: boolean;
  fetch?: typeof fetch;
}

const MOTION_SUBTYPE_OBJECT: Record<string, SceneObject | undefined> = {
  human: 'person',
  package_delivery: 'person',
  vehicle: 'car',
};

/**
 * In-memory model of one Ring account: devices, event history, sensor state,
 * what each camera would see, chime playback, and signed webhook delivery.
 */
export class SimWorld extends EventEmitter {
  readonly clock: Clock;
  readonly accountId: string;
  readonly user: { first_name: string; last_name: string; email: string };
  readonly timeZone: string;
  consentAt: number;
  readonly devices = new Map<string, SimDevice>();
  history: SimHistoryEvent[] = [];
  scenes: SceneInterval[] = [];
  readonly chimePlays: ChimePlay[] = [];
  readonly deliveries: WebhookDelivery[] = [];
  webhookTargets: WebhookTarget[] = [];
  readonly #syncWebhooks: boolean;
  readonly #fetch: typeof fetch;
  #counter = 0;

  constructor(opts: SimWorldOptions) {
    super();
    this.clock = opts.clock;
    this.accountId = opts.accountId ?? 'ava1.ring.account.SIM0001';
    this.user = opts.user ?? { first_name: 'Sim', last_name: 'User', email: 'sim.user@example.com' };
    this.timeZone = opts.timeZone ?? 'America/New_York';
    this.consentAt = opts.consentAt ?? 0;
    this.#syncWebhooks = opts.syncWebhooks ?? false;
    this.#fetch = opts.fetch ?? fetch;
  }

  // ---------------------------------------------------------------- setup --

  addDevice(spec: Omit<SimDevice, 'id' | 'online' | 'reportedAt' | 'location'> & Partial<Pick<SimDevice, 'id' | 'online' | 'location'>>): SimDevice {
    const id = spec.id ?? `ava1.ring.device.SIM${String(++this.#counter).padStart(4, '0')}${randomBytes(3).toString('hex').toUpperCase()}`;
    const device: SimDevice = {
      online: true,
      reportedAt: this.clock.now(),
      location: { country: 'US', state: 'NJ' },
      signal: 'good',
      ...spec,
      id,
    };
    if (device.kind === 'chime' && !device.chimeSlots) {
      device.chimeSlots = [
        { event: 'ring-appstore-event-2', disabled: false, audio_ref: randomUUID(), audio_url: 'https://sim.invalid/audio/soft-bell.wav', audio_name: 'Soft Bell' },
        { event: 'ring-appstore-event-1', disabled: false, audio_ref: randomUUID(), audio_url: 'https://sim.invalid/audio/good-morning.wav', audio_name: 'Good Morning' },
      ];
      device.volume ??= 4;
      device.snoozeUntil ??= null;
    }
    this.devices.set(id, device);
    return device;
  }

  device(id: string): SimDevice | undefined {
    return this.devices.get(id);
  }

  isCamera(device: SimDevice): boolean {
    return device.kind === 'doorbell' || device.kind === 'camera' || device.kind === 'indoor_camera';
  }

  // --------------------------------------------------------------- events --

  /** Records a history event without emitting a webhook (for backfilling past weeks). */
  recordHistory(e: Omit<SimHistoryEvent, 'id' | 'reviewed'> & { reviewed?: boolean }): SimHistoryEvent {
    const event: SimHistoryEvent = {
      id: `ava1.ring.event.${e.start}.${randomBytes(4).toString('hex')}`,
      reviewed: false,
      ...e,
    };
    this.history.push(event);
    return event;
  }

  /** Puts an object in a camera's view for a time range (drives snapshots). */
  place(deviceId: string, object: SceneObject, from: number, to = Number.POSITIVE_INFINITY): SceneInterval {
    const interval = { deviceId, object, from, to };
    this.scenes.push(interval);
    return interval;
  }

  /** Ends every open interval for that object on that camera. */
  remove(deviceId: string, object: SceneObject, at = this.clock.now()): void {
    for (const s of this.scenes) if (s.deviceId === deviceId && s.object === object && s.from <= at && s.to > at) s.to = at;
  }

  objectsAt(deviceId: string, t: number): SceneObject[] {
    const set = new Set<SceneObject>();
    for (const s of this.scenes) if (s.deviceId === deviceId && s.from <= t && t < s.to) set.add(s.object);
    return [...set];
  }

  async motion(deviceId: string, subType: string, opts: { at?: number; durationMs?: number; showObjectMs?: number } = {}): Promise<SimHistoryEvent> {
    const device = this.#require(deviceId);
    const start = opts.at ?? this.clock.now();
    const end = start + (opts.durationMs ?? 20_000);
    // With Smart Alerts off, Ring classifies nothing and every event is plain "motion".
    const effective = device.smartAlerts === false ? 'motion' : subType;
    const event = this.recordHistory({ deviceId, eventType: 'motion', subType: effective, start, end });
    const object = MOTION_SUBTYPE_OBJECT[subType];
    if (object && opts.showObjectMs !== 0) this.place(deviceId, object, start, start + (opts.showObjectMs ?? 45_000));
    this.emit('event', { kind: 'motion', deviceId, subType: effective, at: start });
    await this.#webhook('motion_detected', deviceId, start, { sub_type: effective, timestamp_readable: this.#readable(start) });
    return event;
  }

  async ding(deviceId: string, opts: { at?: number } = {}): Promise<SimHistoryEvent> {
    this.#require(deviceId);
    const start = opts.at ?? this.clock.now();
    const event = this.recordHistory({ deviceId, eventType: 'ding', start, end: start + 15_000 });
    this.emit('event', { kind: 'ding', deviceId, at: start });
    await this.#webhook('button_press', deviceId, start);
    return event;
  }

  /** A live view opened from the Ring app (shows up in history as on_demand). */
  liveView(deviceId: string, opts: { at?: number } = {}): SimHistoryEvent {
    this.#require(deviceId);
    const start = opts.at ?? this.clock.now();
    this.emit('event', { kind: 'on_demand', deviceId, at: start });
    return this.recordHistory({ deviceId, eventType: 'on_demand', start, end: start + 30_000 });
  }

  async setDoor(deviceId: string, open: boolean): Promise<void> {
    const device = this.#require(deviceId);
    if (device.doorOpen === open) return;
    device.doorOpen = open;
    device.reportedAt = this.clock.now();
    this.emit('event', { kind: open ? 'door_open' : 'door_closed', deviceId, at: device.reportedAt });
    await this.#webhook(open ? 'contact_sensor_faulted' : 'contact_sensor_cleared', deviceId, device.reportedAt);
  }

  /** Updates a reading and emits *_exceeded / *_cleared when it crosses the configured band. */
  async setReading(deviceId: string, kind: 'temperature' | 'humidity', value: number): Promise<void> {
    const device = this.#require(deviceId);
    const band = kind === 'temperature' ? device.temperatureThreshold : device.humidityThreshold;
    const before = device[kind];
    device[kind] = value;
    device.reportedAt = this.clock.now();
    if (!band) return;
    const outside = (v: number | undefined) => v !== undefined && (v < band.low || v > band.high);
    const wasOut = outside(before);
    const isOut = outside(value);
    if (isOut && !wasOut) {
      await this.#webhook(`${kind}_exceeded`, deviceId, device.reportedAt, { [kind]: value, threshold_type: value > band.high ? 'max' : 'min' });
    } else if (!isOut && wasOut) {
      await this.#webhook(`${kind}_cleared`, deviceId, device.reportedAt, { [kind]: value });
    }
    this.emit('event', { kind, deviceId, value, at: device.reportedAt });
  }

  async setOnline(deviceId: string, online: boolean): Promise<void> {
    const device = this.#require(deviceId);
    if (device.online === online) return;
    device.online = online;
    if (online) device.reportedAt = this.clock.now();
    this.emit('event', { kind: online ? 'online' : 'offline', deviceId, at: this.clock.now() });
    await this.#webhook(online ? 'device_online' : 'device_offline', deviceId, this.clock.now());
  }

  setSnooze(deviceId: string, until: number | null): void {
    this.#require(deviceId).snoozeUntil = until;
  }

  // ---------------------------------------------------------------- media --

  snapshotPng(deviceId: string, t: number): Uint8Array {
    const device = this.#require(deviceId);
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: this.timeZone, hour: 'numeric', hourCycle: 'h23' }).format(t));
    const minute = Number(new Intl.DateTimeFormat('en-US', { timeZone: this.timeZone, minute: 'numeric' }).format(t));
    for (const h of this.history) if (h.deviceId === deviceId && h.start <= t + 60_000 && t - 60_000 <= h.end) h.reviewed = true;
    return renderScenePng({
      objects: this.objectsAt(deviceId, t),
      hour: hour + minute / 60,
      caption: `${device.name}  ${this.#readable(t)}`,
      seed: Math.floor(t / 3_600_000),
      width: 1280,
      height: 720,
    });
  }

  playChime(deviceId: string, audioRef: string): { ok: true; slot: ChimeSlot } | { ok: false; status: number; code: string; detail: string } {
    const device = this.devices.get(deviceId);
    if (!device) return { ok: false, status: 404, code: 'DEVICE_NOT_FOUND', detail: `Unknown device provided: ${deviceId}` };
    if (device.kind !== 'chime') return { ok: false, status: 400, code: 'INVALID_PAYLOAD', detail: 'device does not support audio playback' };
    if (!device.online) return { ok: false, status: 503, code: 'DEVICE_OFFLINE', detail: 'device is offline' };
    const slot = device.chimeSlots?.find((s) => s.audio_ref === audioRef);
    if (!slot) return { ok: false, status: 400, code: 'INVALID_PAYLOAD', detail: 'audio_ref is not assigned to one of your slots' };
    const play: ChimePlay = { at: this.clock.now(), deviceId, audioRef, audioName: slot.audio_name };
    this.chimePlays.push(play);
    this.emit('chime', play);
    return { ok: true, slot };
  }

  // ------------------------------------------------------------- webhooks --

  async #webhook(type: string, deviceId: string, timestamp: number, extra: Record<string, unknown> = {}): Promise<void> {
    if (!this.webhookTargets.length) return;
    const payload: WebhookPayload = {
      meta: { version: '1.1', time: new Date(this.clock.now()).toISOString(), request_id: randomUUID(), account_id: this.accountId },
      data: {
        id: `${deviceId}_${type}_${timestamp}`,
        type,
        attributes: { source: deviceId, source_type: 'devices', timestamp, ...extra },
        relationships: { devices: { links: { self: `/v1/devices/${deviceId}` } } },
      },
    };
    const work = Promise.all(this.webhookTargets.map((target) => this.#deliver(target, payload)));
    if (this.#syncWebhooks) await work;
    else void work;
  }

  async #deliver(target: WebhookTarget, payload: WebhookPayload): Promise<void> {
    const body = JSON.stringify(payload);
    const delays = [0, 1000, 5000];
    let lastStatus = 0;
    let lastError: string | undefined;
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt] && !this.#syncWebhooks) await new Promise((r) => setTimeout(r, delays[attempt]));
      try {
        const res = await this.#fetch(target.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Signature': signatureHeader(target.signingKey, body) },
          body,
          signal: AbortSignal.timeout(5000),
        });
        lastStatus = res.status;
        lastError = undefined;
        await res.body?.cancel();
        // 2xx done, 4xx permanent (Ring does not retry), 5xx retried.
        if (res.status < 500) break;
      } catch (err) {
        lastError = String(err);
        lastStatus = 0;
      }
    }
    const delivery: WebhookDelivery = {
      at: this.clock.now(),
      url: target.url,
      type: payload.data.type,
      requestId: payload.meta.request_id,
      status: lastStatus,
      attempts: 1,
      error: lastError,
    };
    this.deliveries.push(delivery);
    if (this.deliveries.length > 500) this.deliveries.shift();
    this.emit('delivery', delivery);
  }

  #require(deviceId: string): SimDevice {
    const device = this.devices.get(deviceId);
    if (!device) throw new Error(`unknown sim device ${deviceId}`);
    return device;
  }

  #readable(t: number): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(t);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
  }
}
