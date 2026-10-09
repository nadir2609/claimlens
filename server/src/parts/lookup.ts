import type { DamageItem, Part, PartListing, PartSearchResult, VehicleInfo } from '@claimlens/shared';
import { needsReplacement } from '../pipeline/cost';
import { PART_RULES, searchMake, selectOffer, selectSimilar } from './match';
import { parseAvtopro, parseEhtiyat } from './parsers';

/** Returns a page as markdown. The real implementation is Firecrawl; tests substitute a fake. */
export interface PageFetcher {
  markdown(url: string): Promise<string>;
}

export interface PriceCache {
  getListings(key: string): { fetchedAt: number; listings: PartListing[] } | null;
  setListings(key: string, listings: PartListing[], fetchedAt: number): void;
}

export interface PartLookup {
  find(part: Part, vehicle: VehicleInfo): Promise<PartSearchResult | null>;
}

const CACHE_MS = 24 * 60 * 60 * 1000;

/** The search-result pages to read for a part and make: [avtopro.az, ehtiyathisseleri.az]. */
export function searchUrls(part: Part, make: string): [string, string] {
  const query = encodeURIComponent(`${PART_RULES[part].query} ${searchMake(make)}`);
  return [`https://www.avtopro.az/products?search=${query}`, `https://ehtiyathisseleri.az/search/?query=${query}`];
}

export class FirecrawlFetcher implements PageFetcher {
  constructor(private readonly apiKey: string) {}

  async markdown(url: string): Promise<string> {
    const res = await fetch('https://api.firecrawl.dev/v2/scrape', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: false }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`Firecrawl returned ${res.status} for ${url}`);
    const body = (await res.json()) as { data?: { markdown?: string } };
    return body.data?.markdown ?? '';
  }
}

/** Finds the cheapest marketplace listing for a part, caching each search page for 24 hours. */
export class PartPriceLookup implements PartLookup {
  constructor(
    private readonly fetcher: PageFetcher,
    private readonly cache: PriceCache,
    private readonly now: () => number = Date.now,
  ) {}

  async find(part: Part, vehicle: VehicleInfo): Promise<PartSearchResult | null> {
    const make = vehicle.make.trim();
    if (!make || make.toLowerCase() === 'unknown') return null;
    const [avtopro, ehtiyat] = searchUrls(part, make);
    const pages = await Promise.all([this.listings(avtopro, parseAvtopro), this.listings(ehtiyat, parseEhtiyat)]);
    const all = pages.flat();
    const offer = selectOffer(all, part, vehicle);
    return {
      offer,
      similar: offer ? [] : selectSimilar(all, part),
      searchLinks: [{ source: 'avtopro.az', url: avtopro }, { source: 'ehtiyathisseleri.az', url: ehtiyat }],
    };
  }

  private async listings(url: string, parse: (markdown: string) => PartListing[]): Promise<PartListing[]> {
    const cached = this.cache.getListings(url);
    if (cached && this.now() - cached.fetchedAt <= CACHE_MS) return cached.listings;
    try {
      const listings = parse(await this.fetcher.markdown(url));
      this.cache.setListings(url, listings, this.now());
      return listings;
    } catch (err) {
      // One site being down should not lose the other site's prices; failures are not cached.
      console.warn(`Part price search failed: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }
}

/** Searches for each distinct part that will be replaced. A failed lookup just leaves that part out. */
export async function findOffers(
  lookup: PartLookup, items: DamageItem[], vehicle: VehicleInfo,
): Promise<Partial<Record<Part, PartSearchResult>>> {
  const offers: Partial<Record<Part, PartSearchResult>> = {};
  const parts = [...new Set(items.filter(needsReplacement).map((i) => i.part))];
  for (const part of parts) {
    try {
      const found = await lookup.find(part, vehicle);
      if (found) offers[part] = found;
    } catch (err) {
      console.warn(`Part price lookup failed for ${part}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return offers;
}
