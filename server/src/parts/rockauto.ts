import type { Part, PartListing, PartOffer } from '@claimlens/shared';

// RockAuto's catalog is a tree of pages addressed by comma-separated path segments:
//   /en/catalog/<make>,<year>,<model>,<engine>,<vehicle id>,<category>,<part type>,<part type id>
// Each page links to its children, so a vehicle's parts are found by walking down from the model page.

export const SOURCE = 'rockauto.com';
export const CATALOG = 'https://www.rockauto.com/en/catalog';
export const BODY_CATEGORY = 'body+&+lamp+assembly';

export interface RockListing {
  manufacturer: string;
  partNumber: string;
  description: string;
  /** Fitment note, for example "Front; SE Model". */
  note: string;
  price: number;
  infoUrl: string | null;
  /** Other numbers this part replaces: the car maker's own part number mixed with other aftermarket codes. */
  oemNumbers: string[];
}

/** Which catalog part type holds each report part. Doors and windshields are usually not sold as whole parts. */
export const PART_TYPES: Record<Part, { names: string[]; side?: 'Front' | 'Rear' }> = {
  'Front Bumper': { names: ['bumper+cover'], side: 'Front' },
  'Rear Bumper': { names: ['bumper+cover'], side: 'Rear' },
  Hood: { names: ['hood'] },
  Headlights: { names: ['headlamp+assembly'] },
  Doors: { names: ['door+shell', 'door'] },
  Fenders: { names: ['fender'] },
  Windshield: { names: ['windshield+glass', 'windshield'] },
};

const MAX_ALTERNATIVES = 4;

export const slug = (text: string) => text.trim().toLowerCase().replace(/\s+/g, '+');
export const firstYear = (year: string): string | null => /\b(19|20)\d{2}\b/.exec(year)?.[0] ?? null;

const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");
const text = (html: string) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Every catalog link on a page, as absolute URLs. */
export function catalogLinks(html: string): string[] {
  const found = new Set<string>();
  for (const [, path] of html.matchAll(/href="(?:https:\/\/www\.rockauto\.com)?\/en\/catalog\/([^"#]+)"/g)) {
    found.add(`${CATALOG}/${decode(path)}`);
  }
  return [...found];
}

/** Links on a page that sit exactly `depth` path segments below `parent`. */
export function childLinks(html: string, parent: string, depth: number): string[] {
  const prefix = `${parent},`;
  return catalogLinks(html).filter((url) => url.startsWith(prefix) && url.slice(prefix.length).split(',').length === depth);
}

export function parseListings(html: string): RockListing[] {
  const listings: RockListing[] = [];
  for (const block of html.split(/<tbody id="listingcontainer\[\d+\]"/).slice(1)) {
    const price = /id="dprice\[\d+\]\[v\]"[^>]*>\s*\$?([\d,]+\.?\d*)/.exec(block);
    const partNumber = /listing-final-partnumber[^>]*>([^<]*)</.exec(block);
    if (!price || !partNumber) continue;
    const value = Number(price[1].replace(/,/g, ''));
    if (!Number.isFinite(value) || value <= 0) continue;
    const note = /listing-footnote-text[^>]*>([\s\S]*?)<\/span>\s*<\/span>/.exec(block);
    const info = /href="(https:\/\/www\.rockauto\.com\/en\/moreinfo\.php[^"]*)"/.exec(block);
    listings.push({
      manufacturer: text(/listing-final-manufacturer[^>]*>([^<]*)</.exec(block)?.[1] ?? ''),
      partNumber: text(partNumber[1]),
      description: text(/span-link-underline-remover[^>]*>([^<]*)</.exec(block)?.[1] ?? ''),
      note: note ? text(note[1]) : '',
      price: value,
      infoUrl: info ? decode(info[1]) : null,
      oemNumbers: (/title="Replaces these[^"]*"[^>]*>([^<]*)</.exec(block)?.[1] ?? '').split(',').map((n) => n.trim()).filter(Boolean),
    });
  }
  return listings;
}

/** Listings for the part (and for the right end of the car, for bumpers), cheapest first. */
export function matchListings(listings: RockListing[], part: Part): RockListing[] {
  const side = PART_TYPES[part].side;
  const other = side === 'Front' ? 'Rear' : 'Front';
  return listings
    // A note naming only the other end is the wrong part; naming both, or neither, is acceptable.
    .filter((l) => !side || new RegExp(`\\b${side}\\b`).test(l.note) || !new RegExp(`\\b${other}\\b`).test(l.note))
    .sort((a, b) => a.price - b.price);
}

export function toPartListing(l: RockListing, pageUrl: string): PartListing {
  return {
    title: `${[l.manufacturer, l.partNumber].filter(Boolean).join(' ')}${l.description ? `, ${l.description}` : ''}${l.note ? ` (${l.note})` : ''}`,
    price: l.price,
    url: l.infoUrl ?? pageUrl,
    source: SOURCE,
  };
}

/**
 * Cheapest listing first, then the next few as alternatives. A `genuine` listing is always included, taking the
 * last alternative slot if it would otherwise be pushed out by cheaper aftermarket parts.
 */
export function toOffer(listings: PartListing[], genuine?: PartListing | null): PartOffer | null {
  const sorted = [...listings].sort((a, b) => a.price - b.price);
  const kept = genuine ? [...sorted.slice(0, MAX_ALTERNATIVES), genuine] : sorted.slice(0, MAX_ALTERNATIVES + 1);
  kept.sort((a, b) => a.price - b.price);
  return kept.length ? { cheapest: kept[0], alternatives: kept.slice(1) } : null;
}

/**
 * From a listing's interchange numbers, the ones most likely to be the car maker's own part number, best first.
 * Aftermarket "Partslink" codes (two letters and seven digits, such as TO1000378C) are dropped; maker numbers are
 * mostly digits, so the rest are ranked by how numeric they are. At most two are returned.
 */
export function oemCandidates(numbers: string[]): string[] {
  const digitShare = (n: string) => n.replace(/\D/g, '').length / n.length;
  return [...new Set(numbers.map((n) => n.replace(/[\s-]/g, '').toUpperCase()))]
    .filter((n) => n.length >= 8 && n.length <= 14 && !/^[A-Z]{2}\d{7}[A-Z]*$/.test(n) && digitShare(n) >= 0.7)
    .sort((a, b) => digitShare(b) - digitShare(a))
    .slice(0, 2);
}

const plain = (s: string) => decodeURIComponent(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/** Picks the model page whose name best matches what the vision model called the car ("Camry LE" -> "camry"). */
export function matchModel(modelUrls: string[], model: string): string | null {
  const wanted = plain(model);
  if (!wanted) return null;
  const named = modelUrls.map((url) => ({ url, name: plain(url.slice(url.lastIndexOf(',') + 1)) })).filter((m) => m.name);
  const longest = (list: typeof named) => list.sort((a, b) => b.name.length - a.name.length)[0]?.url ?? null;
  return named.find((m) => m.name === wanted)?.url
    ?? longest(named.filter((m) => wanted.startsWith(m.name)))
    ?? longest(named.filter((m) => m.name.startsWith(wanted)))
    ?? longest(named.filter((m) => m.name.length >= 3 && wanted.includes(m.name)));
}
