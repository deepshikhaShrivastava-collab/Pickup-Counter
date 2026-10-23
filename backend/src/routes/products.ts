import { Router } from 'express';
import type pg from 'pg';
import { listProducts } from '../services/inventory.js';

export function productsRouter(pool: pg.Pool): Router {
  const router = Router();

  router.get('/products', async (_req, res) => {
    res.json({ products: await listProducts(pool) });
  });

  return router;
}
