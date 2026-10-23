import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signPayload, verifySignature } from '../../src/lib/signature.js';

const secret = 'unit-test-secret-0123456789';
const body = Buffer.from('{"eventId":"e1","orderId":"o1","amountPaise":4000}');

describe('webhook signatures', () => {
  it('produces a standard hex HMAC-SHA256', () => {
    expect(signPayload(secret, body)).toBe(createHmac('sha256', secret).update(body).digest('hex'));
  });

  it('accepts a valid signature, bare or sha256= prefixed, in any case', () => {
    const sig = signPayload(secret, body);
    expect(verifySignature(secret, body, sig)).toBe(true);
    expect(verifySignature(secret, body, `sha256=${sig}`)).toBe(true);
    expect(verifySignature(secret, body, sig.toUpperCase())).toBe(true);
  });

  it('rejects missing, malformed, wrong-length and wrong signatures', () => {
    const sig = signPayload(secret, body);
    expect(verifySignature(secret, body, undefined)).toBe(false);
    expect(verifySignature(secret, body, '')).toBe(false);
    expect(verifySignature(secret, body, 'zz' + sig.slice(2))).toBe(false);
    expect(verifySignature(secret, body, sig.slice(0, 62))).toBe(false);
    expect(verifySignature('another-secret-entirely', body, sig)).toBe(false);
    expect(verifySignature(secret, Buffer.from(body.toString() + ' '), sig)).toBe(false);
  });
});
