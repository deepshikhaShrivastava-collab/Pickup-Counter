import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  api,
  availability,
  createOrderFor,
  forceExpiry,
  paymentBody,
  payOrder,
  postWebhook,
  resetDatabase,
  setStock,
  startTestServer,
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

describe('simultaneous pickup claims', () => {
  it('lets exactly one of ten concurrent claims succeed and deducts stock once', async () => {
    const coffee = await setStock(ctx.pool, 'COFFEE-COLD', 2);
    const chai = await setStock(ctx.pool, 'CHAI-MASALA', 10);
    const order = await createOrderFor(ctx, [
      { productId: coffee, quantity: 2 },
      { productId: chai, quantity: 3 },
    ]);
    await payOrder(ctx, order);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => api(ctx, 'POST', `/api/orders/${order.id}/pickup`)),
    );

    const ok = results.filter((r) => r.status === 200);
    const conflicts = results.filter((r) => r.status === 409);
    expect(ok).toHaveLength(1);
    expect(conflicts).toHaveLength(9);
    expect(ok[0]!.body.order.status).toBe('picked_up');
    for (const r of conflicts) expect(r.body.error).toBe('already_picked_up');

    expect(await availability(ctx.pool, coffee)).toEqual({ stock_on_hand: 0, held: 0, available: 0 });
    expect(await availability(ctx.pool, chai)).toEqual({ stock_on_hand: 7, held: 0, available: 7 });
    const { rows } = await ctx.pool.query('SELECT DISTINCT status FROM holds WHERE order_id = $1', [order.id]);
    expect(rows).toEqual([{ status: 'consumed' }]);
  });

  it('keeps stock deducted permanently after pickup', async () => {
    const productId = await setStock(ctx.pool, 'SAMOSA-2', 3);
    const order = await createOrderFor(ctx, [{ productId, quantity: 1 }]);
    await payOrder(ctx, order);
    expect((await api(ctx, 'POST', `/api/orders/${order.id}/pickup`)).status).toBe(200);

    // Pushing the old deadline back does not resurrect the stock.
    await ctx.pool.query(`UPDATE orders SET expires_at = now() - interval '1 day' WHERE id = $1`, [order.id]);
    expect(await availability(ctx.pool, productId)).toEqual({ stock_on_hand: 2, held: 0, available: 2 });
  });
});

describe('pickup rejections', () => {
  it('rejects an unpaid order', async () => {
    const productId = await setStock(ctx.pool, 'CHAI-MASALA', 5);
    const order = await createOrderFor(ctx, [{ productId, quantity: 1 }]);

    const res = await api(ctx, 'POST', `/api/orders/${order.id}/pickup`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('order_not_paid');
    expect((await availability(ctx.pool, productId)).stock_on_hand).toBe(5);
  });

  it('rejects an expired order, even before the sweeper has run', async () => {
    const productId = await setStock(ctx.pool, 'CHAI-MASALA', 5);
    const order = await createOrderFor(ctx, [{ productId, quantity: 1 }]);
    await forceExpiry(ctx.pool, order.id);

    const res = await api(ctx, 'POST', `/api/orders/${order.id}/pickup`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('order_expired');
    expect(await availability(ctx.pool, productId)).toEqual({ stock_on_hand: 5, held: 0, available: 5 });
  });

  it('rejects an order under review', async () => {
    const productId = await setStock(ctx.pool, 'CHAI-MASALA', 5);
    const order = await createOrderFor(ctx, [{ productId, quantity: 1 }]);
    await postWebhook(ctx, paymentBody(order.id, order.totalPaise - 1));

    const res = await api(ctx, 'POST', `/api/orders/${order.id}/pickup`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('order_needs_review');
  });

  it('returns 404 for an unknown order', async () => {
    expect((await api(ctx, 'POST', `/api/orders/${randomUUID()}/pickup`)).status).toBe(404);
  });
});
