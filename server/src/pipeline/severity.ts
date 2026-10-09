import type { Damage, DamageItem, DamageType, Severity, SeverityBand } from '@claimlens/shared';

export const SEVERITY_WEIGHT: Record<Severity, number> = { Low: 8, Medium: 18, High: 32 };
export const TYPE_MULTIPLIER: Record<DamageType, number> = {
  Scratch: 0.6, 'Paint Damage': 0.7, Dent: 1.0, Crack: 1.1, 'Broken Glass': 1.3, 'Severe Deformation': 1.6,
};
const RANK: Record<Severity, number> = { Low: 0, Medium: 1, High: 2 };

const slug = (s: string) => s.toLowerCase().replace(/\s+/g, '-');
const itemScore = (type: DamageType, severity: Severity) =>
  Math.round(SEVERITY_WEIGHT[severity] * TYPE_MULTIPLIER[type] * 10) / 10;

export function mergeDamages(photos: { id: string; damages: Damage[] }[]): DamageItem[] {
  const byKey = new Map<string, DamageItem>();
  for (const photo of photos) {
    for (const d of photo.damages) {
      const id = `${slug(d.part)}-${slug(d.type)}`;
      const existing = byKey.get(id);
      if (!existing) {
        byKey.set(id, { id, part: d.part, type: d.type, severity: d.severity, score: itemScore(d.type, d.severity), photoIds: [photo.id] });
        continue;
      }
      if (RANK[d.severity] > RANK[existing.severity]) {
        existing.severity = d.severity;
        existing.score = itemScore(d.type, d.severity);
      }
      if (!existing.photoIds.includes(photo.id)) existing.photoIds.push(photo.id);
    }
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

export function scoreSeverity(items: DamageItem[]): { score: number; band: SeverityBand } {
  const score = Math.min(100, Math.round(items.reduce((sum, i) => sum + i.score, 0)));
  const band: SeverityBand = score >= 60 ? 'Severe' : score >= 25 ? 'Moderate' : 'Minor';
  return { score, band };
}
