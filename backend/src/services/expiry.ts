import type pg from 'pg';
import type { Db } from '../db.js';

/**
 * Moves overdue pending orders to 'expired' and releases their active holds, in one
 * statement. Rows currently locked by another transaction (e.g. a payment being applied)
 * are skipped; whoever holds the lock handles expiry itself.
 *
 * Pass orderId to expire just that order (used lazily on reads, payments and pickups so
 * correctness never depends on the sweeper's timing).
 */
export async function expireDueOrders(db: Db, orderId: string | null = null): Promise<number> {
  const { rows } = await db.query<{ expired: number }>(
    `WITH due AS (
       SELECT id FROM orders
       WHERE status = 'pending_payment'
         AND expires_at <= now()
         AND ($1::uuid IS NULL OR id = $1::uuid)
       ORDER BY id
       LIMIT 500
       FOR UPDATE SKIP LOCKED
     ),
     expired AS (
       UPDATE orders o SET status = 'expired', updated_at = now()
       FROM due WHERE o.id = due.id
       RETURNING o.id
     ),
     released AS (
       UPDATE holds h SET status = 'released', released_at = now()
       FROM expired e
       WHERE h.order_id = e.id AND h.status = 'active'
       RETURNING h.id
     )
     SELECT (SELECT count(*) FROM expired)::int AS expired, (SELECT count(*) FROM released)::int AS released`,
    [orderId],
  );
  return rows[0]?.expired ?? 0;
}

/** Periodically expires overdue orders. Returns a stop function. */
export function startExpirySweeper(pool: pg.Pool, intervalMs: number): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const count = await expireDueOrders(pool);
      if (count > 0) console.log(`[expiry] expired ${count} order(s)`);
    } catch (err) {
      console.error('[expiry] sweep failed', err);
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
