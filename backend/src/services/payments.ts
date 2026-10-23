import type pg from 'pg';
import { withTransaction } from '../db.js';
import { expireDueOrders } from './expiry.js';
import { lockProducts } from './inventory.js';
import type { OrderStatus } from './orders.js';

export interface PaymentEvent {
  eventId: string;
  orderId: string;
  amountPaise: number;
}

export type PaymentOutcome =
  | 'paid'
  | 'amount_mismatch'
  | 'late_payment_stock_reserved'
  | 'late_payment_refund_required'
  | 'order_not_payable'
  | 'unknown_order';

export interface PaymentResult {
  eventId: string;
  duplicate: boolean;
  outcome: string;
  orderStatus: OrderStatus | null;
}

/**
 * Applies a verified payment event exactly once per eventId.
 *
 * The event row is inserted first with ON CONFLICT DO NOTHING. A concurrent delivery of the
 * same eventId blocks on the primary-key index until this transaction commits, then inserts
 * nothing and is reported as a duplicate with the stored outcome. If this transaction rolls
 * back, the retry is processed normally.
 */
export async function processPaymentEvent(
  pool: pg.Pool,
  event: PaymentEvent,
  payload: unknown,
): Promise<PaymentResult> {
  return withTransaction(pool, async (client) => {
    const inserted = await client.query(
      `INSERT INTO payment_events (event_id, order_id, amount_paise, payload)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (event_id) DO NOTHING`,
      [event.eventId, event.orderId, event.amountPaise, JSON.stringify(payload)],
    );

    if (inserted.rowCount === 0) {
      const { rows } = await client.query<{ outcome: string; order_status: OrderStatus | null }>(
        `SELECT e.outcome, o.status AS order_status
         FROM payment_events e LEFT JOIN orders o ON o.id = e.order_id
         WHERE e.event_id = $1`,
        [event.eventId],
      );
      return {
        eventId: event.eventId,
        duplicate: true,
        outcome: rows[0]!.outcome,
        orderStatus: rows[0]!.order_status,
      };
    }

    const outcome = await applyPayment(client, event);
    await client.query('UPDATE payment_events SET outcome = $2 WHERE event_id = $1', [
      event.eventId,
      outcome,
    ]);
    const { rows } = await client.query<{ status: OrderStatus }>(
      'SELECT status FROM orders WHERE id = $1',
      [event.orderId],
    );
    return {
      eventId: event.eventId,
      duplicate: false,
      outcome,
      orderStatus: rows[0]?.status ?? null,
    };
  });
}

async function applyPayment(client: pg.PoolClient, event: PaymentEvent): Promise<PaymentOutcome> {
  // Lock the order row: serialises against the expiry sweeper, pickup claims and other events.
  const { rows } = await client.query<{
    status: OrderStatus;
    total_paise: number;
    past_expiry: boolean;
  }>(
    `SELECT status, total_paise, expires_at <= now() AS past_expiry
     FROM orders WHERE id = $1 FOR UPDATE`,
    [event.orderId],
  );
  const order = rows[0];
  if (!order) return 'unknown_order';

  let status = order.status;
  if (status === 'pending_payment' && order.past_expiry) {
    await expireDueOrders(client, event.orderId);
    status = 'expired';
  }

  const amountMatches = event.amountPaise === order.total_paise;

  if (status === 'pending_payment') {
    // On time: keep the stock reserved without a deadline until pickup or staff review.
    await client.query(
      `UPDATE holds SET status = 'committed', expires_at = NULL
       WHERE order_id = $1 AND status = 'active'`,
      [event.orderId],
    );
    if (amountMatches) {
      await client.query(
        `UPDATE orders SET status = 'paid', paid_at = now(), updated_at = now() WHERE id = $1`,
        [event.orderId],
      );
      return 'paid';
    }
    await setNeedsReview(client, event.orderId, 'amount_mismatch');
    return 'amount_mismatch';
  }

  if (status === 'expired') {
    return handleLatePayment(client, event.orderId, amountMatches);
  }

  // Already paid / under review / picked up: record the event, change nothing.
  return 'order_not_payable';
}

/**
 * Late payment policy: money arrived after the hold expired. The order is never silently
 * revived to 'paid'. It always goes to needs_review so a human decides. If the full amount
 * was paid and every item is still available, the stock is re-reserved so staff can choose
 * to fulfil; otherwise the order is flagged for a refund.
 */
async function handleLatePayment(
  client: pg.PoolClient,
  orderId: string,
  amountMatches: boolean,
): Promise<PaymentOutcome> {
  let outcome: PaymentOutcome = 'late_payment_refund_required';

  if (amountMatches) {
    const { rows: items } = await client.query<{ product_id: number; quantity: number }>(
      'SELECT product_id, quantity FROM order_items WHERE order_id = $1',
      [orderId],
    );
    const products = await lockProducts(
      client,
      items.map((i) => i.product_id),
    );
    const allAvailable = items.every(
      (i) => (products.get(i.product_id)?.available ?? 0) >= i.quantity,
    );
    if (allAvailable) {
      await client.query(
        `INSERT INTO holds (order_id, product_id, quantity, status, expires_at)
         SELECT order_id, product_id, quantity, 'committed', NULL
         FROM order_items WHERE order_id = $1`,
        [orderId],
      );
      outcome = 'late_payment_stock_reserved';
    }
  }

  await setNeedsReview(client, orderId, outcome);
  return outcome;
}

async function setNeedsReview(client: pg.PoolClient, orderId: string, reason: string) {
  await client.query(
    `UPDATE orders
     SET status = 'needs_review', review_reason = $2, paid_at = now(), updated_at = now()
     WHERE id = $1`,
    [orderId, reason],
  );
}
