import type {
  CostEstimate, CostLine, DamageItem, DamageType, Part, PartSearchResult, Severity,
} from '@claimlens/shared';

// All amounts are in Azerbaijani manat (AZN). Labour, paint and the fallback part prices are placeholder
// figures (the original USD placeholders converted at about 1.7 AZN per USD), not market data.
export const LABOR_RATE = 160;

/** Used only when no marketplace listing is found for a part that must be replaced. */
export const PART_PRICE: Record<Part, number> = {
  'Front Bumper': 765, 'Rear Bumper': 714, Hood: 1020, Headlights: 595, Doors: 1190, Fenders: 646, Windshield: 680,
};

export const LABOR_HOURS: Record<DamageType, Record<Severity, number>> = {
  Scratch: { Low: 1.0, Medium: 2.0, High: 3.0 },
  'Paint Damage': { Low: 1.5, Medium: 2.5, High: 3.5 },
  Dent: { Low: 1.5, Medium: 3.0, High: 5.0 },
  Crack: { Low: 1.5, Medium: 2.5, High: 4.0 },
  'Broken Glass': { Low: 1.5, Medium: 2.0, High: 2.5 },
  'Severe Deformation': { Low: 4.0, Medium: 6.0, High: 9.0 },
};

export const PAINT: Record<Severity, number> = { Low: 255, Medium: 510, High: 765 };
const UNPAINTED: Part[] = ['Windshield', 'Headlights'];

const TIERS = {
  economy: { multiplier: 1.0, makes: ['toyota', 'honda', 'hyundai', 'kia', 'ford', 'chevrolet', 'nissan'] },
  mid: { multiplier: 1.3, makes: ['volkswagen', 'mazda', 'subaru', 'volvo', 'jeep'] },
  luxury: { multiplier: 1.9, makes: ['bmw', 'mercedes-benz', 'audi', 'lexus', 'tesla', 'porsche'] },
} as const;
type Tier = keyof typeof TIERS;

const round2 = (n: number) => Math.round(n * 100) / 100;

export function makeTier(make: string): { tier: Tier; multiplier: number } {
  const n = make.trim().toLowerCase();
  if (n.length >= 3) {
    for (const tier of Object.keys(TIERS) as Tier[]) {
      if (TIERS[tier].makes.some((m) => n === m || n.startsWith(m) || m.startsWith(n))) {
        return { tier, multiplier: TIERS[tier].multiplier };
      }
    }
  }
  return { tier: 'mid', multiplier: TIERS.mid.multiplier };
}

/** High severity, or broken glass at any severity, means the part is replaced rather than repaired. */
export const needsReplacement = (item: Pick<DamageItem, 'severity' | 'type'>): boolean =>
  item.severity === 'High' || item.type === 'Broken Glass';

/**
 * Prices each damage item. A replaced part costs the cheapest marketplace listing when `found` has an offer for
 * that part; otherwise the fallback table scaled by make tier. A part with several kinds of damage is bought and
 * painted once: the first line for it (items arrive most severe first) carries those charges.
 */
export function estimateCost(
  items: DamageItem[], make: string, found: Partial<Record<Part, PartSearchResult>> = {},
): CostEstimate {
  const { tier, multiplier } = makeTier(make);
  const replaced = new Set<Part>();
  const painted = new Set<Part>();
  for (const item of items) if (needsReplacement(item)) replaced.add(item.part);
  const partCharged = new Set<Part>();

  const lines: CostLine[] = items.map((item) => {
    const replace = needsReplacement(item);
    const search = replaced.has(item.part) ? found[item.part] : undefined;
    const offer = search?.offer ?? null;
    const chargePart = replace && !partCharged.has(item.part);
    if (chargePart) partCharged.add(item.part);
    const parts = !chargePart ? 0 : offer ? round2(offer.cheapest.price) : round2(PART_PRICE[item.part] * multiplier);

    const chargePaint = !UNPAINTED.includes(item.part) && !painted.has(item.part);
    if (chargePaint) painted.add(item.part);
    // A panel being replaced is painted at the replacement's rate, whichever of its lines comes first.
    const paint = chargePaint ? PAINT[replaced.has(item.part) ? 'High' : item.severity] : 0;

    const laborHours = LABOR_HOURS[item.type][item.severity];
    const labor = round2(laborHours * LABOR_RATE);
    return {
      damageId: item.id, part: item.part, type: item.type, severity: item.severity,
      operation: replace ? 'Replace' : 'Repair',
      parts,
      partsBasis: !replace ? 'none' : !chargePart ? 'included' : offer ? 'listing' : 'estimate',
      partListing: chargePart ? offer?.cheapest ?? null : null,
      alternatives: chargePart ? offer?.alternatives ?? [] : [],
      similarListings: chargePart && !offer ? search?.similar ?? [] : [],
      searchLinks: chargePart ? search?.searchLinks ?? [] : [],
      paint, laborHours, laborRate: LABOR_RATE, labor, total: round2(parts + paint + labor),
    };
  });
  const sum = (pick: (l: CostLine) => number) => round2(lines.reduce((s, l) => s + pick(l), 0));
  return {
    lines,
    partsTotal: sum((l) => l.parts),
    paintTotal: sum((l) => l.paint),
    laborTotal: sum((l) => l.labor),
    laborHours: sum((l) => l.laborHours),
    total: sum((l) => l.total),
    makeTier: tier,
    tierMultiplier: multiplier,
    laborRate: LABOR_RATE,
    currency: 'AZN',
  };
}
