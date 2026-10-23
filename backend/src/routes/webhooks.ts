import express, { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { HttpError, UUID_RE } from '../errors.js';
import { verifySignature } from '../lib/signature.js';
import { processPaymentEvent } from '../services/payments.js';

const paymentEventSchema = z.object({
  eventId: z.string().min(1).max(200),
  orderId: z.string().regex(UUID_RE, 'orderId must be a UUID'),
  amountPaise: z.number().int().positive().max(2_147_483_647),
});

/**
 * Must be mounted before any JSON body parser: the signature is computed over the exact raw
 * bytes, so the body is read as a Buffer and only parsed after it has been verified.
 */
export function webhooksRouter(pool: pg.Pool, secret: string): Router {
  const router = Router();

  router.post(
    '/webhooks/payment',
    express.raw({ type: () => true, limit: '64kb' }),
    async (req, res) => {
      const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

      if (!verifySignature(secret, rawBody, req.get('x-signature'))) {
        throw new HttpError(401, 'invalid_signature', 'Missing or invalid X-Signature');
      }

      let payload: unknown;
      try {
        payload = JSON.parse(rawBody.toString('utf8'));
      } catch {
        throw new HttpError(400, 'invalid_json', 'Body is not valid JSON');
      }
      const event = paymentEventSchema.parse(payload);

      res.json(await processPaymentEvent(pool, event, payload));
    },
  );

  return router;
}
