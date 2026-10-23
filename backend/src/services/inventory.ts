import type pg from 'pg';
import type { Db } from '../db.js';

export interface ProductView {
  id: number;
  sku: string;
  name: string;
  description: string;
  pricePaise: number;
  stockOnHand: number;
  available: number;
}

export async function listProducts(db: Db): Promise<ProductView[]> {
  const { rows } = await db.query(`
    SELECT p.id, p.sku, p.name, p.description, p.price_paise, p.stock_on_hand, a.available
    FROM products p
    JOIN product_availability a ON a.product_id = p.id
    ORDER BY p.id`);
  return rows.map((r) => ({
    id: r.id,
    sku: r.sku,
    name: r.name,
    description: r.description,
    pricePaise: r.price_paise,
    stockOnHand: r.stock_on_hand,
    available: Math.max(0, r.available),
  }));
}

export interface LockedProduct {
  id: number;
  pricePaise: number;
  available: number;
}

/**
 * Row-locks the given products in ascending id order (so concurrent callers can never
 * deadlock against each other) and returns their availability as seen *after* the locks
 * are held. Under READ COMMITTED each statement takes a fresh snapshot, so the second
 * query sees every hold committed by whoever held the lock before us.
 *
 * Every code path that adds holds must call this first; that is what serialises
 * reservations per product.
 */
export async function lockProducts(
  client: pg.PoolClient,
  productIds: number[],
): Promise<Map<number, LockedProduct>> {
  const ids = [...new Set(productIds)].sort((a, b) => a - b);
  const { rows: locked } = await client.query<{ id: number; price_paise: number }>(
    'SELECT id, price_paise FROM products WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE',
    [ids],
  );
  const { rows: availability } = await client.query<{ product_id: number; available: number }>(
    'SELECT product_id, available FROM product_availability WHERE product_id = ANY($1::int[])',
    [ids],
  );
  const availableById = new Map(availability.map((r) => [r.product_id, r.available]));
  return new Map(
    locked.map((p) => [
      p.id,
      { id: p.id, pricePaise: p.price_paise, available: availableById.get(p.id) ?? 0 },
    ]),
  );
}
