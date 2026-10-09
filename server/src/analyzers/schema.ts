import { z } from 'zod';
import {
  ANGLES, DAMAGE_TYPES, FRAUD_OBSERVATION_KINDS, PARTS, SEVERITIES,
  type Damage, type FraudObservation, type Part, type PhotoAnalysis, type VehicleInfo, type VisionResult,
} from '@claimlens/shared';

const DamageSchema = z.object({
  part: z.enum(PARTS),
  type: z.enum(DAMAGE_TYPES),
  severity: z.enum(SEVERITIES),
  bbox: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  confidence: z.number(),
  note: z.string(),
});

const ObservationSchema = z.object({ kind: z.enum(FRAUD_OBSERVATION_KINDS), detail: z.string() });

/** The strict shape requested from the model. No numeric bounds: structured outputs do not enforce them. */
export const VisionOutputSchema = z.object({
  vehicle: z.object({
    make: z.string(), model: z.string(), year: z.string(), bodyType: z.string(), confidence: z.number(),
  }),
  photos: z.array(z.object({
    photoId: z.string(),
    angle: z.enum(ANGLES),
    visibleParts: z.array(z.enum(PARTS)),
    damages: z.array(DamageSchema),
  })),
  fraudObservations: z.array(ObservationSchema),
});

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const round4 = (n: number) => Math.round(n * 10000) / 10000;
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : 'Unknown');
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function cleanDamage(raw: unknown): Damage | null {
  const parsed = DamageSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { bbox, ...rest } = parsed.data;
  const x = round4(clamp01(bbox.x));
  const y = round4(clamp01(bbox.y));
  const width = round4(clamp01(bbox.x + bbox.width) - x);
  const height = round4(clamp01(bbox.y + bbox.height) - y);
  if (!(width > 0.005) || !(height > 0.005)) return null;
  return { ...rest, bbox: [x, y, width, height], confidence: clamp01(rest.confidence) };
}

/** Lenient clean-up of analyzer output: drop what is invalid, keep what is usable. */
export function sanitizeVision(raw: unknown, photoIds: string[]): VisionResult {
  if (!isRecord(raw) || !Array.isArray(raw.photos)) throw new Error('Model returned an invalid analysis');

  const v = isRecord(raw.vehicle) ? raw.vehicle : {};
  const vehicle: VehicleInfo = {
    make: text(v.make), model: text(v.model), year: text(v.year), bodyType: text(v.bodyType),
    confidence: typeof v.confidence === 'number' ? clamp01(v.confidence) : 0,
  };

  const byId = new Map<string, PhotoAnalysis>();
  for (const p of raw.photos) {
    if (!isRecord(p) || typeof p.photoId !== 'string') continue;
    // Models sometimes echo the label ("Photo id: p1") instead of the bare id.
    const photoId = photoIds.includes(p.photoId) ? p.photoId : (p.photoId.match(/p\d+/)?.[0] ?? '');
    if (!photoIds.includes(photoId) || byId.has(photoId)) continue;
    const angle = z.enum(ANGLES).safeParse(p.angle);
    const damages = (Array.isArray(p.damages) ? p.damages : []).map(cleanDamage).filter((d): d is Damage => d !== null);
    const visible = new Set<Part>(
      (Array.isArray(p.visibleParts) ? p.visibleParts : []).filter((x): x is Part => PARTS.includes(x as Part)),
    );
    for (const d of damages) visible.add(d.part);
    byId.set(photoId, {
      photoId,
      angle: angle.success ? angle.data : 'other',
      visibleParts: PARTS.filter((part) => visible.has(part)),
      damages,
    });
  }

  // Entries came back but none belong to this claim: reporting "no damage" would be wrong.
  if (raw.photos.length > 0 && byId.size === 0) throw new Error('Model returned an invalid analysis');

  const photos = photoIds.map((id) => byId.get(id) ?? { photoId: id, angle: 'other' as const, visibleParts: [], damages: [] });
  const fraudObservations: FraudObservation[] = (Array.isArray(raw.fraudObservations) ? raw.fraudObservations : [])
    .map((o) => ObservationSchema.safeParse(o))
    .flatMap((r) => (r.success ? [r.data] : []));

  return { vehicle, photos, fraudObservations };
}
