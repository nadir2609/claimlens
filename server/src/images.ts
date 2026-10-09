import { createHash } from 'node:crypto';
import exifr from 'exifr';
import sharp from 'sharp';
import { analysisDimensions, assessQuality, type QualityResult } from '@claimlens/shared';

export class UnreadableImageError extends Error {
  constructor() { super('File is not a readable image'); }
}

export interface PreparedImage {
  display: Buffer;
  width: number;
  height: number;
  quality: QualityResult;
  sha256: string;
  dhash: string;
  software: string | null;
  capturedAt: string | null;
}

const DISPLAY_MAX = 2000;
const MODEL_MAX = 1568;

async function dHash(buf: Buffer): Promise<string> {
  const px = await sharp(buf).rotate().greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) bits = (bits << 1n) | (px[y * 9 + x] > px[y * 9 + x + 1] ? 1n : 0n);
  }
  return bits.toString(16).padStart(16, '0');
}

async function readExif(buf: Buffer): Promise<{ software: string | null; capturedAt: string | null }> {
  try {
    const tags = await exifr.parse(buf, { pick: ['Software', 'DateTimeOriginal'] });
    const taken = tags?.DateTimeOriginal;
    return {
      software: typeof tags?.Software === 'string' ? tags.Software : null,
      capturedAt: taken instanceof Date && !Number.isNaN(taken.getTime()) ? taken.toISOString() : null,
    };
  } catch {
    return { software: null, capturedAt: null };
  }
}

export async function prepareImage(buf: Buffer): Promise<PreparedImage> {
  try {
    const meta = await sharp(buf).metadata();
    if (!meta.width || !meta.height) throw new UnreadableImageError();
    const swapped = (meta.orientation ?? 1) >= 5;
    const originalWidth = swapped ? meta.height : meta.width;
    const originalHeight = swapped ? meta.width : meta.height;

    const size = analysisDimensions(originalWidth, originalHeight);
    const gray = await sharp(buf).rotate().resize(size.width, size.height, { fit: 'fill' }).greyscale().raw().toBuffer();
    const quality = assessQuality(new Uint8Array(gray), size.width, size.height, originalWidth, originalHeight);

    const { data: display, info } = await sharp(buf).rotate()
      .resize(DISPLAY_MAX, DISPLAY_MAX, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 88 }).toBuffer({ resolveWithObject: true });

    return {
      display, width: info.width, height: info.height, quality,
      sha256: createHash('sha256').update(buf).digest('hex'),
      dhash: await dHash(buf),
      ...(await readExif(buf)),
    };
  } catch (err) {
    if (err instanceof UnreadableImageError) throw err;
    throw new UnreadableImageError();
  }
}

export async function modelImage(display: Buffer): Promise<string> {
  const out = await sharp(display)
    .resize(MODEL_MAX, MODEL_MAX, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  return out.toString('base64');
}
