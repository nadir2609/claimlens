import { analysisDimensions, assessQuality, rgbaToGray, type QualityResult } from '@claimlens/shared';

/** Runs the same quality metric as the server, in the browser, for instant feedback. */
export async function checkImageQuality(file: File): Promise<QualityResult> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const size = analysisDimensions(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0, size.width, size.height);
    const gray = rgbaToGray(ctx.getImageData(0, 0, size.width, size.height).data);
    return assessQuality(gray, size.width, size.height, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}
