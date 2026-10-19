#!/usr/bin/env node
// Standalone simulator: `npm run sim -- --port 4100 --webhook http://localhost:3000/webhooks/ring --key secret`
import { parseArgs } from 'node:util';
import { SimClock } from './clock.ts';
import { startSimServer } from './server.ts';
import { SimWorld } from './world.ts';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '4100' },
    token: { type: 'string', default: 'sim-token' },
    webhook: { type: 'string' },
    key: { type: 'string', default: 'sim-signing-key' },
    speed: { type: 'string', default: '1' },
  },
});

const clock = new SimClock(Date.now(), Number(values.speed));
clock.start();
const world = new SimWorld({ clock, consentAt: Date.now() - 7 * 24 * 3600_000 });
const doorbell = world.addDevice({ name: 'Front Door', kind: 'doorbell', smartAlerts: true });
world.addDevice({ name: 'Hallway Chime', kind: 'chime' });
world.addDevice({ name: 'Front Door Contact', kind: 'contact_sensor', doorOpen: false, batteryPercent: 87 });
world.addDevice({ name: 'Living Room Climate', kind: 'temp_humidity', temperature: 22, humidity: 44, temperatureThreshold: { low: 16, high: 29 }, humidityThreshold: { low: 25, high: 70 } });
for (let d = 6; d >= 1; d--) world.recordHistory({ deviceId: doorbell.id, eventType: 'motion', subType: 'human', start: Date.now() - d * 24 * 3600_000, end: Date.now() - d * 24 * 3600_000 + 20_000 });
if (values.webhook) world.webhookTargets = [{ url: values.webhook, signingKey: values.key! }];

const running = await startSimServer({ world, token: values.token, port: Number(values.port) });
console.log(`Ring Partner API simulator on ${running.url}`);
console.log(`  token:   Bearer ${values.token}`);
console.log(`  try:     curl -H "Authorization: Bearer ${values.token}" "${running.url}/v1/devices?include=status,capabilities"`);
console.log(`  control: POST ${running.url}/sim/actions {"action":"ding","deviceId":"${doorbell.id}"}`);
if (values.webhook) console.log(`  webhooks -> ${values.webhook} (signed with --key)`);
