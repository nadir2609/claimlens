import type { Part, PartListing, PartOffer, VehicleInfo } from '@claimlens/shared';

/** Lowercases and strips Azerbaijani diacritics so "Qapı", "qapi" and "QAPI" compare equal. */
export function fold(text: string): string {
  return text.toLowerCase()
    .replace(/ə/g, 'e').replace(/ı/g, 'i').replace(/i̇/g, 'i').replace(/ö/g, 'o').replace(/ü/g, 'u')
    .replace(/ş/g, 's').replace(/ç/g, 'c').replace(/ğ/g, 'g')
    .replace(/\s+/g, ' ').trim();
}

interface PartRule {
  /** What to type into the sites' search boxes. */
  query: string;
  /** The (folded) title must contain one of these. */
  names: string[];
  side?: 'front' | 'rear';
  /** Extra words that mean "not this part". */
  not?: string[];
}

export const PART_RULES: Record<Part, PartRule> = {
  'Front Bumper': { query: 'bamper', names: ['bamper', 'bufer'], side: 'front' },
  'Rear Bumper': { query: 'bamper', names: ['bamper', 'bufer'], side: 'rear' },
  Hood: { query: 'kapot', names: ['kapot'], not: ['izolyasiya'] },
  Headlights: { query: 'fara', names: ['fara'], not: ['duman', 'stop', 'yuyucu', 'suse'] },
  Doors: { query: 'qapı', names: ['qapi'], not: ['baqaj', 'suse', 'kart'] },
  Fenders: { query: 'qanad', names: ['qanad', 'krilo'] },
  Windshield: { query: 'ön şüşə', names: ['on suse', 'qabaq suse', 'lobovoy'] },
};

// Sellers list brackets, trims, seals and so on under the part's name. These words mark an accessory, not the part.
const ACCESSORY = [
  'berkidic', 'kant', 'barmaqli', 'petl', 'rezin', 'destey', 'destek', 'kilid', 'qoruyucu', 'sensor', 'emblem',
  'qapaq', 'motor', 'ablicovka', 'oblisovka', 'oblisofka', 'uzlu', 'ortu', 'duyme', 'guzgu', 'tros', 'kronsteyn',
  'nakladka', 'molding', 'ruck', 'body kit', 'amortizator', 'mexanizm', 'lampa', 'guclendirici', 'usilitel',
  'resotka', 'podkrilka', 'ehtiyat hisseleri',
];
const FRONT = ['on', 'qabaq', 'qabax', 'front'];
const REAR = ['arxa', 'rear', 'dal'];

const MAKE_ALIASES: Record<string, string[]> = {
  'mercedes-benz': ['mercedes', 'mersedes', 'benz'],
  volkswagen: ['volkswagen', 'vw', 'folksvagen'],
  hyundai: ['hyundai', 'hunday', 'hundai'],
  chevrolet: ['chevrolet', 'sevrolet', 'chevy'],
  toyota: ['toyota', 'tayota'],
  'land rover': ['land rover', 'range rover'],
};

/** A body panel below this price is a placeholder ("1 Azn, call me") or a different item. */
export const MIN_PLAUSIBLE_PRICE = 20;
const MAX_ALTERNATIVES = 4;

const hasWord = (folded: string, words: string[]) =>
  words.some((w) => new RegExp(`(^|[^a-z0-9])${w}([^a-z0-9]|$)`).test(folded));
const known = (value: string) => value.trim() !== '' && fold(value) !== 'unknown';

function isPart(title: string, part: Part): boolean {
  const rule = PART_RULES[part];
  if (!rule.names.some((n) => title.includes(n))) return false;
  if (ACCESSORY.some((w) => title.includes(w)) || hasWord(title, ['yay'])) return false;
  if (rule.not?.some((w) => title.includes(w))) return false;
  if (rule.side) {
    const front = hasWord(title, FRONT);
    const rear = hasWord(title, REAR);
    // A title naming only the other side is the wrong part; naming both, or neither, is acceptable.
    if (rule.side === 'front' ? rear && !front : front && !rear) return false;
  }
  return true;
}

function makeNames(make: string): string[] {
  const folded = fold(make);
  return MAKE_ALIASES[folded] ?? [folded, ...(folded.includes(' ') ? [folded.split(' ')[0]] : [])].filter((n) => n.length >= 2);
}

/** The make as sellers usually write it, for use in a search query ("Mercedes-Benz" is listed as "mercedes"). */
export function searchMake(make: string): string {
  return MAKE_ALIASES[fold(make)]?.[0] ?? make.trim();
}

/**
 * Chooses the cheapest listing that is the right part for the vehicle's make (and model, when any listing names it).
 * Returns null when nothing qualifies, including when the make is unknown.
 */
export function selectOffer(listings: PartListing[], part: Part, vehicle: VehicleInfo): PartOffer | null {
  if (!known(vehicle.make)) return null;
  const makes = makeNames(vehicle.make);

  const unique = new Map<string, PartListing>();
  for (const listing of listings) {
    const title = fold(listing.title);
    if (listing.price < MIN_PLAUSIBLE_PRICE || !isPart(title, part)) continue;
    if (!makes.some((m) => title.includes(m))) continue;
    if (!unique.has(listing.url)) unique.set(listing.url, listing);
  }
  let matches = [...unique.values()];

  if (known(vehicle.model)) {
    const model = fold(vehicle.model);
    const sameModel = matches.filter((l) => hasWord(fold(l.title), [model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')]));
    if (sameModel.length) matches = sameModel;
  }
  if (!matches.length) return null;

  matches.sort((a, b) => a.price - b.price);
  return { cheapest: matches[0], alternatives: matches.slice(1, 1 + MAX_ALTERNATIVES) };
}
