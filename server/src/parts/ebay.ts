import type { Part, PartListing, PartSearchResult, VehicleInfo } from '@claimlens/shared';
import type { LookupCache, PartLookup } from './lookup';
import { toOffer } from './rockauto';

// eBay Motors is the fallback for parts the catalog sites do not stock (older or non-US cars, doors, glass).
// It is read through eBay's official Browse API, so it needs an eBay developer app, not Firecrawl.

export const EBAY = 'ebay.com';
/** eBay Motors > Parts & Accessories. */
const PARTS_CATEGORY = '6028';
const CACHE_MS = 24 * 60 * 60 * 1000;
/** A body part below this price is almost always a fastener, a sticker or a placeholder. */
const MIN_PLAUSIBLE_PRICE = 20;

export interface EbayItem {
  title: string;
  price: number;
  currency: string;
  url: string;
}

export interface EbayClient {
  search(query: string): Promise<EbayItem[]>;
}

interface PartRule {
  /** Added to the make and model to form the search query. */
  query: string;
  /** The title must contain one of these. */
  names: string[];
  side?: 'front' | 'rear';
  /** Words that mean the listing is a different part. */
  not?: string[];
}

const RULES: Record<Part, PartRule> = {
  'Front Bumper': { query: 'front bumper', names: ['bumper'], side: 'front' },
  'Rear Bumper': { query: 'rear bumper', names: ['bumper'], side: 'rear' },
  Hood: { query: 'hood', names: ['hood', 'bonnet'] },
  Headlights: { query: 'headlight', names: ['headlight', 'headlamp', 'head light', 'head lamp'] },
  Doors: { query: 'door', names: ['door'], not: ['panel', 'bumper', 'hood', 'fender', 'headlight', 'headlamp', 'windshield', 'glass', 'window'] },
  Fenders: { query: 'fender', names: ['fender', 'wing'] },
  Windshield: { query: 'windshield', names: ['windshield', 'windscreen'] },
};

// Sellers list small items under the part's name. These words mark an accessory, a toy or a book, not the part.
const NOT_THE_PART = [
  'bracket', 'clip', 'retainer', 'trim', 'molding', 'moulding', 'grille', 'grill', 'emblem', 'badge', 'reinforcement',
  'absorber', 'bulb', 'lens', 'hinge', 'latch', 'strut', 'support', 'seal', 'handle', 'mirror', 'switch', 'bezel',
  'hook', 'sensor', 'guard', 'lip', 'spoiler', 'splitter', 'protector', 'sticker', 'decal', 'bra', 'eyelid', 'eyebrow',
  'wiper', 'washer', 'nozzle', 'cable', 'lock', 'regulator', 'motor', 'weatherstrip', 'vent', 'visor', 'fog',
  'insulation', 'insulator', 'diecast', 'scale', 'manual', 'keychain',
];

const MAKE_ALIASES: Record<string, string[]> = {
  lada: ['lada', 'vaz'],
  'mercedes-benz': ['mercedes', 'benz'],
  volkswagen: ['volkswagen', 'vw'],
  chevrolet: ['chevrolet', 'chevy'],
};

const known = (value: string) => value.trim() !== '' && value.trim().toLowerCase() !== 'unknown';
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasWord = (title: string, words: string[]) => words.some((w) => new RegExp(`\\b${escape(w)}s?\\b`).test(title));

export const ebayQuery = (part: Part, vehicle: VehicleInfo) =>
  `${vehicle.make.trim()} ${vehicle.model.trim()} ${RULES[part].query}`;

/** The same search on the eBay website, for a person to open. */
export const ebaySearchPage = (query: string) =>
  `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}&_sacat=${PARTS_CATEGORY}`;

/**
 * Listings that are the right part for the vehicle's make, cheapest first. If any listing names the model,
 * only those are kept.
 */
