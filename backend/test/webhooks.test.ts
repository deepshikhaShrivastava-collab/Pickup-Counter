import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signPayload } from '../src/lib/signature.js';
import {
  api,
  availability,
  createOrderFor,
  forceExpiry,
  paymentBody,
  postWebhook,
  resetDatabase,
  setStock,
  startTestServer,
  TEST_WEBHOOK_SECRET,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await startTestServer();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await resetDatabase(ctx.pool);
});

async function orderStatus(orderId: string) {
  const { rows } = await ctx.pool.query('SELECT status, review_reason FROM orders WHERE id = $1', [orderId]);
  return rows[0];
}

async function eventCount() {
  const { rows } = await ctx.pool.query('SELECT count(*)::int AS n FROM payment_events');
  return rows[0].n as number;
}

describe('webhook signature verification', () => {
  it('rejects missing, malformed, wrong-secret and tampered signatures without side effects', async () => {
    const productId = await setStock(ctx.pool, 'CHAI-MASALA', 5);
    const order = await createOrderFor(ctx, [{ productId, quantity: 1 }]);
    const body = paymentBody(order.id, order.totalPaise);

    expect((await postWebhook(ctx, body, null)).status).toBe(401);
    expect((await postWebhook(ctx, body, 'not-hex')).status).toBe(401);
    expect((await postWebhook(ctx, body, signPayload('some-other-secret-value', body))).status).toBe(401);

    const tampered = body.replace(String(order.totalPaise), '1');
    expect((await postWebhook(ctx, tampered, signPayload(TEST_WEBHOOK_SECRET, body))).status).toBe(401);

    expect(await eventCount()).toBe(0);
    expect((await orderStatus(order.id)).status).toBe('pending_payment');
  });

  it('verifies the raw bytes, not re-serialised JSON', async () => {
    const productId = await setStock(ctx.pool, 'CHAI-MASALA', 5);
    const order = await createOrderFor(ctx, [{ productId, quantity: 1 }]);
    // Unusual whitespace and key order: re-serialising would change the bytes and the HMAC.
    const raw = `{\n  "amountPaise" : ${order.totalPaise},\n  "orderId":"${order.id}",  "eventId":"evt_raw_1", "status":"captured"\n}`;

    const res = await postWebhook(ctx, raw);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: 'paid', duplicate: false });

    const prefixed = await postWebhook(ctx, raw, `sha256=${signPayload(TEST_WEBHOOK_SECRET, raw)}`);
    expect(prefixed.body.duplicate).toBe(true);
  });

  it('returns 400 for a correctly signed but invalid payload', async () => {
    const body = JSON.stringify({ eventId: 'evt_x', orderId: 'nope', amountPaise: 10, status: 'captured' });
    expect((await postWebhook(ctx, body)).status).toBe(400);
    const noStatus = JSON.stringify({ eventId: 'evt_y', orderId: randomUUID(), amountPaise: 10 });
    expect((await postWebhook(ctx, noStatus)).status).toBe(400);
    expect((await postWebhook(ctx, '{not json')).status).toBe(400);
    expect(await eventCount()).toBe(0);
  });
});

describe('payment status', () => {
  it('records a non-captured event without paying the order', async () => {
    const productId = await setStock(ctx.pool, 'CHAI-MASALA', 5);
    const order = await createOrderFor(ctx, [{ productId, quantity: 1 }]);

    const failed = await postWebhook(ctx, paymentBody(order.id, order.totalPaise, 'evt_failed_1', 'failed'));
    expect(failed.status).toBe(200);
    expect(failed.body).toMatchObject({ outcome: 'ignored_not_captured', orderStatus: 'pending_payment' });
    expect(await availability(ctx.pool, productId)).toMatchObject({ held: 1, available: 4 });

    // A later capture for the same order still works normally.
    const captured = await postWebhook(ctx, paymentBody(order.id, order.totalPaise, 'evt_captured_1'));
    expect(captured.body).toMatchObject({ outcome: 'paid', orderStatus: 'paid' });
    expect(await eventCount()).toBe(2);
  });
});

