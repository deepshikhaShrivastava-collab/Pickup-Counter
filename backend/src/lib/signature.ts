import { createHmac, timingSafeEqual } from 'node:crypto';

/** Hex HMAC-SHA256 of the exact bytes that are sent over the wire. */
export function signPayload(secret: string, rawBody: Buffer | string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * Verifies an X-Signature header against the raw request body. Accepts a bare hex digest or
 * "sha256=<hex>". Comparison is constant-time.
 */
export function verifySignature(
  secret: string,
  rawBody: Buffer,
  header: string | undefined,
): boolean {
  if (!header) return false;
  const provided = header.trim().replace(/^sha256=/i, '');
  if (!/^[0-9a-f]{64}$/i.test(provided)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(provided, 'hex'));
}
