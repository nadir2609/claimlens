import type { Part, PartListing, PartOffer, PartSearchResult, SearchLink, VehicleInfo } from '@claimlens/shared';
import type { LookupCache, PageFetcher, PartLookup } from './lookup';

// Two Azerbaijani marketplaces, both read directly (no Firecrawl):
//   ehtiyathisseleri.az  classified listings, searched by free text; results are an HTML page
//   avtopro.az           shop catalogue with a JSON API, searched by a part word and filtered by make
// Their prices are in manat and are converted to US dollars for the report.

export const EHTIYAT = 'ehtiyathisseleri.az';
export const AVTOPRO = 'avtopro.az';
export const AVTOPRO_MAKES_URL = 'https://api.avtopro.az/api/car_makes';

/** The manat has been pegged at 1.70 to the US dollar since 2017. */
export const AZN_PER_USD = 1.7;
/** A body panel below this price (in AZN) is a placeholder ("1 Azn, call me") or a different item. */
export const MIN_PLAUSIBLE_AZN = 20;

const MAX_ALTERNATIVES = 4;
const MAX_SIMILAR = 3;
const AVTOPRO_PAGES = 3;
const CACHE_MS = 24 * 60 * 60 * 1000;

export interface LocalListing {
  title: string;
  azn: number;
  url: string;
  source: string;
}

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
  Headlights: { query: 'fara', names: ['fara'], not: ['duman', 'stop', 'yuyucu', 'suse', 'arxa'] },
  Doors: { query: 'qapı', names: ['qapi'], not: ['baqaj', 'suse', 'kart'] },
  Fenders: { query: 'qanad', names: ['qanad', 'krilo'], not: ['alti', 'qanadalt'] },
  Windshield: { query: 'ön şüşə', names: ['on suse', 'qabaq suse', 'lobovoy'] },
};

// Sellers list brackets, trims, seals and so on under the part's name. These words mark an accessory, not the part.
const ACCESSORY = [
  'berkidic', 'kant', 'barmaqli', 'petl', 'rezin', 'destey', 'destek', 'kilid', 'qoruyucu', 'sensor', 'emblem',
  'qapaq', 'motor', 'ablicovka', 'oblisovka', 'oblisofka', 'uzlu', 'ortu', 'duyme', 'guzgu', 'tros', 'kronsteyn',
  'nakladka', 'molding', 'ruck', 'body kit', 'amortizator', 'mexanizm', 'lampa', 'guclendirici', 'usilitel',
  'resotka', 'podkrilka', 'ehtiyat hisseleri', 'isiq', 'isig', 'tutacag', 'qayis', 'ogranic', 'absorber', 'pilnik',
  'odboynik', 'qarmag', 'aktuator', 'cerciv', 'deflektor', 'naqil', 'panel', 'altlig', 'yayi',
];
const FRONT = ['on', 'qabaq', 'qabax', 'front'];
const REAR = ['arxa', 'rear', 'dal'];

/** How sellers write a make, most common first. */
const MAKE_ALIASES: Record<string, string[]> = {
  'mercedes-benz': ['mercedes', 'mersedes', 'benz'],
  volkswagen: ['volkswagen', 'vw', 'folksvagen'],
  hyundai: ['hyundai', 'hunday', 'hundai'],
  chevrolet: ['chevrolet', 'sevrolet', 'chevy'],
  toyota: ['toyota', 'tayota'],
  lada: ['lada', 'vaz', 'jiquli'],
  'land rover': ['land rover', 'range rover'],
};
/** Makes whose usual search word differs from the name the vision model gives. */
const SEARCH_MAKE: Record<string, string> = { 'mercedes-benz': 'Mercedes' };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasWord = (folded: string, words: string[]) =>
  words.some((w) => new RegExp(`(^|[^a-z0-9])${escape(w)}([^a-z0-9]|$)`).test(folded));
const known = (value: string) => value.trim() !== '' && fold(value) !== 'unknown';
const round2 = (n: number) => Math.round(n * 100) / 100;

function makeNames(make: string): string[] {
  const folded = fold(make);
  return MAKE_ALIASES[folded] ?? [folded, ...(folded.includes(' ') ? [folded.split(' ')[0]] : [])].filter((n) => n.length >= 2);
}

