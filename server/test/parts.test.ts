import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { DamageItem, VehicleInfo } from '@claimlens/shared';
import { FirecrawlFetcher, RockAutoLookup, findOffers, type PageFetcher } from '../src/parts/lookup';
import { parsePartsouq, partsouqUrl } from '../src/parts/partsouq';
import { firstYear, oemCandidates, parseListings, toOffer } from '../src/parts/rockauto';
import { ClaimStore } from '../src/store';

const here = dirname(fileURLToPath(import.meta.url));
const listingPage = readFileSync(join(here, 'fixtures', 'rockauto-bumper-cover.html'), 'utf8');
const partsouqPage = readFileSync(join(here, 'fixtures', 'partsouq-result.html'), 'utf8');
const rockautoCalls = (html: { mock: { calls: unknown[][] } }) => html.mock.calls.map(([u]) => String(u)).filter((u) => u.includes('rockauto.com'));

const BASE = 'https://www.rockauto.com/en/catalog';
const MODEL = `${BASE}/toyota,2012,camry`;
const ENGINE = `${MODEL},2.5l+l4,1502610`;
const CATEGORY = `${ENGINE},body+&+lamp+assembly`;
const BUMPER = `${CATEGORY},bumper+cover,1344`;
const HOOD = `${CATEGORY},hood,1396`;
// Page HTML escapes "&" in links, as the real site does.
const links = (...urls: string[]) => urls.map((u) => `<a href="${u.replace(/&/g, '&amp;')}">x</a>`).join('\n');

const camry: VehicleInfo = { make: 'Toyota', model: 'Camry', year: '2012', bodyType: 'Sedan', confidence: 0.9 };

function site(overrides: Record<string, string | Error> = {}) {
  const pages: Record<string, string | Error> = {
    [MODEL]: links(`${BASE}/toyota,2012`, ENGINE, `${MODEL},3.5l+v6,1502609`),
    [CATEGORY]: links(BUMPER, `${CATEGORY},bumper+bracket,12236`, HOOD, `${CATEGORY},hood+hinge,813`, `${CATEGORY},headlamp+assembly,10762`, `${CATEGORY},fender,1380`),
    [BUMPER]: listingPage,
    ...overrides,
  };
  const html = vi.fn(async (url: string) => {
    const page = pages[url] ?? '';
    if (page instanceof Error) throw page;
    return page;
  });
  return { fetcher: { html } satisfies PageFetcher, html };
}

describe('RockAuto page parsing', () => {
  it('reads manufacturer, part number, fitment note, price and link from a listing page', () => {
    const items = parseListings(listingPage);
    expect(items).toHaveLength(8);
    expect(items[0]).toMatchObject({ manufacturer: 'VARIOUS MFR', partNumber: 'TO1100296', description: 'Primed (Customer Paints to Match)', price: 51.79 });
    expect(items[0].note).toMatch(/^Rear; /);
    expect(items[0].infoUrl).toBe('https://www.rockauto.com/en/moreinfo.php?pk=3660768&cc=1502610&pt=1344');
    expect(items.every((i) => i.price > 0)).toBe(true);
    expect(items.find((i) => i.partNumber === 'TO1000378')!.oemNumbers).toContain('5211906974');
  });

  it('ranks the numbers most likely to be the car maker\'s own part number first, skipping aftermarket codes', () => {
    expect(oemCandidates(['S1077B101BP0N', 'TY04402BB', 'TY4161390A0', '5211906974', 'TO1000378C', 'TO1000378DSC']))
      .toEqual(['5211906974', 'TY4161390A0']);
    expect(oemCandidates(['86511F2000', 'HY1000216'])).toEqual(['86511F2000']);
    expect(oemCandidates([])).toEqual([]);
  });

  it('returns nothing for a page without listings', () => {
    expect(parseListings('<html><body>No parts</body></html>')).toEqual([]);
  });

  it('takes the first year from a single year or a range', () => {
    expect(firstYear('2012')).toBe('2012');
    expect(firstYear('2019-2022')).toBe('2019');
    expect(firstYear('Unknown')).toBeNull();
  });
});

describe('toOffer', () => {
  const l = (price: number, source = 'rockauto.com') => ({ title: `p${price}`, price, url: `https://x.test/${price}`, source });

  it('always keeps the genuine part in view, even when four cheaper listings exist', () => {
    const genuine = l(900, 'partsouq.com');
    const offer = toOffer([l(50), l(60), l(70), l(80), l(90), l(100)], genuine)!;
    expect(offer.cheapest.price).toBe(50);
    expect(offer.alternatives.map((a) => a.price)).toEqual([60, 70, 80, 900]);
  });

  it('lets the genuine part be the cheapest, and works with no genuine part or no listings', () => {
    expect(toOffer([l(50), l(60)], l(40, 'partsouq.com'))!.cheapest.source).toBe('partsouq.com');
    expect(toOffer([l(60), l(50)])!.alternatives.map((a) => a.price)).toEqual([60]);
    expect(toOffer([])).toBeNull();
  });
});

