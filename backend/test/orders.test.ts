import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expireDueOrders } from '../src/services/expiry.js';
import {
  api,
  availability,
  createOrderFor,
  forceExpiry,
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

describe('concurrent orders for the last two units', () => {
  it('lets exactly two of ten simultaneous single-unit orders succeed', async () => {
    const productId = await setStock(ctx.pool, 'COFFEE-COLD', 2);

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        api(ctx, 'POST', '/api/orders', { items: [{ productId, quantity: 1 }] }),
      ),
    );

    const created = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status === 409);
    expect(created).toHaveLength(2);
    expect(rejected).toHaveLength(8);
    for (const r of rejected) expect(r.body.error).toBe('insufficient_stock');

    expect(await availability(ctx.pool, productId)).toEqual({ stock_on_hand: 2, held: 2, available: 0 });
    const { rows } = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM orders WHERE status = 'pending_payment'`,
    );
    expect(rows[0].n).toBe(2);
  });

  it('never oversells when a two-unit order races single-unit orders', async () => {
    const productId = await setStock(ctx.pool, 'COFFEE-COLD', 2);

    const requests = [2, 1, 1, 1, 1, 1].map((quantity) =>
      api(ctx, 'POST', '/api/orders', { items: [{ productId, quantity }] }),
    );
    const results = await Promise.all(requests);

    const reserved = results
      .filter((r) => r.status === 201)
      .reduce((sum, r) => sum + r.body.order.items[0].quantity, 0);
    expect(reserved).toBe(2);
    expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    expect((await availability(ctx.pool, productId)).available).toBe(0);
  });

  it('reserves multi-product orders all-or-nothing', async () => {
    const coffee = await setStock(ctx.pool, 'COFFEE-COLD', 1);
    const chai = await setStock(ctx.pool, 'CHAI-MASALA', 10);

    const res = await api(ctx, 'POST', '/api/orders', {
      items: [
        { productId: chai, quantity: 3 },
        { productId: coffee, quantity: 2 },
      ],
    });
    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({ productId: coffee, requested: 2, available: 1 });
    expect((await availability(ctx.pool, chai)).available).toBe(10);
  });
});

describe('order holds', () => {
  it('returns a server-measured expiresInSeconds and integer paise totals', async () => {
    const productId = await setStock(ctx.pool, 'SAMOSA-2', 5);
    const order = await createOrderFor(ctx, [{ productId, quantity: 2 }]);

    expect(order.status).toBe('pending_payment');
    expect(order.totalPaise).toBe(6000);
    expect(order.expiresInSeconds).toBe(120);

    const fetched = await api(ctx, 'GET', `/api/orders/${order.id}`);
    expect(fetched.body.order.expiresInSeconds).toBeGreaterThanOrEqual(118);
    expect(fetched.body.order.expiresInSeconds).toBeLessThanOrEqual(120);

    const products = await api(ctx, 'GET', '/api/products');
    const samosa = products.body.products.find((p: { id: number }) => p.id === productId);
    expect(samosa).toMatchObject({ stockOnHand: 5, available: 3, pricePaise: 3000 });
  });

  it('stops counting a hold as soon as it passes expiry, then expires the order on read', async () => {
    const productId = await setStock(ctx.pool, 'COFFEE-COLD', 2);
    const order = await createOrderFor(ctx, [{ productId, quantity: 2 }]);
    expect((await availability(ctx.pool, productId)).available).toBe(0);

    await forceExpiry(ctx.pool, order.id);
    // No sweeper has run, yet the stock is already available again.
    expect((await availability(ctx.pool, productId)).available).toBe(2);

    const fetched = await api(ctx, 'GET', `/api/orders/${order.id}`);
    expect(fetched.body.order).toMatchObject({ status: 'expired', expiresInSeconds: null });
    const { rows } = await ctx.pool.query('SELECT status FROM holds WHERE order_id = $1', [order.id]);
    expect(rows.map((r) => r.status)).toEqual(['released']);

    const again = await api(ctx, 'POST', '/api/orders', { items: [{ productId, quantity: 2 }] });
    expect(again.status).toBe(201);
  });

  it('sweeper expires only overdue pending orders', async () => {
    const productId = await setStock(ctx.pool, 'CHAI-MASALA', 10);
    const overdue = await createOrderFor(ctx, [{ productId, quantity: 1 }]);
    const fresh = await createOrderFor(ctx, [{ productId, quantity: 1 }]);
    await forceExpiry(ctx.pool, overdue.id);

    expect(await expireDueOrders(ctx.pool)).toBe(1);
    expect(await expireDueOrders(ctx.pool)).toBe(0);

    const { rows } = await ctx.pool.query('SELECT id, status FROM orders ORDER BY created_at');
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.status]));
    expect(byId[overdue.id]).toBe('expired');
    expect(byId[fresh.id]).toBe('pending_payment');
  });
});

describe('order validation', () => {
  it('rejects bad payloads and unknown products', async () => {
    expect((await api(ctx, 'POST', '/api/orders', { items: [] })).status).toBe(400);
    expect((await api(ctx, 'POST', '/api/orders', { items: [{ productId: 1, quantity: 0 }] })).status).toBe(400);
    expect((await api(ctx, 'POST', '/api/orders', { items: [{ productId: 1, quantity: 1.5 }] })).status).toBe(400);
    const unknown = await api(ctx, 'POST', '/api/orders', { items: [{ productId: 999, quantity: 1 }] });
    expect(unknown.status).toBe(404);
    expect((await api(ctx, 'GET', '/api/orders/not-a-uuid')).status).toBe(404);
  });
});
