import type { RingClient } from './client.ts';
import type { CapabilitiesAttributes, ChimePlaybackResult, ChimeSlot, ConfigurationsAttributes, DeviceStatusAttributes } from './types.ts';

/** A chime is the device whose capabilities report partner audio slots. Never infer it from image_url or name. */
export function isChime(capabilities: CapabilitiesAttributes | undefined): boolean {
  return (capabilities?.audio?.customizable_slots ?? 0) > 0;
}

/** Slots sorted by event name (the API does not return them in order). */
export function chimeSlots(configurations: ConfigurationsAttributes | undefined): ChimeSlot[] {
  return [...(configurations?.audio?.customizable_slots ?? [])].sort((a, b) => a.event.localeCompare(b.event));
}

/**
 * Finds the slot bound to a partner event name such as "ring-appstore-event-1".
 * Store event names, not audio_ref values: an audio_ref can change when the user
 * re-runs setup, while the event name stays.
 */
export function findSlot(configurations: ConfigurationsAttributes | undefined, event: string): ChimeSlot | undefined {
  return chimeSlots(configurations).find((slot) => slot.event === event);
}

export type ChimeBlockReason = 'not_a_chime' | 'offline' | 'snoozed' | 'no_slot' | 'slot_disabled';

export interface ChimeCheck {
  ok: boolean;
  reason?: ChimeBlockReason;
  slot?: ChimeSlot;
  snoozedUntil?: string | null;
}

/** The documented pre-checks before playback: is a chime, online, not snoozed, slot present and enabled. */
export function checkChime(
  device: { capabilities?: CapabilitiesAttributes; configurations?: ConfigurationsAttributes; status?: DeviceStatusAttributes },
  event: string,
): ChimeCheck {
  if (!isChime(device.capabilities)) return { ok: false, reason: 'not_a_chime' };
  if (device.status?.online !== true) return { ok: false, reason: 'offline' };
  const snooze = device.status.audio?.snooze;
  if (snooze?.active === true) return { ok: false, reason: 'snoozed', snoozedUntil: snooze.until };
  const slot = findSlot(device.configurations, event);
  if (!slot) return { ok: false, reason: 'no_slot' };
  if (slot.disabled) return { ok: false, reason: 'slot_disabled', slot };
  return { ok: true, slot };
}

export interface PlayChimeResult extends ChimeCheck {
  played: boolean;
  result?: ChimePlaybackResult;
}

/**
 * Plays the audio in one of your app's slots, after re-reading the chime's
 * capabilities, configurations and status in a single request. It never
 * overrides a snooze and never retries: playback is sound in someone's home.
 */
export async function playChimeSlot(client: RingClient, deviceId: string, event: string): Promise<PlayChimeResult> {
  const device = await client.device(deviceId, { include: ['capabilities', 'configurations', 'status'] });
  const check = checkChime(device, event);
  if (!check.ok || !check.slot) return { ...check, played: false };
  const result = await client.playChimeAudio(deviceId, check.slot.audio_ref);
  return { ...check, played: result.status === 'completed', result };
}