export function selectEbay(items: EbayItem[], part: Part, vehicle: VehicleInfo): PartListing[] {
  if (!known(vehicle.make)) return [];
  const rule = RULES[part];
  const make = vehicle.make.trim().toLowerCase();
  const makes = MAKE_ALIASES[make] ?? [make];

  let matches = items.filter((item) => {
    const title = item.title.toLowerCase();
    if (item.currency !== 'USD' || item.price < MIN_PLAUSIBLE_PRICE) return false;
    if (!hasWord(title, makes) || !hasWord(title, rule.names)) return false;
    if (hasWord(title, NOT_THE_PART) || /\b1[:/]\d+\b/.test(title)) return false;
    if (rule.not && hasWord(title, rule.not)) return false;
    if (rule.side) {
      const front = hasWord(title, ['front']);
      const rear = hasWord(title, ['rear', 'back']);
      // A title naming only the other end is the wrong part; naming both, or neither, is acceptable.
      if (rule.side === 'front' ? rear && !front : front && !rear) return false;
    }
    return true;
  });

  if (known(vehicle.model)) {
    const sameModel = matches.filter((item) => hasWord(item.title.toLowerCase(), [vehicle.model.trim().toLowerCase()]));
    if (sameModel.length) matches = sameModel;
  }
  return matches
    .sort((a, b) => a.price - b.price)
    .map((item) => ({ title: item.title, price: item.price, url: item.url, source: EBAY }));
}

/** eBay's Browse API, authenticated with an application token (client credentials grant). */
export class EbayApi implements EbayClient {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly clientId: string, private readonly clientSecret: string) {}

  async search(query: string): Promise<EbayItem[]> {
    const params = new URLSearchParams({
      q: query, category_ids: PARTS_CATEGORY, limit: '50', filter: 'buyingOptions:{FIXED_PRICE}',
    });
    const res = await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`, {
      headers: { Authorization: `Bearer ${await this.accessToken()}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 401) this.token = null;
    if (!res.ok) throw new Error(`eBay search returned ${res.status}`);
    const body = (await res.json()) as {
      itemSummaries?: { title?: string; price?: { value?: string; currency?: string }; itemWebUrl?: string }[];
    };
    return (body.itemSummaries ?? []).flatMap((s) => {
      const price = Number(s.price?.value);
      return s.title && s.itemWebUrl && s.price?.currency && Number.isFinite(price)
        ? [{ title: s.title, price, currency: s.price.currency, url: s.itemWebUrl }]
        : [];
    });
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'https://api.ebay.com/oauth/api_scope' }).toString(),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 400 || res.status === 401) {
      throw new Error('eBay rejected the credentials. Check EBAY_CLIENT_ID and EBAY_CLIENT_SECRET.');
    }
    if (!res.ok) throw new Error(`eBay sign-in returned ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    // Renew a minute early so a token never expires mid-request.
    this.token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in - 60) * 1000 };
    return body.access_token;
  }
}

/**
 * Asks the first source (the catalog sites) and, when it has no price for the part, searches eBay instead.
 * eBay results are cached for 24 hours. If eBay fails, the first source's answer is returned unchanged.
 */
export class EbayFallbackLookup implements PartLookup {
  constructor(
    private readonly first: PartLookup | null,
    private readonly ebay: EbayClient,
    private readonly cache: LookupCache,
    private readonly now: () => number = Date.now,
  ) {}

  async find(part: Part, vehicle: VehicleInfo): Promise<PartSearchResult | null> {
    const primary = this.first ? await this.first.find(part, vehicle) : null;
    if (primary?.offer || !known(vehicle.make) || !known(vehicle.model)) return primary;

    const query = ebayQuery(part, vehicle);
    let items: EbayItem[];
    const cached = this.cache.getCache<EbayItem[]>(`ebay:${query}`);
    if (cached && this.now() - cached.fetchedAt <= CACHE_MS) {
      items = cached.value;
    } else {
      try {
        items = await this.ebay.search(query);
        this.cache.setCache(`ebay:${query}`, items, this.now());
      } catch (err) {
        console.warn(`eBay part search failed: ${err instanceof Error ? err.message : err}`);
        return primary;
      }
    }
    return {
      offer: toOffer(selectEbay(items, part, vehicle)),
      similar: [],
      searchLinks: [...(primary?.searchLinks ?? []), { source: EBAY, url: ebaySearchPage(query) }],
    };
  }
}