describe('PartSouq page parsing', () => {
  it('reads the part name, number, make and cheapest price in USD', () => {
    expect(parsePartsouq(partsouqPage)).toEqual({ name: 'COVER, FRONT BUMPER', partNumber: '5211906975', make: 'Toyota', price: 258.19 });
  });

  it('returns null when nothing was found or the price is not in USD', () => {
    expect(parsePartsouq('<html><head><title>Search | PartSouq</title></head><body><b>Nothing found.</b></body></html>')).toBeNull();
    expect(parsePartsouq(partsouqPage.replace('content="USD"', 'content="AED"'))).toBeNull();
  });
});

describe('RockAutoLookup', () => {
  it('walks model, engine and category pages and returns the cheapest front bumper with a link', async () => {
    const { fetcher, html } = site();
    const found = await new RockAutoLookup(fetcher, new ClaimStore(':memory:')).find('Front Bumper', camry);

    expect(rockautoCalls(html)).toEqual([MODEL, CATEGORY, BUMPER]);
    expect(found!.offer!.cheapest).toMatchObject({
      title: 'VARIOUS MFR TO1000378, Primed (Customer Paints to Match) (Front; L Model or LE Model or XLE Model)',
      price: 71.79, source: 'rockauto.com',
    });
    expect(found!.offer!.cheapest.url).toMatch(/^https:\/\/www\.rockauto\.com\/en\/moreinfo\.php\?pk=\d+&cc=1502610&pt=1344$/);
    expect(found!.offer!.alternatives.map((a) => a.price)).toEqual([74.79, 159.89, 212.99]);
    expect(found!.searchLinks).toEqual([{ source: 'rockauto.com', url: BUMPER }]);
  });

  it('separates rear from front, and reuses cached pages for the second part', async () => {
    const { fetcher, html } = site();
    const lookup = new RockAutoLookup(fetcher, new ClaimStore(':memory:'));
    await lookup.find('Front Bumper', camry);
    const rear = await lookup.find('Rear Bumper', camry);
    expect(rear!.offer!.cheapest.price).toBe(51.79);
    expect(rear!.offer!.cheapest.title).toContain('Rear;');
    expect(rockautoCalls(html)).toHaveLength(3);
  });

  it('refetches after 24 hours', async () => {
    let now = 1_000_000;
    const { fetcher, html } = site();
    const lookup = new RockAutoLookup(fetcher, new ClaimStore(':memory:'), () => now);
    await lookup.find('Front Bumper', camry);
    now += 24 * 3600 * 1000 + 1;
    await lookup.find('Front Bumper', camry);
    expect(rockautoCalls(html)).toHaveLength(6);
  });

  it('uses the first year of a range', async () => {
    const { fetcher } = site();
    const found = await new RockAutoLookup(fetcher, new ClaimStore(':memory:')).find('Front Bumper', { ...camry, year: '2012-2014' });
    expect(found!.offer!.cheapest.price).toBe(71.79);
  });

  it('finds the model on the year page when the name does not match the catalog exactly', async () => {
    const { fetcher, html } = site({ [`${BASE}/toyota,2012`]: links(`${BASE}/toyota,2012,corolla`, MODEL, `${BASE}/toyota,2012,camry+hybrid`) });
    const found = await new RockAutoLookup(fetcher, new ClaimStore(':memory:')).find('Front Bumper', { ...camry, model: 'Camry LE' });
    expect(found!.offer!.cheapest.price).toBe(71.79);
    expect(rockautoCalls(html).slice(0, 3)).toEqual([`${BASE}/toyota,2012,camry+le`, `${BASE}/toyota,2012`, MODEL]);
  });

  it('gives the part page link but no offer when that page has no listings', async () => {
    const { fetcher } = site();
    const found = await new RockAutoLookup(fetcher, new ClaimStore(':memory:')).find('Hood', camry);
    expect(found).toEqual({ offer: null, similar: [], searchLinks: [{ source: 'rockauto.com', url: HOOD }] });
  });

  it('links the body category when the catalog has no such part type for the vehicle', async () => {
    const { fetcher } = site();
    const found = await new RockAutoLookup(fetcher, new ClaimStore(':memory:')).find('Windshield', camry);
    expect(found).toEqual({ offer: null, similar: [], searchLinks: [{ source: 'rockauto.com', url: CATEGORY }] });
  });

  it('does not confuse a part with its accessories (hood is not hood hinge)', async () => {
    const { fetcher, html } = site();
    await new RockAutoLookup(fetcher, new ClaimStore(':memory:')).find('Hood', camry);
    expect(rockautoCalls(html).at(-1)).toBe(HOOD);
  });

  it('also prices the genuine part on PartSouq, using the maker\'s part number from the RockAuto listing', async () => {
    const genuine = partsouqUrl('5211906974');
    const { fetcher, html } = site({ [genuine]: partsouqPage });
    const lookup = new RockAutoLookup(fetcher, new ClaimStore(':memory:'));
    const found = await lookup.find('Front Bumper', camry);

    expect(genuine).toBe('https://partsouq.com/en/search/all?q=5211906974');
    expect(found!.offer!.cheapest).toMatchObject({ price: 71.79, source: 'rockauto.com' });
    expect(found!.offer!.alternatives.map((a) => a.price)).toEqual([74.79, 159.89, 212.99, 258.19]);
    expect(found!.offer!.alternatives.at(-1)).toEqual({
      title: 'Toyota genuine 5211906975, COVER, FRONT BUMPER', price: 258.19, url: genuine, source: 'partsouq.com',
    });
    expect(found!.searchLinks).toEqual([{ source: 'rockauto.com', url: BUMPER }, { source: 'partsouq.com', url: genuine }]);

    const before = html.mock.calls.length;
    await lookup.find('Front Bumper', camry);
    expect(html.mock.calls.length).toBe(before);
  });

  it('ignores a PartSouq result for a different make, and keeps the RockAuto price when PartSouq fails', async () => {
    const genuine = partsouqUrl('5211906974');
    const wrongMake = site({ [genuine]: partsouqPage.replace(/Toyota Parts/, 'Nissan Parts') });
    const a = await new RockAutoLookup(wrongMake.fetcher, new ClaimStore(':memory:')).find('Front Bumper', camry);
    expect(a!.offer!.alternatives.every((l) => l.source === 'rockauto.com')).toBe(true);

    const down = site({ [genuine]: new Error('blocked') });
    const b = await new RockAutoLookup(down.fetcher, new ClaimStore(':memory:')).find('Front Bumper', camry);
    expect(b!.offer!.cheapest.price).toBe(71.79);
    expect(b!.searchLinks).toEqual([{ source: 'rockauto.com', url: BUMPER }]);
  });

  it('tries at most two part numbers on PartSouq per part', async () => {
    const { fetcher, html } = site();
    await new RockAutoLookup(fetcher, new ClaimStore(':memory:')).find('Front Bumper', camry);
    expect(html.mock.calls.filter(([u]) => String(u).includes('partsouq.com'))).toHaveLength(2);
  });

  it('returns null without searching when the make or year is unknown, and when the vehicle is not in the catalog', async () => {
    const { fetcher, html } = site();
    const lookup = new RockAutoLookup(fetcher, new ClaimStore(':memory:'));
    expect(await lookup.find('Hood', { ...camry, make: 'Unknown' })).toBeNull();
    expect(await lookup.find('Hood', { ...camry, year: 'Unknown' })).toBeNull();
    expect(html).not.toHaveBeenCalled();
    expect(await lookup.find('Hood', { ...camry, make: 'Lada', model: 'Samara', year: '1995' })).toBeNull();
  });

  it('does not cache a failed page, so the next lookup tries again', async () => {
    const { fetcher, html } = site({ [BUMPER]: new Error('timeout') });
    const lookup = new RockAutoLookup(fetcher, new ClaimStore(':memory:'));
    expect((await lookup.find('Front Bumper', camry))!.offer).toBeNull();
    await lookup.find('Front Bumper', camry);
    expect(html.mock.calls.filter(([u]) => u === BUMPER)).toHaveLength(2);
    expect(html.mock.calls.filter(([u]) => u === MODEL)).toHaveLength(1);
  });
});

