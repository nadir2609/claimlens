import { PARTS, type Angle, type Coverage, type Part } from '@claimlens/shared';

const FRONT: Angle[] = ['front', 'front-left', 'front-right'];
const SIDE: Angle[] = ['left', 'right', 'front-left', 'front-right', 'rear-left', 'rear-right'];
const REAR: Angle[] = ['rear', 'rear-left', 'rear-right'];

export function assessCoverage(photos: { angle: Angle | null; visibleParts: Part[] }[]): Coverage {
  const seen = photos.filter((p) => p.angle !== null);
  const has = (set: Angle[]) => seen.some((p) => set.includes(p.angle as Angle));
  const angles = { front: has(FRONT), side: has(SIDE), rear: has(REAR) };
  const parts = Object.fromEntries(
    PARTS.map((part) => [part, seen.some((p) => p.visibleParts.includes(part))]),
  ) as Record<Part, boolean>;

  const prompts: string[] = [];
  if (!angles.front) prompts.push('No front view found. Please add a photo of the front of the vehicle.');
  if (!angles.side) prompts.push('No side view found. Please add a photo of the side of the vehicle.');
  if (!angles.rear) prompts.push('No rear view found. Please add a photo of the back of the vehicle.');
  for (const part of PARTS) {
    if (!parts[part]) prompts.push(`Please upload a clearer image of the ${part.toLowerCase()}.`);
  }
  return { angles, parts, prompts, complete: prompts.length === 0 };
}
