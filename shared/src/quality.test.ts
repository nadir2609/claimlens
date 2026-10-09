import { describe, expect, it } from 'vitest';
import { analysisDimensions, assessQuality, laplacianVariance, rgbaToGray } from './quality';

const flat = (w: number, h: number, v: number) => new Uint8Array(w * h).fill(v);
const checker = (w: number, h: number, lo: number, hi: number) => {
  const g = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = (x + y) % 2 ? hi : lo;
  return g;
};

describe('quality metric', () => {
  it('flags a featureless image as blurry', () => {
    const q = assessQuality(flat(64, 64, 128), 64, 64, 1200, 900);
    expect(q.sharpness).toBe(0);
    expect(q.issues).toEqual(['blurry']);
    expect(q.pass).toBe(false);
  });

  it('passes a sharp, well-lit, large image', () => {
    const q = assessQuality(checker(64, 64, 0, 255), 64, 64, 1200, 900);
    expect(q.pass).toBe(true);
    expect(q.issues).toEqual([]);
    expect(q.brightness).toBeCloseTo(127.5, 1);
  });

  it('flags dark and bright images', () => {
    expect(assessQuality(checker(64, 64, 0, 40), 64, 64, 1200, 900).issues).toEqual(['dark']);
    expect(assessQuality(checker(64, 64, 220, 255), 64, 64, 1200, 900).issues).toEqual(['bright']);
  });

  it('checks resolution on the original size in either orientation', () => {
    const g = checker(64, 64, 0, 255);
    expect(assessQuality(g, 64, 64, 640, 480).issues).toEqual(['low_resolution']);
    expect(assessQuality(g, 64, 64, 600, 800).pass).toBe(true);
    expect(assessQuality(g, 64, 64, 800, 599).issues).toEqual(['low_resolution']);
  });

  it('returns 0 sharpness for images too small to convolve', () => {
    expect(laplacianVariance(flat(2, 2, 9), 2, 2)).toBe(0);
  });

  it('scales the analysis size to a 512 px long side without enlarging', () => {
    expect(analysisDimensions(4000, 3000)).toEqual({ width: 512, height: 384 });
    expect(analysisDimensions(300, 200)).toEqual({ width: 300, height: 200 });
  });

  it('converts RGBA to luma', () => {
    expect(Array.from(rgbaToGray(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255])))).toEqual([255, 0]);
  });
});
