import type { CapabilitiesAttributes, ConfigurationsAttributes, DeviceStatusAttributes } from './types.ts';

/**
 * A safe reading of a sensor's status that applies the documented gotchas:
 * - gate on `online` before trusting anything else;
 * - a device that never checked in reports `reported_at` as null or the Unix epoch;
 * - battery is meaningful only when capabilities declare it and the value is 0..100
 *   (the air quality monitor reports 255);
 * - `faulted: true` means the condition is active (an open door);
 * - readings are the last reported value, so carry `reportedAt` and a staleness flag.
 */
export interface SensorReading {
  online: boolean;
  reportedAt?: Date;
  stale: boolean;
  batteryPercent?: number;
  signal?: string;
  doorOpen?: boolean;
  flood?: boolean;
  freeze?: boolean;
  tamper?: boolean;
  temperatureC?: number;
  humidityPct?: number;
  pm25?: number;
  co?: number;
}

export interface ReadSensorOptions {
  capabilities?: CapabilitiesAttributes;
  now?: number;
  /** Readings older than this are flagged stale. Docs observed lags up to an hour. Defaults to 2 h. */
  staleAfterMs?: number;
}

export function readSensorStatus(status: DeviceStatusAttributes | undefined, opts: ReadSensorOptions = {}): SensorReading {
  const now = opts.now ?? Date.now();
  const staleAfter = opts.staleAfterMs ?? 2 * 60 * 60 * 1000;
  const online = status?.online === true;
  const reportedAt = parseReportedAt(status?.reported_at);
  const reading: SensorReading = {
    online,
    reportedAt,
    stale: !reportedAt || now - reportedAt.getTime() > staleAfter,
  };
  if (!online || !status) return reading;

  if (status.signal_strength?.value) reading.signal = status.signal_strength.value;
  const pct = status.battery_status?.percentage;
  const batterySupported = opts.capabilities ? opts.capabilities.battery_status?.supported === true : true;
  if (batterySupported && typeof pct === 'number' && pct >= 0 && pct <= 100) reading.batteryPercent = pct;

  if (status.contact_detection) reading.doorOpen = status.contact_detection.faulted === true;
  if (status.flood_detection) reading.flood = status.flood_detection.faulted === true;
  if (status.freeze_detection) reading.freeze = status.freeze_detection.faulted === true;
  if (status.tamper_detection) reading.tamper = status.tamper_detection.detected === true;
  if (typeof status.temperature === 'number') reading.temperatureC = status.temperature;
  if (typeof status.humidity === 'number') reading.humidityPct = status.humidity;
  if (typeof status.pm2_5 === 'number') reading.pm25 = status.pm2_5;
  if (typeof status.co === 'number') reading.co = status.co;
  return reading;
}

export function parseReportedAt(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  // The epoch is a placeholder for "never checked in", not a real time.
  if (!Number.isFinite(t) || t <= 0) return undefined;
  return new Date(t);
}

/**
 * Works out which bound a temperature or humidity event crossed. Exceeded events
 * name the direction (`threshold_type`) but not the limit; cleared events name
 * neither, so the configured thresholds are the only way to explain them.
 */
export function describeThreshold(
  kind: 'temperature' | 'humidity',
  value: number,
  config: ConfigurationsAttributes | undefined,
  thresholdType?: 'min' | 'max',
): { bound?: 'low' | 'high'; limit?: number } {
  const t = kind === 'temperature' ? config?.temperature_threshold : config?.humidity_threshold;
  if (!t) return { bound: thresholdType === 'min' ? 'low' : thresholdType === 'max' ? 'high' : undefined };
  if (thresholdType === 'min' || (!thresholdType && value < t.low)) return { bound: 'low', limit: t.low };
  if (thresholdType === 'max' || (!thresholdType && value > t.high)) return { bound: 'high', limit: t.high };
  return {};
}

/**
 * Ring devices carry no type field and capability keys are shared across families
 * (an alarm motion sensor also declares motion_detection), so classification can only
 * be a hint. Store the user's own mapping at setup time and treat this as a default.
 */
export type DeviceKindHint = 'camera' | 'chime' | 'sensor' | 'unknown';

export function guessDeviceKind(capabilities: CapabilitiesAttributes | undefined, status?: DeviceStatusAttributes): DeviceKindHint {
  if (!capabilities) return 'unknown';
  if ((capabilities.audio?.customizable_slots ?? 0) > 0) return 'chime';
  if (capabilities.video && (capabilities.video.codecs?.length || capabilities.video.max_resolution)) return 'camera';
  if (status && (status.contact_detection || status.flood_detection || typeof status.temperature === 'number' || typeof status.pm2_5 === 'number')) {
    return 'sensor';
  }
  if (capabilities.battery_status !== undefined && !capabilities.video) return 'sensor';
  return 'unknown';
}
