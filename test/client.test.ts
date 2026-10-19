import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RefreshTokenProvider,
  RingApiError,
  RingClient,
  checkChime,
  decodePng,
  isChime,
  playChimeSlot,
  type RequestLog,
} from '../src/index.ts';
import { SimClock, SimWorld, startSimServer, type RunningSimServer } from '../src/sim/index.ts';

const T0 = Date.parse('2026-10-20T14:00:00Z');
const clock = new SimClock(T0, 0);
clock.pause();
const world = new SimWorld({ clock, consentAt: T0 - 3 * 24 * 3600_000, syncWebhooks: true });
const doorbell = world.addDevice({ name: 'Front Door', kind: 'doorbell', smartAlerts: true, privacyZones: [] });
const chime = world.addDevice({ name: 'Hallway Chime', kind: 'chime' });
const contact = world.addDevice({ name: 'Front Door Contact', kind: 'contact_sensor', doorOpen: false, batteryPercent: 80 });
let sim: RunningSimServer;
const logs: RequestLog[] = [];
let client: RingClient;

before(async () => {
  sim = await startSimServer({ world, pageSize: 50 });
  client = new RingClient({ token: 'sim-token', baseUrl: sim.url, onRequest: (l) => logs.push(l) });
  // 120 motion events in the last ~2 days plus one before consent (must be hidden).
  for (let i = 0; i < 120; i++) {
    world.recordHistory({ deviceId: doorbell.id, eventType: 'motion', subType: i % 3 === 0 ? 'package_delivery' : 'human', start: T0 - (i + 1) * 20 * 60_000, end: T0 - (i + 1) * 20 * 60_000 + 15_000 });
  }
  world.recordHistory({ deviceId: doorbell.id, eventType: 'ding', start: T0 - 10 * 60_000, end: T0 - 9 * 60_000 });
  world.recordHistory({ deviceId: doorbell.id, eventType: 'motion', subType: 'human', start: T0 - 10 * 24 * 3600_000, end: T0 - 10 * 24 * 3600_000 + 1 });
});

after(async () => {
  await sim.close();
});

test('devices() sideloads and resolves included resources', async () => {
  const devices = await client.devices({ include: ['status', 'capabilities', 'configurations', 'location'] });
  assert.equal(devices.length, 3);
  const bell = devices.find((d) => d.id === doorbell.id)!;
  assert.equal(bell.name, 'Front Door');
  assert.equal(bell.status?.online, true);
  assert.deepEqual(bell.capabilities?.video?.codecs, ['AVC']);
  assert.deepEqual(bell.configurations?.image_enhancements?.privacy_zones, []);
  assert.equal(bell.location?.country, 'US');
  const ch = devices.find((d) => d.id === chime.id)!;
  assert.ok(isChime(ch.capabilities));
  assert.equal(ch.configurations?.audio?.customizable_slots?.length, 2);
});

test('history() follows links.next across pages and stops on an empty page', async () => {
  const all = [];
  for await (const e of client.history(doorbell.id)) all.push(e);
  assert.equal(all.length, 121, '120 motion + 1 ding, the pre-consent event is time-gated out');
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].attributes.start >= all[i].attributes.start, 'newest first');
});

test('history() composite filters select by detection subtype', async () => {
  const packages = [];
  for await (const e of client.history(doorbell.id, { eventTypes: ['motion.package_delivery'] })) packages.push(e);
  assert.equal(packages.length, 40);
  const dings = await client.historyPage(doorbell.id, { eventTypes: ['ding', 'on_demand'] });
  assert.equal(dings.events.length, 1);
  assert.equal(dings.events[0].attributes.event_type, 'ding');
  await assert.rejects(client.historyPage(doorbell.id, { eventTypes: ['motion.dragon'] }), (e: unknown) => e instanceof RingApiError && e.status === 400);
});

test('snapshot() follows the 303 to the pre-signed URL and returns a PNG', async () => {
  world.place(doorbell.id, 'package', T0 - 60 * 60_000);
  const shot = await client.snapshot(doorbell.id, { type: 'latest_in_range', start_timestamp: T0 - 30 * 60_000, image_options: { format: 'png' } });
  assert.equal(shot.contentType, 'image/png');
  assert.equal(shot.mediaTimestamp, T0);
  const png = decodePng(shot.bytes);
  assert.equal(png.width, 1280);
  assert.equal(png.text['sim:objects'], 'package');
  const presigned = logs.find((l) => l.path === '(pre-signed download URL)');
  assert.ok(presigned, 'the download hop is logged');
});

