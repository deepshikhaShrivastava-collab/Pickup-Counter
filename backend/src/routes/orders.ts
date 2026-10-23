import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { HttpError, UUID_RE } from '../errors.js';
import { expireDueOrders } from '../services/expiry.js';
import { createOrder, getOrder } from '../services/orders.js';
import { claimPickup } from '../services/pickup.js';

const createOrderSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.number().int().positive(),
        quantity: z.number().int().min(1).max(20),
      }),
    )
    .min(1)
    .max(20),
});

function orderIdParam(id: string | undefined): string {
  if (!id || !UUID_RE.test(id)) throw new HttpError(404, 'order_not_found', 'Order not found');
  return id;
}

export function ordersRouter(pool: pg.Pool): Router {
  const router = Router();

  router.post('/orders', async (req, res) => {
    const { items } = createOrderSchema.parse(req.body);
    res.status(201).json({ order: await createOrder(pool, items) });
  });

  router.get('/orders/:id', async (req, res) => {
    const id = orderIdParam(req.params.id);
    await expireDueOrders(pool, id);
    const order = await getOrder(pool, id);
    if (!order) throw new HttpError(404, 'order_not_found', 'Order not found');
    res.json({ order });
  });

  router.post('/orders/:id/pickup', async (req, res) => {
    const id = orderIdParam(req.params.id);
    res.json({ order: await claimPickup(pool, id) });
  });

  return router;
}