function isPart(title: string, part: Part): boolean {
  const rule = PART_RULES[part];
  if (!rule.names.some((n) => title.includes(n))) return false;
  if (ACCESSORY.some((w) => title.includes(w)) || hasWord(title, ['yay'])) return false;
  if (rule.not?.some((w) => title.includes(w))) return false;
  if (rule.side) {
    const front = hasWord(title, FRONT);
    const rear = hasWord(title, REAR);
    // A title naming only the other end is the wrong part; naming both, or neither, is acceptable.
    if (rule.side === 'front' ? rear && !front : front && !rear) return false;
  }
  return true;
}

/**
 * Patterns for the model name as sellers may punctuate it ("UNI-V" is written "uni v" and "univ").
 * A bracketed body code counts as another name: "E-Class (W124)" matches a title that says only "W124".
 */
function modelPatterns(model: string): RegExp[] {
  const names = [model.replace(/\([^)]*\)/g, ' '), ...[...model.matchAll(/\(([^)]+)\)/g)].map((m) => m[1])];
  return names
    .map((name) => fold(name).split(/[^a-z0-9]+/).filter(Boolean))
    .filter((chunks) => chunks.join('').length >= 2)
    .map((chunks) => new RegExp(`(^|[^a-z0-9])${chunks.join('[^a-z0-9]*')}([^a-z0-9]|$)`));
}

/** Plausibly priced listings of the part itself, one per link, cheapest first. */
function partListings(listings: LocalListing[], part: Part): LocalListing[] {
  const unique = new Map<string, LocalListing>();
  for (const l of listings) {
    if (l.azn >= MIN_PLAUSIBLE_AZN && isPart(fold(l.title), part) && !unique.has(l.url)) unique.set(l.url, l);
  }
  return [...unique.values()].sort((a, b) => a.azn - b.azn);
}

const formatAzn = (azn: number) => `${round2(azn)} AZN`;
const toPartListing = (l: LocalListing): PartListing =>
  ({ title: l.title, price: round2(l.azn / AZN_PER_USD), listedPrice: formatAzn(l.azn), url: l.url, source: l.source });

/**
 * The offer is the cheapest listing whose title names the part, the make and the model. Listings for the make that
 * do not name the model may be for another model, so they are returned as `similar`: a reference, never charged.
 */
export function selectLocal(
  listings: LocalListing[], part: Part, vehicle: VehicleInfo,
): { offer: PartOffer | null; similar: PartListing[] } {
  if (!known(vehicle.make)) return { offer: null, similar: [] };
  const makes = makeNames(vehicle.make);
  const sameMake = partListings(listings, part).filter((l) => hasWord(fold(l.title), makes));
  const models = known(vehicle.model) ? modelPatterns(vehicle.model) : [];
  const sameModel = sameMake.filter((l) => models.some((m) => m.test(fold(l.title)))).map(toPartListing);
  if (sameModel.length) {
    return { offer: { cheapest: sameModel[0], alternatives: sameModel.slice(1, 1 + MAX_ALTERNATIVES) }, similar: [] };
  }
  return { offer: null, similar: sameMake.slice(0, MAX_SIMILAR).map(toPartListing) };
}

const EHTIYAT_ORIGIN = 'https://ehtiyathisseleri.az';
export const ehtiyatUrl = (query: string) => `${EHTIYAT_ORIGIN}/search/?query=${encodeURIComponent(query)}`;

const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, ' ').trim();

