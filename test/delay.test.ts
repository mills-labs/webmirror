import { describe, expect, it } from 'vitest';
import { pickDelayInRange } from '../src/utils/delay';

describe('pickDelayInRange', () => {
  it('always stays within [min, max]', () => {
    for (let i = 0; i < 500; i++) {
      const v = pickDelayInRange(500, 2000);
      expect(v).toBeGreaterThanOrEqual(500);
      expect(v).toBeLessThanOrEqual(2000);
    }
  });

  it('quantizes to 0.1s (100ms) steps from the minimum', () => {
    for (let i = 0; i < 500; i++) {
      const v = pickDelayInRange(500, 2000);
      expect((v - 500) % 100).toBe(0);
    }
  });

  it('covers more than one value across the range', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) seen.add(pickDelayInRange(0, 300));
    expect(seen.size).toBeGreaterThan(1);
  });

  it('returns exactly min when min equals max', () => {
    expect(pickDelayInRange(700, 700)).toBe(700);
  });

  it('clamps max below min to min', () => {
    expect(pickDelayInRange(1000, 200)).toBe(1000);
  });
});
