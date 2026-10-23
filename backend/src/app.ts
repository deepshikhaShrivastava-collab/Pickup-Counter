import express, { type ErrorRequestHandler } from 'express';
import type pg from 'pg';
import { ZodError } from 'zod';
import { HttpError } from './errors.js';
import { ordersRouter } from './routes/orders.js';
import { productsRouter } from './routes/products.js';
import { webhooksRouter } from './routes/webhooks.js';

export interface AppDeps {
  pool: pg.Pool;
  webhookSecret: string;
}

export function createApp({ pool, webhookSecret }: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');

  app.get('/api/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  });

  // Raw-body route first, before express.json() can consume the stream.
  app.use('/api', webhooksRouter(pool, webhookSecret));

  app.use(express.json({ limit: '32kb' }));
  app.use('/api', productsRouter(pool));
  app.use('/api', ordersRouter(pool));

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found', message: 'Route not found' });
  });

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.code, message: err.message, details: err.details });
      return;
    }
    if (err instanceof ZodError) {
      res.status(400).json({ error: 'invalid_request', message: 'Invalid request', details: { issues: err.issues } });
      return;
    }
    if (err?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'invalid_json', message: 'Body is not valid JSON' });
      return;
    }
    if (err?.type === 'entity.too.large') {
      res.status(413).json({ error: 'payload_too_large', message: 'Request body too large' });
      return;
    }
    console.error('[api] unhandled error', err);
    res.status(500).json({ error: 'internal_error', message: 'Something went wrong' });
  };
  app.use(errorHandler);

  return app;
}
