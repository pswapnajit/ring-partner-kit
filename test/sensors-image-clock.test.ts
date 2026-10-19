import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePng, describeThreshold, downscale, encodePng, guessDeviceKind, maskZones, pointInPolygon, readSensorStatus } from '../src/index.ts';
import { SimClock, renderScene, renderScenePng } from '../src/sim/index.ts';

const NOW = Date.parse('2026-10-20T12:00:00Z');

test('readSensorStatus treats the epoch as "never checked in"', () => {
  const r = readSensorStatus({ online: true, reported_at: '1970-01-01T00:00:00Z' }, { now: NOW });
  assert.equal(r.reportedAt, undefined);
  assert.equal(r.stale, true);
});

test('readSensorStatus gates everything on online', () => {
  const r = readSensorStatus({ online: false, contact_detection: { faulted: true }, battery_status: { percentage: 50 } }, { now: NOW });
  assert.equal(r.online, false);
  assert.equal(r.doorOpen, undefined);
  assert.equal(r.batteryPercent, undefined);
});

test('faulted:true means open; out-of-range battery (255) is no battery', () => {
  const door = readSensorStatus(
    { online: true, reported_at: new Date(NOW - 60_000).toISOString(), contact_detection: { faulted: true }, battery_status: { percentage: 85 } },
    { now: NOW, capabilities: { battery_status: { supported: true } } },
  );
  assert.equal(door.doorOpen, true);
  assert.equal(door.batteryPercent, 85);
  assert.equal(door.stale, false);
  const aq = readSensorStatus(
    { online: true, reported_at: new Date(NOW).toISOString(), battery_status: { percentage: 255 }, pm2_5: 3.5, co: 0, temperature: 24.2 },
    { now: NOW, capabilities: { battery_status: null } },
  );
  assert.equal(aq.batteryPercent, undefined);
  assert.equal(aq.pm25, 3.5);
  assert.equal(aq.temperatureC, 24.2);
});

test('describeThreshold recovers the crossed bound from configurations', () => {
  const cfg = { temperature_threshold: { high: 32.2, low: 25.0 } };
  assert.deepEqual(describeThreshold('temperature', 33, cfg, 'max'), { bound: 'high', limit: 32.2 });
  assert.deepEqual(describeThreshold('temperature', 20, cfg), { bound: 'low', limit: 25 });
  assert.deepEqual(describeThreshold('temperature', 28, cfg), {});
});

test('guessDeviceKind uses capabilities, never names', () => {
  assert.equal(guessDeviceKind({ audio: { customizable_slots: 2 } }), 'chime');
  assert.equal(guessDeviceKind({ video: { codecs: ['AVC'], max_resolution: 1080 } }), 'camera');
  assert.equal(guessDeviceKind({ video: null, battery_status: { supported: true } }, { online: true, contact_detection: { faulted: false } }), 'sensor');
});

test('PNG round-trips RGB and RGBA with text chunks', () => {
  const w = 7;
  const h = 5;
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([i * 7, 255 - i * 3, (i * 13) % 256, 200], i * 4);
  const rgba = decodePng(encodePng({ width: w, height: h, data }, { alpha: true, text: { hello: 'world' } }));
  assert.deepEqual([...rgba.data], [...data]);
  assert.equal(rgba.text.hello, 'world');
  const rgb = decodePng(encodePng({ width: w, height: h, data }));
  for (let i = 0; i < w * h; i++) {
    assert.deepEqual([...rgb.data.subarray(i * 4, i * 4 + 3)], [...data.subarray(i * 4, i * 4 + 3)]);
    assert.equal(rgb.data[i * 4 + 3], 255);
  }
});

test('maskZones blacks out exactly the privacy polygon', () => {
  const img = { width: 100, height: 50, data: new Uint8Array(100 * 50 * 4).fill(200) };
  const masked = maskZones(img, [{ id: 'z', vertices: [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0.5, y: 1 }, { x: 0, y: 1 }] }]);
  assert.equal(masked, 50 * 50);
  assert.equal(img.data[(10 * 100 + 10) * 4], 0);
  assert.equal(img.data[(10 * 100 + 80) * 4], 200);
  assert.ok(pointInPolygon(0.25, 0.5, [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0.5, y: 1 }, { x: 0, y: 1 }]));
  assert.equal(pointInPolygon(0.75, 0.5, [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0.5, y: 1 }, { x: 0, y: 1 }]), false);
});

test('scene renderer encodes ground truth and downscales', () => {
  const png = decodePng(renderScenePng({ objects: ['person', 'package'], hour: 2, width: 320, height: 180 }));
  assert.equal(png.text['sim:objects'], 'package,person');
  const small = downscale(renderScene({ objects: [], hour: 12, width: 640, height: 360 }), 320);
  assert.equal(small.width, 320);
  assert.equal(small.height, 180);
});

test('SimClock runs scheduled tasks in time order while advancing', async () => {
  const clock = new SimClock(0);
  clock.pause();
  const order: string[] = [];
  clock.at(30_000, () => void order.push('b'));
  clock.at(10_000, () => void order.push('a'));
  const cancel = clock.at(20_000, () => void order.push('cancelled'));
  cancel();
  await clock.advance(60_000, 5_000);
  assert.deepEqual(order, ['a', 'b']);
  assert.equal(clock.now(), 60_000);
});