/** ehtiyathisseleri.az search results: one "prod" block per listing, with a title link and a price such as "115 Azn". */
export function parseEhtiyat(html: string): LocalListing[] {
  const listings: LocalListing[] = [];
  for (const block of html.split(/<div class="nobj prod\b/).slice(1)) {
    const link = /<a href="(\/[^"]+\.html)" title="([^"]*)"/.exec(block);
    const price = /class="sprice">\s*([\d\s.,]+)\s*Azn/i.exec(block);
    if (!link || !price) continue;
    const azn = Number(price[1].replace(/\s/g, '').replace(',', '.'));
    const title = decode(link[2]);
    if (title && Number.isFinite(azn)) listings.push({ title, azn, url: `${EHTIYAT_ORIGIN}${link[1]}`, source: EHTIYAT });
  }
  return listings;
}

export function avtoproApiUrl(query: string, makeId: number, page: number): string {
  return `https://api.avtopro.az/api/products?paginate=100&page=${page}&car_make_id=${makeId}&search=${encodeURIComponent(query)}`;
}

const avtoproSiteUrl = (query: string) => `https://www.avtopro.az/products?search=${encodeURIComponent(query)}`;

/**
 * One page of avtopro.az API results. Shops often leave the make out of the product name ("Bamper ön"), so the make
 * the search was filtered by is added to such titles. `more` says whether another page follows.
 */
export function parseAvtopro(json: string, makeName: string): { listings: LocalListing[]; more: boolean } {
  const page = (JSON.parse(json) as { data: { data: { id: number; product_name: string; price: string }[]; next_page_url: string | null } }).data;
  const makes = makeNames(makeName.replace(/\([^)]*\)/g, ' '));
  const listings = page.data.flatMap((p): LocalListing[] => {
    const name = p.product_name.replace(/\s+/g, ' ').trim();
    const azn = Number(p.price);
    if (!name || !Number.isFinite(azn)) return [];
    const slug = fold(name).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return [{
      title: hasWord(fold(name), makes) ? name : `${name} (${makeName})`,
      azn, url: `https://www.avtopro.az/products/${slug}-${p.id}`, source: AVTOPRO,
    }];
  });
  return { listings, more: page.next_page_url !== null };
}

export interface AvtoproMake {
  id: number;
  name: string;
}

/** The passenger-car makes avtopro.az knows; it keeps separate ids for trucks, motorcycles and so on. */
export function parseAvtoproMakes(json: string): AvtoproMake[] {
  const makes = (JSON.parse(json) as { data: { id: number; name: string; id_car_type: number }[] }).data;
  return makes.filter((m) => m.id_car_type === 1).map(({ id, name }) => ({ id, name }));
}

export function matchAvtoproMake(makes: AvtoproMake[], make: string): AvtoproMake | null {
  const names = makeNames(make);
  return makes.find((m) => fold(m.name) === fold(make))
    ?? makes.filter((m) => hasWord(fold(m.name), names)).sort((a, b) => a.name.length - b.name.length)[0]
    ?? null;
}

/** Prices a part from the local marketplaces. Every page read is cached for 24 hours. */
export class LocalLookup implements PartLookup {
  constructor(
    private readonly fetcher: PageFetcher,
    private readonly cache: LookupCache,
    private readonly now: () => number = Date.now,
  ) {}

  async find(part: Part, vehicle: VehicleInfo): Promise<PartSearchResult | null> {
    if (!known(vehicle.make)) return null;
    const { query } = PART_RULES[part];
    const make = SEARCH_MAKE[fold(vehicle.make)] ?? vehicle.make.trim();

    const ehtiyat = ehtiyatUrl(`${make} ${query}`);
    const listings = await this.read(ehtiyat, parseEhtiyat) ?? [];
    const searchLinks: SearchLink[] = [{ source: EHTIYAT, url: ehtiyat }];

    const avtoproMake = matchAvtoproMake(await this.read(AVTOPRO_MAKES_URL, parseAvtoproMakes) ?? [], vehicle.make);
    if (avtoproMake) {
      searchLinks.push({ source: AVTOPRO, url: avtoproSiteUrl(query) });
      for (let page = 1; page <= AVTOPRO_PAGES; page++) {
        const found = await this.read(avtoproApiUrl(query, avtoproMake.id, page), (json) => parseAvtopro(json, avtoproMake.name));
        listings.push(...found?.listings ?? []);
        if (!found?.more) break;
      }
    }

    const { offer, similar } = selectLocal(listings, part, vehicle);
    if (!offer && similar.length < MAX_SIMILAR) {
      // Nothing, or little, for this make: show what the part costs for other vehicles.
      const others = partListings(await this.read(ehtiyatUrl(query), parseEhtiyat) ?? [], part).map(toPartListing);
      for (const other of others) {
        if (similar.length < MAX_SIMILAR && !similar.some((s) => s.url === other.url)) similar.push(other);
      }
    }
    return { offer, similar, searchLinks };
  }

  /** Fetches and parses a page, using the cache when fresh. Returns null on failure, which is not cached. */
  private async read<T>(url: string, parse: (body: string) => T): Promise<T | null> {
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
