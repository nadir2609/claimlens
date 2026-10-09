import type { DamageItem, Part, PartSearchResult, VehicleInfo } from '@claimlens/shared';
import { needsReplacement } from '../pipeline/cost';
import {
  BODY_CATEGORY, CATALOG, PART_TYPES, SOURCE, childLinks, firstYear, matchModel, parseListings, selectListing, slug,
  type RockListing,
} from './rockauto';

/** Returns a page's HTML. The real implementation is Firecrawl; tests substitute a fake. */
export interface PageFetcher {
  html(url: string): Promise<string>;
}

export interface LookupCache {
  getCache<T>(key: string): { fetchedAt: number; value: T } | null;
  setCache(key: string, value: unknown, fetchedAt: number): void;
}

export interface PartLookup {
  find(part: Part, vehicle: VehicleInfo): Promise<PartSearchResult | null>;
}

const CACHE_MS = 24 * 60 * 60 * 1000;
const known = (value: string) => value.trim() !== '' && value.trim().toLowerCase() !== 'unknown';

export class FirecrawlFetcher implements PageFetcher {
  /** `retryDelayMs` is how long to wait after a rate-limit response; the free plan allows few requests per minute. */
  constructor(private readonly apiKey: string, private readonly retryDelayMs = 20_000) {}

  async html(url: string): Promise<string> {
    let res: Response;
    for (let attempt = 1; ; attempt++) {
      res = await fetch('https://api.firecrawl.dev/v2/scrape', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, formats: ['rawHtml'], onlyMainContent: false }),
        signal: AbortSignal.timeout(90_000),
      });
      if (res.status !== 429 || attempt === 3) break;
      await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
    }
    if (!res.ok) throw new Error(`Firecrawl returned ${res.status} for ${url}`);
    const body = (await res.json()) as { data?: { rawHtml?: string } };
    return body.data?.rawHtml ?? '';
  }
}

/**
 * Finds the cheapest RockAuto listing for a part of a specific vehicle by walking the catalog:
 * model page -> first engine -> body category -> part type page. Every page read is cached for 24 hours.
 */
export class RockAutoLookup implements PartLookup {
  constructor(
    private readonly fetcher: PageFetcher,
    private readonly cache: LookupCache,
    private readonly now: () => number = Date.now,
  ) {}

  async find(part: Part, vehicle: VehicleInfo): Promise<PartSearchResult | null> {
    const year = firstYear(vehicle.year);
    if (!known(vehicle.make) || !known(vehicle.model) || !year) return null;

    const engine = await this.engineUrl(slug(vehicle.make), year, vehicle.model);
    if (!engine) return null;

    const category = `${engine},${BODY_CATEGORY}`;
    const partTypes = await this.read(category, (html) => childLinks(html, category, 2)) ?? [];
    const page = PART_TYPES[part].names
      .map((name) => partTypes.find((url) => url.startsWith(`${category},${name},`)))
      .find((url) => url !== undefined);
    if (!page) return { offer: null, similar: [], searchLinks: [{ source: SOURCE, url: category }] };

    const listings = await this.read<RockListing[]>(page, parseListings) ?? [];
    return { offer: selectListing(listings, part, page), similar: [], searchLinks: [{ source: SOURCE, url: page }] };
  }

  /** The catalog page for the vehicle's first listed engine; body parts are the same across engines. */
  private async engineUrl(make: string, year: string, model: string): Promise<string | null> {
    const direct = `${CATALOG}/${make},${year},${slug(model)}`;
    const engines = await this.read(direct, (html) => childLinks(html, direct, 2)) ?? [];
    if (engines.length) return engines[0];

    // The catalog may name the model differently ("Camry LE" is listed as "camry"): look it up on the year page.
    const yearUrl = `${CATALOG}/${make},${year}`;
    const models = await this.read(yearUrl, (html) => childLinks(html, yearUrl, 1)) ?? [];
    const matched = matchModel(models, model);
    if (!matched || matched === direct) return null;
    return (await this.read(matched, (html) => childLinks(html, matched, 2)) ?? [])[0] ?? null;
  }

  /** Fetches and parses a page, using the cache when fresh. Returns null on failure, which is not cached. */
  private async read<T>(url: string, parse: (html: string) => T): Promise<T | null> {
    const cached = this.cache.getCache<T>(url);
    if (cached && this.now() - cached.fetchedAt <= CACHE_MS) return cached.value;
    try {
      const value = parse(await this.fetcher.html(url));
      this.cache.setCache(url, value, this.now());
      return value;
    } catch (err) {
      console.warn(`Part price lookup could not read ${url}: ${err instanceof Error ? err.message : err}`);
      return null;
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