test('snapshot() validates the request like the API does', async () => {
  await assert.rejects(client.snapshot(doorbell.id, { type: 'at_timestamp' }), (e: unknown) => e instanceof RingApiError && e.code === 'INVALID_PAYLOAD');
  await assert.rejects(client.snapshot(contact.id, { type: 'at_timestamp', timestamp: T0 }), /no camera/);
});

test('playChimeSlot plays only when online, not snoozed and the slot is enabled', async () => {
  const ok = await playChimeSlot(client, chime.id, 'ring-appstore-event-1');
  assert.equal(ok.played, true);
  assert.equal(world.chimePlays.length, 1);
  assert.equal(world.chimePlays[0].audioName, 'Good Morning');

  world.setSnooze(chime.id, T0 + 3600_000);
  const snoozed = await playChimeSlot(client, chime.id, 'ring-appstore-event-1');
  assert.equal(snoozed.played, false);
  assert.equal(snoozed.reason, 'snoozed');
  world.setSnooze(chime.id, null);

  const missing = await playChimeSlot(client, chime.id, 'ring-appstore-event-9');
  assert.equal(missing.reason, 'no_slot');
  const notChime = await playChimeSlot(client, doorbell.id, 'ring-appstore-event-1');
  assert.equal(notChime.reason, 'not_a_chime');
  assert.equal(world.chimePlays.length, 1, 'nothing else made a sound');
  assert.equal(checkChime({ capabilities: { audio: { customizable_slots: 1 } }, status: { online: false } }, 'x').reason, 'offline');
});

test('errors carry the documented code; 401 and 404 are not retried', async () => {
  const bad = new RingClient({ token: 'wrong', baseUrl: sim.url, sleep: async () => {} });
  await assert.rejects(bad.devices(), (e: unknown) => e instanceof RingApiError && e.unauthorized && e.code === 'UNAUTHORIZED');
  await assert.rejects(client.status('ava1.ring.device.NOPE'), (e: unknown) => e instanceof RingApiError && e.code === 'DEVICE_NOT_FOUND');
});

test('429 is retried with Retry-After; chime playback is never retried on 5xx', async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const fake: typeof fetch = async (input) => {
    calls++;
    const url = String(input);
    if (url.includes('/playback')) return new Response(JSON.stringify({ errors: [{ status: '500', code: 'INTERNAL_ERROR' }] }), { status: 500 });
    if (calls < 3) return new Response('{"errors":[{"status":"429"}]}', { status: 429, headers: { 'Retry-After': '2' } });
    return new Response(JSON.stringify({ data: { type: 'device-status', id: 's', attributes: { online: true } } }), { status: 200 });
  };
  const c = new RingClient({ token: 't', baseUrl: 'https://api.example.test', fetch: fake, sleep: async (ms) => void sleeps.push(ms) });
  const status = await c.status('d');
  assert.equal(status.online, true);
  assert.deepEqual(sleeps, [2000, 2000]);
  calls = 0;
  await assert.rejects(c.playChimeAudio('d', 'ref'), (e: unknown) => e instanceof RingApiError && e.status === 500);
  assert.equal(calls, 1, 'sound in a home is never repeated by a retry loop');
});

test('RefreshTokenProvider exchanges, caches, rotates and refreshes after 401', async () => {
  let exchanges = 0;
  let rotated = '';
  let apiCalls = 0;
  const fake: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://oauth.ring.com')) {
      exchanges++;
      const form = new URLSearchParams(String(init?.body));
      assert.equal(form.get('grant_type'), 'refresh_token');
      return Response.json({ access_token: `access-${exchanges}`, refresh_token: `refresh-${exchanges}`, expires_in: 14400, token_type: 'Bearer' });
    }
    apiCalls++;
    const auth = new Headers(init?.headers).get('authorization');
    if (auth === 'Bearer access-1') return new Response('{"errors":[{"status":"401","code":"UNAUTHORIZED"}]}', { status: 401 });
    return Response.json({ data: { type: 'users', id: 'acct', attributes: { first_name: 'A' } } });
  };
  const provider = new RefreshTokenProvider({ clientId: 'c', clientSecret: 's', refreshToken: 'r0', fetch: fake, onRotate: (t) => void (rotated = t.refreshToken) });
  const c = new RingClient({ token: provider, baseUrl: 'https://api.example.test', fetch: fake, sleep: async () => {} });
  const me = await c.me();
  assert.equal(me.id, 'acct');
  assert.equal(exchanges, 2, 'first token was rejected, so the provider refreshed once');
  assert.equal(apiCalls, 2);
  assert.equal(rotated, 'refresh-2');
  await c.me();
  assert.equal(exchanges, 2, 'cached until near expiry');
});
