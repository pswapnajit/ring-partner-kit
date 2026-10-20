# ring-partner-kit

A typed, zero-dependency TypeScript toolkit for the [Ring Partner API](https://developer.amazon.com/docs/ring/api-documentation.html) (`api.amazonvision.com`): an API client, webhook verification, sensor and chime helpers, privacy-zone masking for snapshots, and a local Ring simulator that follows the documented contract.

It is the layer [Porchlight](https://github.com/pswapnajit/porchlight) runs on, released separately so other Ring developers can skip the first week of plumbing.

- **Zero dependencies.** Node 22.18+ (built-in `fetch`, `node:crypto` and TypeScript type stripping). No build step.
- **Follows the docs, including the awkward parts:** HMAC over the raw bytes, `links.next` on empty pages, the 303 for media, open-ended `sub_type`s, chime playback that must never be retried.
- **A local Ring** that serves the same REST shapes and sends signed webhooks, so the whole event-driven path can be tested without a device and without the Developer Playground (which has no webhook delivery).
- 28 tests, run with `node --test`.

## Install

```bash
git clone https://github.com/pswapnajit/ring-partner-kit
cd ring-partner-kit && npm test
```

Use it from another project with `npm install github:pswapnajit/ring-partner-kit`. It ships TypeScript sources, so run under Node 22.18+ or compile with your bundler.

## Quick start

```ts
import { RingClient } from 'ring-partner-kit';

// A Developer Playground token works as is. For production use RefreshTokenProvider.
const ring = new RingClient({ token: process.env.RING_ACCESS_TOKEN! });

// Discovery in one round trip (JSON:API compound document, resolved for you).
const devices = await ring.devices({ include: ['status', 'capabilities', 'configurations', 'location'] });

// Event History with composite filters. Pages until the data runs out, even though
// the API keeps sending links.next on empty pages.
for await (const e of ring.history(devices[0].id, { eventTypes: ['motion.package_delivery'] })) {
  console.log(e.attributes.event_type, new Date(e.attributes.start));
}
```

## Receive webhooks

Ring signs every webhook with HMAC-SHA256 over the raw request body (`X-Signature: sha256=<hex>`). `handleWebhook` verifies the signature in constant time before parsing, deduplicates on `meta.request_id`, and returns the status to answer with: 4xx for permanent problems (Ring stops retrying), 500 if your handler throws (Ring retries).

```ts
import { createServer } from 'node:http';
import { handleWebhook, MemoryIdempotencyStore } from 'ring-partner-kit';

const store = new MemoryIdempotencyStore();

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);   // keep the raw bytes: re-serialized JSON breaks the HMAC
  const result = await handleWebhook({
    signingKey: process.env.RING_HMAC_KEY!,
    rawBody: Buffer.concat(chunks),
    signature: req.headers['x-signature'] as string | undefined,
    store,
    onEvent: (event) => {
      // event.type: 'motion_detected' | 'button_press' | 'device_offline' | ... (open-ended)
      // event.subType: 'human' | 'package_delivery' | 'vehicle' | 'other_motion' | 'motion' | ...
      console.log(event.type, event.subType, event.deviceId);
    },
  });
  res.writeHead(result.status, { 'content-type': 'application/json' }).end(JSON.stringify(result.body));
}).listen(3000);
```

Lower-level pieces are exported too: `verifySignature`, `verifyAndParse`, `parseWebhook`, `normalizeWebhook` and `eventFamily`.

## Snapshots with privacy zones masked

```ts
import { decodePng, encodePng, maskZones } from 'ring-partner-kit';

const shot = await ring.snapshot(deviceId, {
  type: 'latest_in_range',
  start_timestamp: Date.now() - 3600_000,
  image_options: { format: 'png' },
});                                     // follows the 303 to the pre-signed URL
const config = await ring.configurations(deviceId);
if (config.e2e_encryption?.enabled) throw new Error('end-to-end encrypted: do not process');

const image = decodePng(shot.bytes);    // pure-TypeScript PNG codec, no native deps
maskZones(image, config.image_enhancements?.privacy_zones);   // black out what the user hid in the Ring app
const safe = encodePng(image);          // only this copy should reach a model or a person
```

`downscale(image, maxSide)` is available for keeping only a small copy.

## A local Ring

```ts
import { RingClient } from 'ring-partner-kit';
import { SimClock, SimWorld, startSimServer } from 'ring-partner-kit/sim';

const clock = new SimClock(Date.now(), 1);        // speed it up for scripted days
clock.start();
const world = new SimWorld({ clock, consentAt: Date.now() - 7 * 24 * 3600_000 });
const door = world.addDevice({ name: 'Front Door', kind: 'doorbell', smartAlerts: true });
world.webhookTargets = [{ url: 'http://127.0.0.1:3000/', signingKey: 'sim-signing-key' }];

const sim = await startSimServer({ world });        // token "sim-token"
const ring = new RingClient({ token: 'sim-token', baseUrl: sim.url });

world.place(door.id, 'package', clock.now());       // shows up in snapshots
await world.motion(door.id, 'package_delivery');    // signed webhook + Event History entry
```

The simulator covers devices with `include=`, status, capabilities, configurations (privacy zones, e2e, chime slots), Event History with composite filters and `page[key]`, rendered PNG snapshots with the documented 303 and media headers, chime playback, WHEP, door and climate sensors, online and offline transitions, and HMAC-signed webhooks. It does not record video clips: clip requests answer 416. A standalone server is also available:

```bash
npm run sim -- --port 4100 --webhook http://localhost:3000/webhooks/ring --key sim-signing-key
```

## Also included

| Area | Exports |
|---|---|
| Auth | `StaticTokenProvider`; `RefreshTokenProvider` (refresh-token flow; caches the access token and shares one in-flight refresh; `onRotate` lets you persist the rotated refresh token) |
| Errors | `RingApiError` (`status`, `code`, `detail`, `retryable`, `retryAfterMs`, `unauthorized`), `parseRetryAfter`, `backoffDelay`. Safe requests retry 429 and 5xx; side-effecting ones never do. |
| Media | `snapshot`, `clip`, `startLiveView` / `stopLiveView` (WHEP) |
| Chimes | `isChime`, `chimeSlots`, `findSlot`, `checkChime`, `playChimeSlot` (checks online state, snooze and the enabled slot first; never retried) |
| Sensors | `readSensorStatus`, `describeThreshold`, `guessDeviceKind` (Ring has no device-type field) |
| JSON:API | `indexIncluded`, `resolveOne`, `resolveMany`, `nextPageKey` |
| Logging | `onRequest` gets one line per HTTP exchange (method, path, status, duration, attempt, request ID) and never the token |

## Notes from building on the API

- **Webhooks:** verify `X-Signature` over the raw body. The official hello-world sample checks a Bearer token instead, which either accepts anything or rejects Ring's real traffic.
- **Event History has no `sub_type`.** To classify history, query once per subtype filter (`motion.human`, `motion.package_delivery`, …) and tag events by the filter that returned them.
- **`links.next` is returned even on empty pages.** `history()` stops on an empty page or a repeated cursor, and caps pages (`maxPages`, default 20).
- **Treat `sub_type` and event types as open-ended.** They are typed as known values plus `string`.
- **Never retry chime playback.** A retry is a second sound in someone's home.
- **Server-to-server only.** Ring blocks browser requests with CORS, so never ship a token to a web page.

## License

MIT © Swapnajit Patra
