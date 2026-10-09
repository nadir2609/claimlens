import { describe, expect, it } from 'vitest';
import { hitTest, toPixels } from './boxes';

describe('boxes', () => {
  it('scales fractional boxes to pixels', () => {
    expect(toPixels([0.25, 0.5, 0.5, 0.25], 800, 400)).toEqual({ x: 200, y: 200, w: 400, h: 100 });
  });

  it('hit-tests, preferring the smallest box under the pointer', () => {
    const boxes = [
      { id: 'big', rect: { x: 0, y: 0, w: 400, h: 400 } },
      { id: 'small', rect: { x: 100, y: 100, w: 50, h: 50 } },
    ];
    expect(hitTest(boxes, 120, 120)).toBe('small');
    expect(hitTest(boxes, 300, 300)).toBe('big');
    expect(hitTest(boxes, 500, 500)).toBeNull();
  });
});
