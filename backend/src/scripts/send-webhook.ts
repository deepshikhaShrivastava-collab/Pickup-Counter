// Sends a signed payment webhook, exactly as a payment provider would.
//
//   npm run webhook -- --order <orderId>                 # pays the order's exact total
//   npm run webhook -- --order <orderId> --amount 100    # wrong amount -> needs_review
//   npm run webhook -- --order <orderId> --repeat 3      # same eventId 3x -> idempotent
//   npm run webhook -- --order <orderId> --bad-signature # expect 401
//
// Reads PAYMENT_WEBHOOK_SECRET from the environment (the npm script loads ../.env).
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { signPayload } from '../lib/signature.js';

const { values } = parseArgs({
  options: {
    order: { type: 'string' },
    amount: { type: 'string' },
    event: { type: 'string' },
    url: { type: 'string', default: process.env.API_URL ?? 'http://localhost:4000' },
    repeat: { type: 'string', default: '1' },
    'bad-signature': { type: 'boolean', default: false },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const secret = process.env.PAYMENT_WEBHOOK_SECRET;
if (!secret) fail('PAYMENT_WEBHOOK_SECRET is not set');
if (!values.order) fail('Usage: send-webhook --order <orderId> [--amount <paise>] [--event <id>] [--repeat <n>] [--bad-signature]');

const baseUrl = values.url!.replace(/\/$/, '');
const orderId = values.order;

let amountPaise: number;
if (values.amount !== undefined) {
  amountPaise = Number(values.amount);
  if (!Number.isInteger(amountPaise)) fail('--amount must be an integer number of paise');
} else {
  const res = await fetch(`${baseUrl}/api/orders/${orderId}`);
  if (!res.ok) fail(`Could not load order ${orderId}: HTTP ${res.status}`);
  const { order } = (await res.json()) as { order: { totalPaise: number } };
  amountPaise = order.totalPaise;
}

const body = JSON.stringify({ eventId: values.event ?? `evt_${randomUUID()}`, orderId, amountPaise });
const signature = values['bad-signature'] ? '0'.repeat(64) : signPayload(secret, body);

console.log(`POST ${baseUrl}/api/webhooks/payment`);
console.log(`body:        ${body}`);
console.log(`X-Signature: ${signature}`);

for (let i = 0; i < Number(values.repeat); i++) {
  const res = await fetch(`${baseUrl}/api/webhooks/payment`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signature': signature },
    body,
  });
  console.log(`#${i + 1} -> ${res.status} ${await res.text()}`);
}
