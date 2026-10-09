import { createHash } from 'node:crypto';
import {
  DAMAGE_TYPES, SEVERITIES,
  type Angle, type Damage, type DamageType, type Part, type PhotoAnalysis, type VehicleInfo, type VisionResult,
} from '@claimlens/shared';
import { mulberry32, seedFromHex } from '../util/prng';
import type { PhotoInput, VisionAnalyzer } from './types';

const VEHICLES: Omit<VehicleInfo, 'confidence'>[] = [
  { make: 'Toyota', model: 'Camry', year: '2022', bodyType: 'Sedan' },
  { make: 'Honda', model: 'CR-V', year: '2021', bodyType: 'SUV' },
  { make: 'BMW', model: '3 Series', year: '2020', bodyType: 'Sedan' },
  { make: 'Ford', model: 'F-150', year: '2019', bodyType: 'Pickup' },
  { make: 'Volkswagen', model: 'Golf', year: '2021', bodyType: 'Hatchback' },
  { make: 'Tesla', model: 'Model 3', year: '2023', bodyType: 'Sedan' },
];

const ANGLE_ORDER: Angle[] = ['front-left', 'rear-right', 'left', 'front', 'rear', 'right', 'front-right', 'rear-left', 'detail', 'detail'];

const VISIBLE: Record<Angle, Part[]> = {
  front: ['Front Bumper', 'Hood', 'Headlights', 'Windshield'],
  'front-left': ['Front Bumper', 'Hood', 'Headlights', 'Windshield', 'Fenders', 'Doors'],
  'front-right': ['Front Bumper', 'Hood', 'Headlights', 'Windshield', 'Fenders', 'Doors'],
  left: ['Doors', 'Fenders'],
  right: ['Doors', 'Fenders'],
  rear: ['Rear Bumper'],
  'rear-left': ['Rear Bumper', 'Doors', 'Fenders'],
  'rear-right': ['Rear Bumper', 'Doors', 'Fenders'],
  detail: [],
  other: [],
};

const GLASS: Part[] = ['Windshield', 'Headlights'];

/** Deterministic stand-in used when no API key is configured. Results are seeded from the photo hashes. */
export class DemoAnalyzer implements VisionAnalyzer {
  readonly mode = 'demo' as const;

  async analyze(photos: PhotoInput[]): Promise<VisionResult> {
    const digest = createHash('sha256').update(photos.map((p) => p.sha256).sort().join('|')).digest('hex');
    const rnd = mulberry32(seedFromHex(digest));
    const pick = <T,>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)];

    const result: PhotoAnalysis[] = photos.map((p, i) => {
      const angle = ANGLE_ORDER[i % ANGLE_ORDER.length];
      return { photoId: p.id, angle, visibleParts: [...VISIBLE[angle]], damages: [] };
    });

    const candidates = result.filter((p) => p.visibleParts.length > 0);
    const count = candidates.length ? 2 + Math.floor(rnd() * 3) : 0;
    const used = new Set<string>();
    for (let placed = 0, tries = 0; placed < count && tries < 60; tries++) {
      const photo = pick(candidates);
      const part = pick(photo.visibleParts);
      const type: DamageType = GLASS.includes(part)
        ? pick(['Crack', 'Broken Glass'] as const)
        : pick(DAMAGE_TYPES.filter((t) => t !== 'Broken Glass'));
      if (used.has(`${photo.photoId}|${part}|${type}`)) continue;
      used.add(`${photo.photoId}|${part}|${type}`);
      const width = 0.14 + rnd() * 0.2;
      const height = 0.12 + rnd() * 0.18;
      const damage: Damage = {
        part, type, severity: pick(SEVERITIES),
        bbox: [0.08 + rnd() * (0.84 - width), 0.15 + rnd() * (0.75 - height), width, height],
        confidence: Math.round((0.7 + rnd() * 0.28) * 100) / 100,
        note: `Simulated ${type.toLowerCase()} on the ${part.toLowerCase()} (demo mode).`,
      };
      photo.damages.push(damage);
      placed++;
    }

    return {
      vehicle: { ...pick(VEHICLES), confidence: Math.round((0.75 + rnd() * 0.2) * 100) / 100 },
      photos: result,
      fraudObservations: [],
    };
  }
}
