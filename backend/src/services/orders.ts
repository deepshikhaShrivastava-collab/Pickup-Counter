import type pg from 'pg';
import { withTransaction, type Db } from '../db.js';
import { HttpError } from '../errors.js';
import { lockProducts } from './inventory.js';

export const ORDER_HOLD_SECONDS = 120;
const MAX_INT4 = 2_147_483_647;

export type OrderStatus = 'pending_payment' | 'paid' | 'needs_review' | 'expired' | 'picked_up';

export interface OrderItemView {
  productId: number;
  name: string;
  quantity: number;
  unitPricePaise: number;
  lineTotalPaise: number;
}

export interface OrderView {
  id: string;
  status: OrderStatus;
  totalPaise: number;
  expiresAt: string;
  /** Seconds left in the hold, measured by the database clock. Null unless pending_payment. */
  expiresInSeconds: number | null;
  reviewReason: string | null;
  createdAt: string;
  paidAt: string | null;
  pickedUpAt: string | null;
  items: OrderItemView[];
}

export interface OrderItemInput {
  productId: number;
  quantity: number;
}

/**
 * Creates an order and reserves its stock for ORDER_HOLD_SECONDS, atomically: either every
 * line is held or nothing is written.
 */
export async function createOrder(pool: pg.Pool, input: OrderItemInput[]): Promise<OrderView> {
  const wanted = new Map<number, number>();
  for (const { productId, quantity } of input) {
    wanted.set(productId, (wanted.get(productId) ?? 0) + quantity);
  }

  return withTransaction(pool, async (client) => {
    const products = await lockProducts(client, [...wanted.keys()]);

    const missing = [...wanted.keys()].filter((id) => !products.has(id));
    if (missing.length > 0) {
      throw new HttpError(404, 'product_not_found', 'One or more products do not exist', {
        productIds: missing,
      });
    }

    let totalPaise = 0;
    for (const [productId, quantity] of wanted) {
      const product = products.get(productId)!;
      if (quantity > product.available) {
        throw new HttpError(409, 'insufficient_stock', 'Not enough stock for this product', {
          productId,
          requested: quantity,
          available: Math.max(0, product.available),
        });
      }
      totalPaise += product.pricePaise * quantity;
    }
    if (totalPaise > MAX_INT4) {
      throw new HttpError(422, 'order_too_large', 'Order total is too large');
    }

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO orders (total_paise, expires_at)
       VALUES ($1, now() + make_interval(secs => $2))
       RETURNING id`,
      [totalPaise, ORDER_HOLD_SECONDS],
    );
    const orderId = rows[0]!.id;

    const ids = [...wanted.keys()];
    await client.query(
      `INSERT INTO order_items (order_id, product_id, quantity, unit_price_paise)
       SELECT $1, t.product_id, t.quantity, t.unit_price_paise
       FROM unnest($2::int[], $3::int[], $4::int[]) AS t(product_id, quantity, unit_price_paise)`,
      [orderId, ids, ids.map((id) => wanted.get(id)!), ids.map((id) => products.get(id)!.pricePaise)],
    );
    await client.query(
      `INSERT INTO holds (order_id, product_id, quantity, status, expires_at)
       SELECT i.order_id, i.product_id, i.quantity, 'active', o.expires_at
       FROM order_items i JOIN orders o ON o.id = i.order_id
       WHERE i.order_id = $1`,
      [orderId],
    );

    return (await getOrder(client, orderId))!;
  });
}

export async function getOrder(db: Db, orderId: string): Promise<OrderView | null> {
  const { rows } = await db.query(
    `SELECT o.id, o.status, o.total_paise, o.expires_at, o.review_reason,
            o.created_at, o.paid_at, o.picked_up_at,
            CASE WHEN o.status = 'pending_payment'
                 THEN GREATEST(0, CEIL(EXTRACT(EPOCH FROM (o.expires_at - now()))))::int
            END AS expires_in_seconds,
            COALESCE((
              SELECT json_agg(json_build_object(
                       'productId', i.product_id,
                       'name', p.name,
                       'quantity', i.quantity,
                       'unitPricePaise', i.unit_price_paise,
                       'lineTotalPaise', i.quantity * i.unit_price_paise
                     ) ORDER BY i.product_id)
              FROM order_items i JOIN products p ON p.id = i.product_id
              WHERE i.order_id = o.id
            ), '[]'::json) AS items
     FROM orders o
     WHERE o.id = $1`,
    [orderId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    status: r.status,
    totalPaise: r.total_paise,
    expiresAt: r.expires_at.toISOString(),
    expiresInSeconds: r.expires_in_seconds,
    reviewReason: r.review_reason,
    createdAt: r.created_at.toISOString(),
    paidAt: r.paid_at?.toISOString() ?? null,
    pickedUpAt: r.picked_up_at?.toISOString() ?? null,
    items: r.items,
  };
}
