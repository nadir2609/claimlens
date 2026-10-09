import sharp from 'sharp';
import { mulberry32 } from '../src/util/prng';

/** A sharp, mid-brightness synthetic photo: large blocks (stable perceptual hash) plus noise (high sharpness). */
export async function sceneJpeg(seed: number, width = 1200, height = 900): Promise<Buffer> {
  const rnd = mulberry32(seed);
  const blocks = Array.from({ length: 6 }, () => ({
    x: rnd() * width * 0.8, y: rnd() * height * 0.8,
    w: width * (0.15 + rnd() * 0.3), h: height * (0.15 + rnd() * 0.3), v: 70 + rnd() * 120,
  }));
  const px = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let base = 128;
      for (const b of blocks) if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) base = b.v;
      const v = Math.max(0, Math.min(255, Math.round(base + (rnd() - 0.5) * 90)));
      px.fill(v, (y * width + x) * 3, (y * width + x) * 3 + 3);
    }
  }
  return sharp(px, { raw: { width, height, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
}

export async function flatJpeg(width = 1200, height = 900): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 128, g: 128, b: 128 } } }).jpeg().toBuffer();
}
