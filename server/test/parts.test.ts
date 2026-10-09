import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { DamageItem, PartListing, VehicleInfo } from '@claimlens/shared';
import { PartPriceLookup, findOffers, searchUrls, type PageFetcher } from '../src/parts/lookup';
import { selectOffer, selectSimilar } from '../src/parts/match';
import { parseAvtopro, parseEhtiyat } from '../src/parts/parsers';
import { ClaimStore } from '../src/store';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, 'fixtures', name), 'utf8');
const mazda: VehicleInfo = { make: 'Mazda', model: 'CX-7', year: '2010', bodyType: 'SUV', confidence: 0.9 };
const listing = (title: string, price: number, source = 'avtopro.az'): PartListing =>
  ({ title, price, url: `https://example.test/${encodeURIComponent(title)}-${price}`, source });

describe('listing parsers', () => {
  it('reads title, price and link from an avtopro.az results page', () => {
    const items = parseAvtopro(fixture('avtopro-bamper-mazda.md'));
    expect(items).toHaveLength(7);
    expect(items[0]).toEqual({
      title: 'Ön bamper Mazda CX-7', price: 417.61, source: 'avtopro.az',
      url: 'https://www.avtopro.az/products/on-bamper-mazda-cx-7-207408',
    });
    expect(items.every((i) => i.price > 0 && i.url.startsWith('https://www.avtopro.az/products/'))).toBe(true);
  });

  it('reads title, price and link from an ehtiyathisseleri.az results page', () => {
    const items = parseEhtiyat(fixture('ehtiyat-bamper.md'));
    expect(items.length).toBeGreaterThan(5);
    const sonata = items.find((i) => i.title === 'Hyundai Sonata ön buferi')!;
    expect(sonata).toMatchObject({ source: 'ehtiyathisseleri.az', url: 'https://ehtiyathisseleri.az/hyundai-sonata-on-buferi-665.html' });
    expect(sonata.price).toBeGreaterThan(0);
    const rio = items.find((i) => i.title.startsWith('Kia Rio 2018-2020'))!;
    expect(rio.price).toBe(99);
    expect(new Set(items.map((i) => i.url)).size).toBe(items.length);
  });

  it('returns nothing for a page with no listings', () => {
    expect(parseAvtopro('# Nothing here')).toEqual([]);
    expect(parseEhtiyat('Sizin sorğunuza uyğun nəticə tapılmadı.')).toEqual([]);
  });
});

