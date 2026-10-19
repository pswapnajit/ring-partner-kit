// Types for the Ring Partner API (Amazon Vision API), written from the public
// documentation at https://developer.amazon.com/docs/ring/api-documentation.html.
// Everything the docs call "open-ended" (motion sub_type, event types) is typed
// as a known union widened with `string`, so new values pass through instead of
// failing a type check or a runtime validation.

export interface ResourceIdentifier {
  type: string;
  id: string;
}

export interface Relationship {
  data?: ResourceIdentifier | ResourceIdentifier[] | null;
  links?: { related?: string; self?: string };
}

export interface Resource<A = Record<string, unknown>> {
  type: string;
  id: string;
  attributes: A;
  relationships?: Record<string, Relationship>;
}

export interface Document<D> {
  data: D;
  included?: Resource[];
  meta?: { time?: string; [key: string]: unknown };
  links?: { next?: string; [key: string]: unknown };
}

// ---------------------------------------------------------------- devices --

export interface DeviceAttributes {
  name: string;
  image_url?: string;
}

export interface Vertex {
  x: number;
  y: number;
}

export interface Zone {
  id: string;
  vertices: Vertex[];
}

export interface SnoozeState {
  active: boolean | null;
  until: string | null;
}

/** Union of every status attribute the docs describe across cameras, sensors and chimes. */
export interface DeviceStatusAttributes {
  online: boolean | null;
  reported_at?: string | null;
  signal_strength?: { value: string };
  battery_status?: { percentage: number };
  audio?: { snooze?: SnoozeState };
  state?: unknown;
  sensor_reporting_state?: { value: string };
  contact_detection?: { faulted: boolean };
  flood_detection?: { faulted: boolean };
  freeze_detection?: { faulted: boolean };
  tamper_detection?: { detected: boolean };
  temperature?: number;
  humidity?: number;
  pm2_5?: number;
  co?: number;
}

export interface CameraComponent {
  component_id: string;
  component_type?: string;
  component_name?: string;
}

export interface CapabilitiesAttributes {
  video?: {
    configurations?: string[] | null;
    codecs?: string[] | null;
    ratio?: string | null;
    max_resolution?: number | null;
    supported_resolutions?: number[] | null;
    component_id?: string;
  } | null;
  motion_detection?: { configurations?: string[] | null } | null;
  image_enhancements?: { configurations?: string[] | null } | null;
  /** Chimes only: how many partner audio slots exist. */
  audio?: { customizable_slots?: number } | null;
  /** Sensors: `{supported: true}` when the device reports battery, `null` otherwise. */
  battery_status?: { supported?: boolean } | null;
  /** Multi-camera devices (Ring Elite) only. */
  components?: { items: CameraComponent[] };
}

export interface ChimeSlot {
  event: string;
  disabled: boolean;
  audio_ref: string;
  audio_url?: string;
  audio_name?: string;
}

export interface ConfigurationsAttributes {
  e2e_encryption?: { enabled: boolean } | null;
  motion_detection?: {
    enabled?: 'on' | 'off' | null;
    motion_zones?: Zone[];
    component_id?: string;
  } | null;
  video?: { component_id?: string } | null;
  image_enhancements?: {
    color_night_vision?: string | null;
    hdr?: string | null;
    ir_led_night_vision?: string | null;
    auto_zoom_track?: string | null;
    privacy_zones?: Zone[];
  } | null;
  /** Chimes only. Read-only to partners. */
  audio?: { customizable_slots?: ChimeSlot[]; volume?: number } | null;
  /** Temperature/humidity sensors and air quality monitors. Read-only. */
  temperature_threshold?: { high: number; low: number };
  humidity_threshold?: { high: number; low: number };
}

export interface LocationAttributes {
  country?: string;
  state?: string;
  [key: string]: unknown;
}

export type DeviceResource = Resource<DeviceAttributes>;

/** A device with its sideloaded relationships resolved (see `RingClient.devices`). */
export interface Device {
  id: string;
  name: string;
  imageUrl?: string;
  status?: DeviceStatusAttributes;
  capabilities?: CapabilitiesAttributes;
  configurations?: ConfigurationsAttributes;
  location?: LocationAttributes;
  raw: DeviceResource;
}

export type IncludeKey = 'status' | 'capabilities' | 'configurations' | 'location';

// ------------------------------------------------------------ event history --

export type KnownHistoryEventType = 'motion' | 'on_demand' | 'ding';

export interface HistoryEventAttributes {
  event_type: KnownHistoryEventType | (string & {});
  is_third_party_reviewed: boolean;
  start: number;
  end: number;
}

export type HistoryEvent = Resource<HistoryEventAttributes>;

// ------------------------------------------------------------------ media --

export interface SnapshotRequest {
  type: 'at_timestamp' | 'latest_in_range';
  timestamp?: number;
  start_timestamp?: number;
  end_timestamp?: number;
  image_options?: {
    format?: 'jpeg' | 'png';
    resolution?: { width: number; height: number };
  };
  components?: Array<{ component_id: string }>;
}

export interface MediaDownload {
  bytes: Uint8Array;
  contentType: string;
  /** X-Media-Timestamp: epoch ms of the frame actually returned. */
  mediaTimestamp?: number;
  /** X-Media-Origin: "recording" or "snapshot". */
  mediaOrigin?: string;
  requestId?: string;
}

export interface ChimePlaybackResult {
  audioRef: string;
  status: string;
}

// ---------------------------------------------------------------- account --

export interface UserAttributes {
  first_name?: string;
  last_name?: string;
  email?: string;
  phone_number?: string;
  [key: string]: unknown;
}

// --------------------------------------------------------------- webhooks --

export type KnownWebhookType =
  | 'motion_detected'
  | 'button_press'
  | 'device_added'
  | 'device_removed'
  | 'device_online'
  | 'device_offline'
  | 'app_integration_added'
  | 'app_integration_removed'
  | 'subscription_activated'
  | 'subscription_deactivated'
  | 'contact_sensor_faulted'
  | 'contact_sensor_cleared'
  | 'tamper_detected'
  | 'tamper_cleared'
  | 'flood_detected'
  | 'flood_cleared'
  | 'freeze_detected'
  | 'freeze_cleared'
  | 'temperature_exceeded'
  | 'temperature_cleared'
  | 'humidity_exceeded'
  | 'humidity_cleared'
  | 'pm25_exceeded'
  | 'pm25_cleared'
  | 'co_exceeded'
  | 'co_cleared';

/** Motion classifications. Open-ended: Smart Alerts off sends `motion`, on sends the rest. */
export type KnownMotionSubType = 'motion' | 'human' | 'vehicle' | 'package_delivery' | 'other_motion' | 'animal';

export interface WebhookMeta {
  version: string;
  time: string;
  request_id: string;
  account_id?: string;
}

export interface WebhookAttributes {
  source?: string;
  source_type?: string;
  source_id?: string;
  timestamp?: number;
  timestamp_readable?: string;
  sub_type?: KnownMotionSubType | (string & {});
  component_ids?: string[];
  temperature?: number;
  humidity?: number;
  pm25_level?: number;
  threshold_type?: 'min' | 'max';
  [key: string]: unknown;
}

export interface WebhookPayload {
  meta: WebhookMeta;
  data: {
    id: string;
    type: KnownWebhookType | (string & {});
    attributes: WebhookAttributes;
    relationships?: Record<string, unknown>;
  };
}
