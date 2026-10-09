import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { UnreadableImageError, modelImage, prepareImage } from '../src/images';
import { hamming } from '../src/pipeline/fraud';
import { flatJpeg, sceneJpeg } from './helpers';

describe('prepareImage', () => {
  it('passes a sharp photo and fails a featureless one', async () => {
    expect((await prepareImage(await sceneJpeg(1))).quality.pass).toBe(true);
    expect((await prepareImage(await flatJpeg())).quality.issues).toContain('blurry');
  });

  it('flags low resolution from the original size', async () => {
    const q = (await prepareImage(await sceneJpeg(1, 640, 480))).quality;
    expect(q.issues).toEqual(['low_resolution']);
    expect([q.width, q.height]).toEqual([640, 480]);
  });

  it('applies EXIF orientation so stored pixels match what a browser displays', async () => {
    const rotated = await sharp(await sceneJpeg(2, 1200, 900)).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const p = await prepareImage(rotated);
    expect([p.width, p.height]).toEqual([900, 1200]);
    expect([p.quality.width, p.quality.height]).toEqual([900, 1200]);
    const meta = await sharp(p.display).metadata();
    expect([meta.width, meta.height]).toEqual([900, 1200]);
    expect(meta.orientation ?? 1).toBe(1);
  });

  it('caps the stored image at 2000 px and outputs JPEG', async () => {
    const p = await prepareImage(await sceneJpeg(3, 2600, 1300));
    expect([p.width, p.height]).toEqual([2000, 1000]);
    expect((await sharp(p.display).metadata()).format).toBe('jpeg');
  });

  it('hashes: identical bytes match, re-encoded copies are near, different scenes are far', async () => {
    const a = await sceneJpeg(4);
    const reencoded = await sharp(a).jpeg({ quality: 55 }).toBuffer();
    const [pa, pa2, pr, pb] = await Promise.all([prepareImage(a), prepareImage(a), prepareImage(reencoded), prepareImage(await sceneJpeg(5))]);
    expect(pa.sha256).toBe(pa2.sha256);
    expect(pa.dhash).toHaveLength(16);
    expect(pr.sha256).not.toBe(pa.sha256);
    expect(hamming(pa.dhash, pr.dhash)).toBeLessThanOrEqual(6);
    expect(hamming(pa.dhash, pb.dhash)).toBeGreaterThan(6);
  });

  it('reads no EXIF from a synthetic image', async () => {
    const p = await prepareImage(await sceneJpeg(6));
    expect(p.software).toBeNull();
    expect(p.capturedAt).toBeNull();
  });

  it('rejects bytes that are not an image', async () => {
    await expect(prepareImage(Buffer.from('not an image at all'))).rejects.toBeInstanceOf(UnreadableImageError);
  });
});

describe('modelImage', () => {
  it('returns base64 JPEG no larger than 1568 px', async () => {
    const p = await prepareImage(await sceneJpeg(7, 2400, 1800));
    const meta = await sharp(Buffer.from(await modelImage(p.display), 'base64')).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBe(1568);
  });
});
