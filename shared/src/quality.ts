import type { QualityIssue, QualityResult } from './types';

export const QUALITY = {
  analysisSize: 512,
  minSharpness: 60,
  minBrightness: 50,
  maxBrightness: 215,
  minLongSide: 800,
  minShortSide: 600,
} as const;

export const QUALITY_MESSAGES: Record<QualityIssue, string> = {
  blurry: 'Too blurry',
  dark: 'Too dark',
  bright: 'Too bright',
  low_resolution: 'Resolution too low',
};

export function analysisDimensions(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, QUALITY.analysisSize / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function rgbaToGray(rgba: Uint8ClampedArray | Uint8Array): Uint8Array {
  const gray = new Uint8Array(rgba.length / 4);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
    gray[j] = Math.round(0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]);
  }
  return gray;
}

/** Variance of the 4-neighbour Laplacian over interior pixels. */
export function laplacianVariance(gray: Uint8Array, width: number, height: number): number {
  if (width < 3 || height < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const v = gray[i - width] + gray[i + width] + gray[i - 1] + gray[i + 1] - 4 * gray[i];
      sum += v;
      sumSq += v * v;
      n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

export function meanBrightness(gray: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < gray.length; i++) sum += gray[i];
  return gray.length ? sum / gray.length : 0;
}

export function assessQuality(
  gray: Uint8Array, width: number, height: number, originalWidth: number, originalHeight: number,
): QualityResult {
  const sharpness = laplacianVariance(gray, width, height);
  const brightness = meanBrightness(gray);
  const issues: QualityIssue[] = [];
  if (sharpness < QUALITY.minSharpness) issues.push('blurry');
  if (brightness < QUALITY.minBrightness) issues.push('dark');
  if (brightness > QUALITY.maxBrightness) issues.push('bright');
  const long = Math.max(originalWidth, originalHeight);
  const short = Math.min(originalWidth, originalHeight);
  if (long < QUALITY.minLongSide || short < QUALITY.minShortSide) issues.push('low_resolution');
  return {
    pass: issues.length === 0,
    sharpness: Math.round(sharpness * 10) / 10,
    brightness: Math.round(brightness * 10) / 10,
    width: originalWidth,
    height: originalHeight,
    issues,
  };
}