describe('selectOffer', () => {
  it('picks the cheapest listing for the right part, side and make', () => {
    const offer = selectOffer(parseAvtopro(fixture('avtopro-bamper-mazda.md')), 'Front Bumper', { ...mazda, model: 'Unknown' });
    expect(offer!.cheapest.title).toBe('Ön bamper Mazda CX-7');
    expect(offer!.cheapest.price).toBe(417.61);
    expect(offer!.alternatives.map((a) => a.price)).toEqual([514.55, 587.26]);
  });

  it('prefers listings that name the model when any do', () => {
    const offer = selectOffer(parseAvtopro(fixture('avtopro-bamper-mazda.md')), 'Front Bumper', { ...mazda, model: 'CX-9' });
    expect(offer!.cheapest.title).toBe('Ön bamper Mazda CX-9');
    expect(offer!.alternatives).toEqual([]);
  });

  it('keeps rear bumpers out of a front bumper search and the other way round', () => {
    const rear = selectOffer(parseAvtopro(fixture('avtopro-bamper-mazda.md')), 'Rear Bumper', { ...mazda, model: 'Unknown' });
    expect(rear!.cheapest.price).toBe(107.04);
    expect([rear!.cheapest, ...rear!.alternatives].every((l) => l.title.startsWith('Arxa'))).toBe(true);
  });

  it('ignores brackets, trims and other accessories that mention the part', () => {
    const offer = selectOffer([
      listing('Bamper bərkidicisi ön Mazda', 23),
      listing('Bamper kantı ön sağ Mazda', 25),
      listing('Mazda Büfer Ablicovka', 30),
      listing('Ön bamper Mazda', 500),
    ], 'Front Bumper', mazda);
    expect(offer!.cheapest.price).toBe(500);
    expect(offer!.alternatives).toEqual([]);
  });

  it('ignores other makes, listings with no make, and implausibly cheap prices', () => {
    expect(selectOffer([listing('Ön bamper Toyota', 300), listing('Ön bamper', 200), listing('Ön bamper Mazda', 1)], 'Front Bumper', mazda)).toBeNull();
  });

  it('understands seller spellings: "bufer" for bumper, and a listing covering both sides', () => {
    const hyundai = { ...mazda, make: 'Hyundai', model: 'Sonata' };
    const items = [listing('Hyundai Sonata ön buferi', 150, 'ehtiyathisseleri.az'), listing('Hyundai, Kia ön və arxa buferləri', 200, 'ehtiyathisseleri.az')];
    expect(selectOffer(items, 'Front Bumper', hyundai)!.cheapest.price).toBe(150);
    expect(selectOffer(items, 'Rear Bumper', hyundai)!.cheapest.price).toBe(200);
  });

  it('matches doors but not door glass or the boot lid, and matches common make spellings', () => {
    const merc = { ...mazda, make: 'Mercedes-Benz', model: 'Unknown' };
    const offer = selectOffer([
      listing('Qapı şüşəsi arxa Mercedes', 80), listing('Baqaj qapısı Mercedes', 90), listing('Qapı arxa sağ Mersedes', 900),
    ], 'Doors', merc);
    expect(offer!.cheapest.price).toBe(900);
  });

  it('ignores covers and linings in their inflected spellings', () => {
    const merc = { ...mazda, make: 'Mercedes-Benz', model: 'Unknown' };
    expect(selectOffer([listing('Mercedes W213 2016-22 kapot üzlüyü', 70), listing('Mercedes kapot örtüyü', 60)], 'Hood', merc)).toBeNull();
  });

  it('recognises a Lada listed as VAZ', () => {
    const lada = { ...mazda, make: 'Lada', model: 'Samara' };
    expect(selectOffer([listing('VAZ 2109 ön bamper', 80)], 'Front Bumper', lada)!.cheapest.price).toBe(80);
  });

  it('offers the same part for other vehicles as a reference when asked, cheapest first, at most three', () => {
    const similar = selectSimilar([
      listing('Ön bamper Toyota', 300), listing('Bamper bərkidicisi ön', 10), listing('Arxa bamper Kia', 90),
      listing('Hyundai Sonata ön buferi', 145), listing('Ön bamper Mazda', 500), listing('Ön bamper BMW', 900),
    ], 'Front Bumper');
    expect(similar.map((l) => l.price)).toEqual([145, 300, 500]);
  });

  it('returns null for an unknown make', () => {
    expect(selectOffer([listing('Ön bamper Mazda', 500)], 'Front Bumper', { ...mazda, make: 'Unknown' })).toBeNull();
  });
});

