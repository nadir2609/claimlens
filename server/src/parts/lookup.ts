import type { DamageItem, Part, PartListing, PartSearchResult, SearchLink, VehicleInfo } from '@claimlens/shared';
import { needsReplacement } from '../pipeline/cost';
import { PARTSOUQ, parsePartsouq, partsouqUrl, type PartsouqResult } from './partsouq';
import {
  BODY_CATEGORY, CATALOG, PART_TYPES, SOURCE, childLinks, firstYear, matchListings, matchModel, oemCandidates,
  parseListings, slug, toOffer, toPartListing, type RockListing,
} from './rockauto';

/** Returns a page's body: HTML, or JSON text from an API. Tests substitute a fake. */
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

/** Plain HTTP, for sites that serve their pages to any client. */
export class DirectFetcher implements PageFetcher {
  async html(url: string): Promise<string> {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClaimLens/1.0)', Accept: 'text/html,application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`${new URL(url).hostname} returned ${res.status}`);
    return res.text();
  }
}

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
 * Finds the cheapest listing for a part of a specific vehicle. Aftermarket parts come from RockAuto, by walking its
 * catalog: model page -> first engine -> body category -> part type page. The genuine part is then priced on
 * PartSouq by part number. Every page read is cached for 24 hours.
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

    const matched = matchListings(await this.read<RockListing[]>(page, parseListings) ?? [], part);
    const listings: PartListing[] = matched.map((l) => toPartListing(l, page));
    const searchLinks: SearchLink[] = [{ source: SOURCE, url: page }];

    const genuine = await this.genuine(matched, vehicle.make);
    if (genuine) searchLinks.push({ source: PARTSOUQ, url: genuine.url });
    return { offer: toOffer(listings, genuine), similar: [], searchLinks };
  }

  /**
   * The genuine part on PartSouq. PartSouq is searched by part number, so this uses the car maker's number that the
   * cheapest RockAuto listings say they replace, and accepts a result only when PartSouq files it under the same make.
   */
  private async genuine(matched: RockListing[], make: string): Promise<PartListing | null> {
    const wanted = make.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const number of oemCandidates(matched.slice(0, 3).flatMap((l) => l.oemNumbers))) {
      const url = partsouqUrl(number);
      const result = await this.read<PartsouqResult | null>(url, parsePartsouq);
      const filedUnder = result?.make.toLowerCase().replace(/[^a-z0-9]/g, '') ?? '';
      if (result && filedUnder && (wanted.includes(filedUnder) || filedUnder.includes(wanted))) {
        return { title: `${result.make} genuine ${result.partNumber}, ${result.name}`, price: result.price, url, source: PARTSOUQ };
      }
    }
    return null;
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

/**
 * Asks each source in turn and stops at the first that has an offer, so a later source is only used (and only costs
 * time or credits) when the earlier ones list nothing. Links and reference listings from every source asked are kept.
 */
export class FallbackLookup implements PartLookup {
  constructor(private readonly sources: PartLookup[]) {}

  async find(part: Part, vehicle: VehicleInfo): Promise<PartSearchResult | null> {
    const similar: PartListing[] = [];
    const searchLinks: SearchLink[] = [];
    let asked = false;
    for (const source of this.sources) {
      let found: PartSearchResult | null = null;
      try {
        found = await source.find(part, vehicle);
      } catch (err) {
        console.warn(`Part price lookup failed for ${part}: ${err instanceof Error ? err.message : err}`);
      }
      if (!found) continue;
      asked = true;
      searchLinks.push(...found.searchLinks);
      if (found.offer) return { offer: found.offer, similar: [], searchLinks };
      similar.push(...found.similar);
    }
    return asked ? { offer: null, similar, searchLinks } : null;
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
