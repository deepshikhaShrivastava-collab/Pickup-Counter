import type pg from 'pg';
import { withTransaction } from '../db.js';
import { HttpError } from '../errors.js';
import { expireDueOrders } from './expiry.js';
import { getOrder, type OrderStatus, type OrderView } from './orders.js';

const REJECTIONS: Record<Exclude<OrderStatus, 'paid'>, [code: string, message: string]> = {
  pending_payment: ['order_not_paid', 'Order has not been paid'],
  expired: ['order_expired', 'Order expired before payment'],
  needs_review: ['order_needs_review', 'Order is waiting for staff review'],
  picked_up: ['already_picked_up', 'Order has already been picked up'],
};

/**
 * Hands over a paid order. The conditional UPDATE is the claim: concurrent claimers queue on
 * the row lock, and once the winner commits the others re-check `status = 'paid'`, match
 * nothing and are rejected. Stock is permanently deducted in the same transaction.
 */
export async function claimPickup(pool: pg.Pool, orderId: string): Promise<OrderView> {
  return withTransaction(pool, async (client) => {
    await expireDueOrders(client, orderId);

    const claimed = await client.query(
      `UPDATE orders SET status = 'picked_up', picked_up_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'paid'
       RETURNING id`,
      [orderId],
    );

    if (claimed.rowCount === 0) {
      const { rows } = await client.query<{ status: OrderStatus }>(
        'SELECT status FROM orders WHERE id = $1',
        [orderId],
      );
      const status = rows[0]?.status;
      if (!status) throw new HttpError(404, 'order_not_found', 'Order not found');
      const [code, message] = REJECTIONS[status as Exclude<OrderStatus, 'paid'>];
      throw new HttpError(409, code, message, { status });
    }

    // Lock product rows in id order, the same order order-creation uses, to avoid deadlocks.
    await client.query(
      `SELECT id FROM products
       WHERE id IN (SELECT product_id FROM holds WHERE order_id = $1 AND status = 'committed')
       ORDER BY id FOR UPDATE`,
      [orderId],
    );
    await client.query(
      `UPDATE products p SET stock_on_hand = p.stock_on_hand - h.quantity
       FROM holds h
       WHERE h.order_id = $1 AND h.status = 'committed' AND h.product_id = p.id`,
      [orderId],
    );
    await client.query(
      `UPDATE holds SET status = 'consumed', released_at = now()
       WHERE order_id = $1 AND status = 'committed'`,
      [orderId],
    );

    return (await getOrder(client, orderId))!;
  });
}