describe('PartPriceLookup', () => {
  const pages: Record<string, string> = {};
  const [avtoproUrl, ehtiyatUrl] = searchUrls('Front Bumper', 'Mazda');
  pages[avtoproUrl] = fixture('avtopro-bamper-mazda.md');
  pages[ehtiyatUrl] = fixture('ehtiyat-bamper.md');
  const fetcher = (): PageFetcher & { markdown: ReturnType<typeof vi.fn> } =>
    ({ markdown: vi.fn(async (url: string) => pages[url] ?? '') });

  it('builds search URLs that include the part and the make', () => {
    expect(avtoproUrl).toBe('https://www.avtopro.az/products?search=bamper%20Mazda');
    expect(ehtiyatUrl).toBe('https://ehtiyathisseleri.az/search/?query=bamper%20Mazda');
  });

  it('searches with the spelling sellers use for the make', () => {
    expect(searchUrls('Hood', 'Mercedes-Benz')[0]).toBe('https://www.avtopro.az/products?search=kapot%20mercedes');
  });

  it('searches both sites and returns the cheapest match across them', async () => {
    const f = fetcher();
    const lookup = new PartPriceLookup(f, new ClaimStore(':memory:'));
    const found = await lookup.find('Front Bumper', { ...mazda, model: 'Unknown' });
    expect(f.markdown).toHaveBeenCalledTimes(2);
    expect(found!.offer!.cheapest).toMatchObject({ price: 417.61, source: 'avtopro.az' });
    expect(found!.searchLinks).toEqual([
      { source: 'avtopro.az', url: avtoproUrl }, { source: 'ehtiyathisseleri.az', url: ehtiyatUrl },
    ]);
  });

  it('when nothing is listed for the make, returns no offer but links the same part for other vehicles', async () => {
    const f = fetcher();
    f.markdown.mockImplementation(async (url: string) => (url.includes('avtopro') ? fixture('avtopro-bamper-mazda.md') : ''));
    const found = await new PartPriceLookup(f, new ClaimStore(':memory:')).find('Front Bumper', { ...mazda, make: 'Lada', model: 'Samara' });
    expect(found!.offer).toBeNull();
    expect(found!.similar.map((l) => l.title)).toEqual(['Ön bamper Mazda CX-7', 'Ön bamper Mazda', 'Ön bamper Mazda CX-9']);
    expect(found!.searchLinks[0].url).toBe('https://www.avtopro.az/products?search=bamper%20lada');
  });

  it('serves repeat lookups from the cache, and refetches after 24 hours', async () => {
    let now = 1_000_000;
    const f = fetcher();
    const lookup = new PartPriceLookup(f, new ClaimStore(':memory:'), () => now);
    await lookup.find('Front Bumper', mazda);
    await lookup.find('Rear Bumper', mazda);
    expect(f.markdown).toHaveBeenCalledTimes(2);
    now += 24 * 3600 * 1000 + 1;
    await lookup.find('Front Bumper', mazda);
    expect(f.markdown).toHaveBeenCalledTimes(4);
  });

  it('still answers from one site when the other fails, and does not cache the failure', async () => {
    const f = fetcher();
    f.markdown.mockImplementation(async (url: string) => {
      if (url === ehtiyatUrl) throw new Error('timeout');
      return pages[url];
    });
    const lookup = new PartPriceLookup(f, new ClaimStore(':memory:'));
    expect((await lookup.find('Front Bumper', mazda))!.offer!.cheapest.price).toBe(417.61);
    await lookup.find('Front Bumper', mazda);
    expect(f.markdown.mock.calls.filter(([u]) => u === ehtiyatUrl)).toHaveLength(2);
    expect(f.markdown.mock.calls.filter(([u]) => u === avtoproUrl)).toHaveLength(1);
  });

  it('does not search at all when the make is unknown', async () => {
    const f = fetcher();
    expect(await new PartPriceLookup(f, new ClaimStore(':memory:')).find('Hood', { ...mazda, make: 'Unknown' })).toBeNull();
    expect(f.markdown).not.toHaveBeenCalled();
  });
});

describe('findOffers', () => {
  const item = (part: DamageItem['part'], severity: DamageItem['severity']): DamageItem =>
    ({ id: `${part}-x`, part, type: 'Dent', severity, score: 1, photoIds: ['p1'] });

  it('looks up only parts that will be replaced, once each, and survives a failing lookup', async () => {
    const find = vi.fn(async (part: string) => {
      if (part === 'Hood') throw new Error('boom');
      return { offer: { cheapest: listing(`${part} Mazda`, 100), alternatives: [] }, similar: [], searchLinks: [] };
    });
    const offers = await findOffers({ find }, [item('Front Bumper', 'High'), item('Front Bumper', 'High'), item('Hood', 'High'), item('Doors', 'Low')], mazda);
    expect(find.mock.calls.map(([p]) => p)).toEqual(['Front Bumper', 'Hood']);
    expect(Object.keys(offers)).toEqual(['Front Bumper']);
  });
});
