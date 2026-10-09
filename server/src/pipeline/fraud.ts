import type { Band3, FraudAssessment, FraudObservation, FraudObservationKind, FraudSignal } from '@claimlens/shared';

export interface PriorHash { claimId: string; photoId: string; sha256: string; dhash: string }
export interface FraudInput {
  photos: { id: string; sha256: string; dhash: string; software: string | null; capturedAt: string | null }[];
  priorHashes: PriorHash[];
  observations: FraudObservation[];
  totalCost: number;
}

export const DHASH_MAX_DISTANCE = 6;
const EDITORS = /photoshop|gimp|lightroom|affinity|pixelmator|snapseed|picsart|facetune/i;
const OBSERVATION: Record<FraudObservationKind, { label: string; points: number }> = {
  vehicle_mismatch: { label: 'Photos show different vehicles', points: 35 },
  screen_recapture: { label: 'Photo of a screen or printed photo', points: 30 },
  damage_inconsistency: { label: 'Damage inconsistent between angles', points: 20 },
};

export function hamming(a: string, b: string): number {
  let x = BigInt(`0x${a || '0'}`) ^ BigInt(`0x${b || '0'}`);
  let bits = 0;
  while (x > 0n) { bits += Number(x & 1n); x >>= 1n; }
  return bits;
}

export function assessFraud(input: FraudInput): FraudAssessment {
  const signals: FraudSignal[] = [];
  const notes: string[] = [];

  const dupes: string[] = [];
  for (const p of input.photos) {
    const match = input.priorHashes.find(
      (h) => h.sha256 === p.sha256 || (h.dhash.length === p.dhash.length && hamming(h.dhash, p.dhash) <= DHASH_MAX_DISTANCE),
    );
    if (match) dupes.push(`${p.id} matches ${match.photoId} in claim ${match.claimId}`);
  }
  if (dupes.length) {
    signals.push({ kind: 'duplicate_photo', label: 'Photo duplicates one in an earlier claim', detail: dupes.join('; '), points: 40 });
  }

  for (const kind of Object.keys(OBSERVATION) as FraudObservationKind[]) {
    const found = input.observations.filter((o) => o.kind === kind);
    if (found.length) {
      signals.push({ kind, label: OBSERVATION[kind].label, detail: found.map((o) => o.detail).join('; '), points: OBSERVATION[kind].points });
    }
  }

  const edited = input.photos.filter((p) => p.software && EDITORS.test(p.software));
  if (edited.length) {
    signals.push({
      kind: 'editing_software', label: 'EXIF shows editing software',
      detail: edited.map((p) => `${p.id}: ${p.software}`).join('; '), points: 20,
    });
  }

  const times = input.photos.map((p) => (p.capturedAt ? Date.parse(p.capturedAt) : NaN)).filter((t) => !Number.isNaN(t));
  if (times.length >= 2) {
    const days = (Math.max(...times) - Math.min(...times)) / 86_400_000;
    if (days > 30) {
      signals.push({ kind: 'date_spread', label: 'Capture dates more than 30 days apart', detail: `Photos span ${Math.round(days)} days`, points: 10 });
    }
  }
  const missing = input.photos.length - times.length;
  if (missing > 0) notes.push(`${missing} of ${input.photos.length} photos have no EXIF capture date (informational; many apps strip metadata).`);

  if (input.totalCost > 12_000) {
    signals.push({ kind: 'high_cost', label: 'Total cost above $12,000', detail: `Estimate is $${input.totalCost.toFixed(2)}`, points: 10 });
  }

  const score = Math.min(100, signals.reduce((s, x) => s + x.points, 0));
  const band: Band3 = score >= 60 ? 'High' : score >= 30 ? 'Medium' : 'Low';
  return { score, band, signals, notes };
}