describe('payment processing', () => {
  it('marks a correctly paid order as paid and keeps its stock committed', async () => {
    const productId = await setStock(ctx.pool, 'COFFEE-COLD', 2);
    const order = await createOrderFor(ctx, [{ productId, quantity: 2 }]);

    const res = await postWebhook(ctx, paymentBody(order.id, order.totalPaise));
    expect(res.body).toMatchObject({ duplicate: false, outcome: 'paid', orderStatus: 'paid' });

    const fetched = await api(ctx, 'GET', `/orders/${order.id}`);
    expect(fetched.body.order).toMatchObject({ status: 'paid', expiresInSeconds: null });

    // Even past the original deadline, paid stock stays reserved.
    await ctx.pool.query(`UPDATE orders SET expires_at = now() - interval '1 hour' WHERE id = $1`, [order.id]);
    expect(await availability(ctx.pool, productId)).toEqual({ stock_on_hand: 2, held: 2, available: 0 });
  });

  it('processes ten simultaneous deliveries of the same event exactly once', async () => {
    const productId = await setStock(ctx.pool, 'SANDWICH-VEG', 3);
    const order = await createOrderFor(ctx, [{ productId, quantity: 1 }]);
    const body = paymentBody(order.id, order.totalPaise, 'evt_duplicate_storm');

    const results = await Promise.all(Array.from({ length: 10 }, () => postWebhook(ctx, body)));

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.duplicate === false)).toHaveLength(1);
    expect(results.filter((r) => r.body.duplicate === true)).toHaveLength(9);
    for (const r of results) expect(r.body).toMatchObject({ outcome: 'paid', orderStatus: 'paid' });

    expect(await eventCount()).toBe(1);
    const { rows } = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM holds WHERE order_id = $1 AND status = 'committed'`,
      [order.id],
    );
    expect(rows[0].n).toBe(1);
  });

  it('replays a duplicate with the stored outcome even after the order changed', async () => {
    const productId = await setStock(ctx.pool, 'SAMOSA-2', 5);
    const order = await createOrderFor(ctx, [{ productId, quantity: 1 }]);
    const body = paymentBody(order.id, order.totalPaise - 1, 'evt_short');

    const first = await postWebhook(ctx, body);
    expect(first.body).toMatchObject({ outcome: 'amount_mismatch', orderStatus: 'needs_review' });
    const replay = await postWebhook(ctx, body);
    expect(replay.body).toMatchObject({ duplicate: true, outcome: 'amount_mismatch' });
    expect(await eventCount()).toBe(1);
  });

  it('sends mismatched amounts to needs_review', async () => {
    const productId = await setStock(ctx.pool, 'WRAP-PANEER', 3);
    const order = await createOrderFor(ctx, [{ productId, quantity: 1 }]);

    const res = await postWebhook(ctx, paymentBody(order.id, order.totalPaise + 100));
    expect(res.body).toMatchObject({ outcome: 'amount_mismatch', orderStatus: 'needs_review' });
    expect(await orderStatus(order.id)).toEqual({ status: 'needs_review', review_reason: 'amount_mismatch' });
  });

  it('ignores a second, different payment for an already paid order', async () => {
    const productId = await setStock(ctx.pool, 'CHAI-MASALA', 5);
    const order = await createOrderFor(ctx, [{ productId, quantity: 1 }]);
    await postWebhook(ctx, paymentBody(order.id, order.totalPaise));

    const second = await postWebhook(ctx, paymentBody(order.id, order.totalPaise));
    expect(second.body).toMatchObject({ duplicate: false, outcome: 'order_not_payable', orderStatus: 'paid' });
    expect(await eventCount()).toBe(2);
  });

  it('records events for unknown orders without failing', async () => {
    const res = await postWebhook(ctx, paymentBody(randomUUID(), 1000));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: 'unknown_order', orderStatus: null });
  });
});

describe('late payments after expiry', () => {
  it('re-reserves stock and flags for review when the full amount arrives late and stock remains', async () => {
    const productId = await setStock(ctx.pool, 'COFFEE-COLD', 2);
    const order = await createOrderFor(ctx, [{ productId, quantity: 2 }]);
    await forceExpiry(ctx.pool, order.id);

    const res = await postWebhook(ctx, paymentBody(order.id, order.totalPaise));
    expect(res.body).toMatchObject({ outcome: 'late_payment_stock_reserved', orderStatus: 'needs_review' });
    expect(await availability(ctx.pool, productId)).toMatchObject({ held: 2, available: 0 });

    const pickup = await api(ctx, 'POST', `/orders/${order.id}/pickup-claim`);
    expect(pickup.status).toBe(409);
  });

  it('flags a refund when the stock was sold to someone else meanwhile', async () => {
    const productId = await setStock(ctx.pool, 'COFFEE-COLD', 2);
    const order = await createOrderFor(ctx, [{ productId, quantity: 2 }]);
    await forceExpiry(ctx.pool, order.id);
    await createOrderFor(ctx, [{ productId, quantity: 2 }]);

    const res = await postWebhook(ctx, paymentBody(order.id, order.totalPaise));
    expect(res.body).toMatchObject({ outcome: 'late_payment_refund_required', orderStatus: 'needs_review' });
    expect(await availability(ctx.pool, productId)).toMatchObject({ held: 2, available: 0 });
  });
});
