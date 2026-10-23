import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { createApp } from '../src/app.js';
import { createPool } from '../src/db.js';
import { seed } from '../src/db/migrate.js';
import { signPayload } from '../src/lib/signature.js';

export const TEST_WEBHOOK_SECRET = 'test-only-webhook-secret-not-used-anywhere-else';

export interface TestContext {
  pool: pg.Pool;
  baseUrl: string;
  close: () => Promise<void>;
}

/** Real HTTP server on an ephemeral port, backed by a real Postgres pool. */
export async function startTestServer(): Promise<TestContext> {
  const pool = createPool(process.env.TEST_DATABASE_URL!, 30);
  const app = createApp({ pool, webhookSecret: TEST_WEBHOOK_SECRET });
  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    pool,
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await pool.end();
    },
  };
}

export async function resetDatabase(pool: pg.Pool): Promise<void> {
  await pool.query(
    'TRUNCATE payment_events, holds, order_items, orders, products RESTART IDENTITY CASCADE',
  );
  await seed(pool);
}

/** Sets a seeded product's shelf stock and returns its id. */
export async function setStock(pool: pg.Pool, sku: string, stock: number): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    'UPDATE products SET stock_on_hand = $2 WHERE sku = $1 RETURNING id',
    [sku, stock],
  );
  if (!rows[0]) throw new Error(`No product with sku ${sku}`);
  return rows[0].id;
}

export interface ApiResponse {
  status: number;
  body: any;
}

export async function api(
  ctx: TestContext,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResponse> {
  const res = await fetch(ctx.baseUrl + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** POSTs a raw string to the webhook endpoint, signed with the test secret unless overridden. */
export async function postWebhook(
  ctx: TestContext,
  rawBody: string,
  signature: string | null = signPayload(TEST_WEBHOOK_SECRET, rawBody),
): Promise<ApiResponse> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (signature !== null) headers['x-signature'] = signature;
  const res = await fetch(`${ctx.baseUrl}/api/webhooks/payment`, {
    method: 'POST',
    headers,
    body: rawBody,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

export function paymentBody(orderId: string, amountPaise: number, eventId = `evt_${randomUUID()}`) {
  return JSON.stringify({ eventId, orderId, amountPaise });
}

export async function createOrderFor(
  ctx: TestContext,
  items: { productId: number; quantity: number }[],
) {
  const res = await api(ctx, 'POST', '/api/orders', { items });
  if (res.status !== 201) throw new Error(`order failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order as { id: string; totalPaise: number; expiresInSeconds: number; status: string };
}

export async function payOrder(ctx: TestContext, order: { id: string; totalPaise: number }) {
  const res = await postWebhook(ctx, paymentBody(order.id, order.totalPaise));
  if (res.body?.outcome !== 'paid') throw new Error(`payment failed: ${JSON.stringify(res.body)}`);
}

/** Moves an order's hold deadline into the past, simulating 120s passing. */
export async function forceExpiry(pool: pg.Pool, orderId: string): Promise<void> {
  await pool.query(`UPDATE orders SET expires_at = now() - interval '1 second' WHERE id = $1`, [orderId]);
  await pool.query(
    `UPDATE holds SET expires_at = now() - interval '1 second' WHERE order_id = $1 AND status = 'active'`,
    [orderId],
  );
}

export async function availability(pool: pg.Pool, productId: number) {
  const { rows } = await pool.query<{ stock_on_hand: number; held: number; available: number }>(
    'SELECT stock_on_hand, held, available FROM product_availability WHERE product_id = $1',
    [productId],
  );
  return rows[0]!;
}
