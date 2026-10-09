import type { BBox } from '@claimlens/shared';

export interface BoxRect { x: number; y: number; w: number; h: number }

export function toPixels(bbox: BBox, width: number, height: number): BoxRect {
  return { x: bbox[0] * width, y: bbox[1] * height, w: bbox[2] * width, h: bbox[3] * height };
}

/** The id of the smallest box containing the point, so nested boxes stay selectable. */
export function hitTest(boxes: { id: string; rect: BoxRect }[], x: number, y: number): string | null {
  let best: { id: string; area: number } | null = null;
  for (const { id, rect } of boxes) {
    if (x < rect.x || x > rect.x + rect.w || y < rect.y || y > rect.y + rect.h) continue;
    const area = rect.w * rect.h;
    if (!best || area < best.area) best = { id, area };
  }
  return best?.id ?? null;
}
