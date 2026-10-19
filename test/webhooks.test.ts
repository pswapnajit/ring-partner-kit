import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  MemoryIdempotencyStore,
  computeSignature,
  eventFamily,
  handleWebhook,
  normalizeWebhook,
  parseWebhook,
  signatureHeader,
  verifySignature,
  WebhookError,
} from '../src/index.ts';

const KEY = 'test-signing-key';
const body = JSON.stringify({
  meta: { version: '1.1', time: '2026-02-13T13:39:57.200155525Z', request_id: 'req-1', account_id: 'ava1.ring.account.X' },
  data: {
    id: 'dev_motion_1786715596787',
    type: 'motion_detected',
    attributes: { source: 'ava1.ring.device.A', source_type: 'devices', timestamp: 1786715596787, sub_type: 'package_delivery', component_ids: ['0'] },
  },
});

test('signature is HMAC-SHA256 hex over the raw bytes', () => {
  const expected = createHmac('sha256', KEY).update(body).digest('hex');
  assert.equal(computeSignature(KEY, body), expected);
  assert.equal(signatureHeader(KEY, body), `sha256=${expected}`);
});

test('verifySignature accepts the documented header, with or without prefix', () => {
  const sig = computeSignature(KEY, body);
  assert.ok(verifySignature(KEY, body, `sha256=${sig}`));
  assert.ok(verifySignature(KEY, Buffer.from(body), sig));
  assert.ok(verifySignature(KEY, body, `SHA256=${sig.toUpperCase()}`));
});

test('verifySignature rejects tampering, wrong keys and garbage', () => {
  const header = signatureHeader(KEY, body);
  assert.equal(verifySignature(KEY, body.replace('package_delivery', 'human'), header), false);
  assert.equal(verifySignature('other-key', body, header), false);
  assert.equal(verifySignature(KEY, body, 'sha256=abc'), false);
  assert.equal(verifySignature(KEY, body, undefined), false);
  assert.equal(verifySignature('', body, header), false);
});

test('re-serialized JSON fails verification (the documented common mistake)', () => {
  const header = signatureHeader(KEY, body);
  const reserialized = JSON.stringify(JSON.parse(body), null, 2);
  assert.equal(verifySignature(KEY, reserialized, header), false);
});

test('parseWebhook rejects bodies that are not Ring webhooks', () => {
  assert.throws(() => parseWebhook('not json'), (e: unknown) => e instanceof WebhookError && e.httpStatus === 400);
  assert.throws(() => parseWebhook('{"meta":{}}'), WebhookError);
  assert.throws(() => parseWebhook(JSON.stringify({ meta: { request_id: 'x' }, data: { type: 't' } })), /attributes/);
});

test('normalizeWebhook reads source, sub_type and component_ids', () => {
  const e = normalizeWebhook(parseWebhook(body));
  assert.equal(e.deviceId, 'ava1.ring.device.A');
  assert.equal(e.subType, 'package_delivery');
  assert.deepEqual(e.componentIds, ['0']);
  assert.equal(e.family, 'camera');
  assert.equal(e.accountId, 'ava1.ring.account.X');
  assert.equal(e.timestamp, 1786715596787);
});

test('normalizeWebhook maps pm25_level to pm25 and keeps threshold direction', () => {
  const e = normalizeWebhook(
    parseWebhook(
      JSON.stringify({
        meta: { version: '1.1', time: '2026-03-10T14:22:20Z', request_id: 'r', account_id: 'a' },
        data: { id: 'x', type: 'pm25_exceeded', attributes: { source: 'd', source_type: 'devices', timestamp: 5, pm25_level: 551.2 } },
      }),
    ),
  );
  assert.equal(e.family, 'sensor');
  assert.deepEqual(e.reading, { pm25: 551.2 });
  const h = normalizeWebhook(
    parseWebhook(
      JSON.stringify({
        meta: { version: '1.1', time: 't', request_id: 'r2' },
        data: { id: 'y', type: 'humidity_exceeded', attributes: { source: 'd', timestamp: 6, humidity: 61.7, threshold_type: 'max' } },
      }),
    ),
  );
  assert.equal(h.thresholdType, 'max');
  assert.deepEqual(h.reading, { humidity: 61.7 });
});

test('motion without sub_type defaults to "motion"; unknown types pass through', () => {
  const m = normalizeWebhook(parseWebhook(JSON.stringify({ meta: { version: '1.1', time: 't', request_id: 'r' }, data: { id: 'i', type: 'motion_detected', attributes: { source: 'd', timestamp: 1 } } })));
  assert.equal(m.subType, 'motion');
  assert.equal(eventFamily('something_new'), 'unknown');
  assert.equal(eventFamily('button_press'), 'doorbell');
  assert.equal(eventFamily('device_offline'), 'connectivity');
});

test('handleWebhook: verify, dedupe on request_id, mark only after success', async () => {
  const store = new MemoryIdempotencyStore();
  const seen: string[] = [];
  let fail = true;
  const run = (signature: string) =>
    handleWebhook({
      signingKey: KEY,
      rawBody: body,
      signature,
      store,
      onEvent: (e) => {
        if (fail) throw new Error('database down');
        seen.push(e.id);
      },
    });

  const bad = await run('sha256=' + '0'.repeat(64));
  assert.equal(bad.status, 401);

  const failed = await run(signatureHeader(KEY, body));
  assert.equal(failed.status, 500, 'handler errors must be 5xx so Ring retries');
  assert.equal(store.has('req-1'), false, 'a failed delivery is not marked processed');

  fail = false;
  const ok = await run(signatureHeader(KEY, body));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'processed');

  const dup = await run(signatureHeader(KEY, body));
  assert.equal(dup.body.status, 'duplicate');
  assert.deepEqual(seen, ['dev_motion_1786715596787']);
});

test('MemoryIdempotencyStore is bounded', () => {
  const store = new MemoryIdempotencyStore(3);
  for (const k of ['a', 'b', 'c', 'd']) store.add(k);
  assert.equal(store.has('a'), false);
  assert.equal(store.has('d'), true);
});
