import { describe, it, expect } from 'vitest';
import { scoreBand } from '../src/lib/score-band.js';

describe('scoreBand', () => {
  it('returns mid for a mid score', () => {
    expect(scoreBand(50)).toBe('mid');
  });
});