describe('findOffers', () => {
  const item = (part: DamageItem['part'], severity: DamageItem['severity']): DamageItem =>
    ({ id: `${part}-x`, part, type: 'Dent', severity, score: 1, photoIds: ['p1'] });

  it('looks up only parts that will be replaced, once each, and survives a failing lookup', async () => {
    const find = vi.fn(async (part: string) => {
      if (part === 'Hood') throw new Error('boom');
      return { offer: null, similar: [], searchLinks: [{ source: 'rockauto.com', url: `https://example.test/${part}` }] };
    });
    const offers = await findOffers({ find }, [item('Front Bumper', 'High'), item('Front Bumper', 'High'), item('Hood', 'High'), item('Doors', 'Low')], camry);
    expect(find.mock.calls.map(([p]) => p)).toEqual(['Front Bumper', 'Hood']);
    expect(Object.keys(offers)).toEqual(['Front Bumper']);
  });
});

describe('FirecrawlFetcher', () => {
  const reply = (status: number, body: object = {}) => new Response(JSON.stringify(body), { status });

  it('waits and retries when Firecrawl rate-limits the request', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply(429))
      .mockResolvedValueOnce(reply(200, { data: { rawHtml: '<html>ok</html>' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      expect(await new FirecrawlFetcher('key', 0).html('https://www.rockauto.com/en/catalog/toyota')).toBe('<html>ok</html>');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('gives up after repeated rate limits, and does not retry other errors', async () => {
    const limited = vi.fn().mockResolvedValue(reply(429));
    vi.stubGlobal('fetch', limited);
    try {
      await expect(new FirecrawlFetcher('key', 0).html('https://x.test')).rejects.toThrow(/429/);
      expect(limited).toHaveBeenCalledTimes(3);
      const broken = vi.fn().mockResolvedValue(reply(500));
      vi.stubGlobal('fetch', broken);
      await expect(new FirecrawlFetcher('key', 0).html('https://x.test')).rejects.toThrow(/500/);
      expect(broken).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
