import { describe, expect, it } from 'vitest';
import { formatCountdown, remainingSeconds } from './countdown';
import { formatPaise } from './money';

describe('formatPaise', () => {
  it('formats integer paise without floating point', () => {
    expect(formatPaise(4000)).toBe('₹40');
    expect(formatPaise(4005)).toBe('₹40.05');
    expect(formatPaise(123456)).toBe('₹1,234.56');
    expect(formatPaise(10000000)).toBe('₹1,00,000');
    expect(formatPaise(0)).toBe('₹0');
  });
});

describe('countdown', () => {
  it('extrapolates from the server value and never goes negative', () => {
    expect(remainingSeconds(120, 1_000, 1_000)).toBe(120);
    expect(remainingSeconds(120, 1_000, 1_999)).toBe(120);
    expect(remainingSeconds(120, 1_000, 31_000)).toBe(90);
    expect(remainingSeconds(5, 0, 60_000)).toBe(0);
    expect(remainingSeconds(10, 5_000, 0)).toBe(10);
  });

  it('formats m:ss', () => {
    expect(formatCountdown(120)).toBe('2:00');
    expect(formatCountdown(61)).toBe('1:01');
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(-3)).toBe('0:00');
  });
});
