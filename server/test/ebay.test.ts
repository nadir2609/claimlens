import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PartSearchResult, VehicleInfo } from '@claimlens/shared';
import { EbayApi, EbayFallbackLookup, ebayQuery, ebaySearchPage, selectEbay, type EbayItem } from '../src/parts/ebay';
import { ClaimStore } from '../src/store';

const lada: VehicleInfo = { make: 'LADA', model: 'Samara', year: '1990-2004', bodyType: 'Sedan', confidence: 0.9 };
const item = (title: string, value: number, currency = 'USD'): EbayItem =>
  ({ title, price: value, currency, url: `https://www.ebay.com/itm/${encodeURIComponent(title)}-${value}` });

describe('ebayQuery', () => {
  it('searches for the make, model and part, without the year', () => {
    expect(ebayQuery('Front Bumper', lada)).toBe('LADA Samara front bumper');
    expect(ebayQuery('Headlights', { ...lada, make: 'Toyota', model: 'Camry' })).toBe('Toyota Camry headlight');
  });

  it('links to the same search on the eBay site', () => {
    expect(ebaySearchPage('LADA Samara front bumper')).toBe('https://www.ebay.com/sch/i.html?_nkw=LADA%20Samara%20front%20bumper&_sacat=6028');
  });
});

describe('selectEbay', () => {
  it('returns matching parts cheapest first, as listings from ebay.com', () => {
    const found = selectEbay([item('Lada Samara 2108 front bumper new', 120), item('LADA SAMARA Front Bumper OEM', 95)], 'Front Bumper', lada);
    expect(found.map((l) => l.price)).toEqual([95, 120]);
    expect(found[0]).toEqual({ title: 'LADA SAMARA Front Bumper OEM', price: 95, source: 'ebay.com', url: item('LADA SAMARA Front Bumper OEM', 95).url });
  });

  it('drops accessories, scale models and manuals that mention the part', () => {
    const found = selectEbay([
      item('Lada Samara front bumper bracket left', 25), item('Lada Samara front bumper grille trim', 30),
      item('Lada Samara 1:43 diecast model front bumper', 40), item('Lada Samara repair manual bumper', 22),
      item('Lada Samara front bumper', 150),
    ], 'Front Bumper', lada);
    expect(found.map((l) => l.price)).toEqual([150]);
  });

  it('drops other makes, other currencies and implausibly cheap listings', () => {
    expect(selectEbay([
      item('Toyota Camry front bumper', 90), item('Lada Samara front bumper', 80, 'EUR'), item('Lada Samara front bumper', 5),
    ], 'Front Bumper', lada)).toEqual([]);
  });

  it('keeps front and rear bumpers apart', () => {
    const items = [item('Lada Samara rear bumper', 70), item('Lada Samara front bumper', 90), item('Lada Samara bumper front and rear set', 200)];
    expect(selectEbay(items, 'Front Bumper', lada).map((l) => l.price)).toEqual([90, 200]);
    expect(selectEbay(items, 'Rear Bumper', lada).map((l) => l.price)).toEqual([70, 200]);
  });

  it('recognises a Lada sold as VAZ, and prefers listings that name the model', () => {
    expect(selectEbay([item('VAZ 2109 hood bonnet', 110)], 'Hood', lada)).toHaveLength(1);
    const found = selectEbay([item('Lada Niva hood', 60), item('Lada Samara hood', 130)], 'Hood', lada);
    expect(found.map((l) => l.price)).toEqual([130]);
  });

  it('matches each part by its usual names', () => {
    const toyota = { ...lada, make: 'Toyota', model: 'Camry' };
    expect(selectEbay([item('Toyota Camry headlamp assembly left', 80)], 'Headlights', toyota)).toHaveLength(1);
    expect(selectEbay([item('Toyota Camry front fender right', 80)], 'Fenders', toyota)).toHaveLength(1);
    expect(selectEbay([item('Toyota Camry windscreen glass', 180)], 'Windshield', toyota)).toHaveLength(1);
    expect(selectEbay([item('Toyota Camry front door shell left', 300)], 'Doors', toyota)).toHaveLength(1);
    expect(selectEbay([item('Toyota Camry door handle', 30), item('Toyota Camry door panel trim', 60)], 'Doors', toyota)).toEqual([]);
  });

  it('returns nothing for an unknown make', () => {
    expect(selectEbay([item('front bumper', 90)], 'Front Bumper', { ...lada, make: 'Unknown' })).toEqual([]);
  });
});

describe('EbayFallbackLookup', () => {
  const rockPage = { source: 'rockauto.com', url: 'https://www.rockauto.com/en/catalog/lada,1990,samara' };
  const nothing: PartSearchResult = { offer: null, similar: [], searchLinks: [rockPage] };
  const priced: PartSearchResult = {
    offer: { cheapest: { title: 'TECHPRO X', price: 70, url: 'https://www.rockauto.com/x', source: 'rockauto.com' }, alternatives: [] },
    similar: [], searchLinks: [rockPage],
  };
  const ebay = (items: EbayItem[] | Error = [item('Lada Samara front bumper', 95), item('Lada Samara front bumper used', 60)]) =>
    ({ search: vi.fn(async () => { if (items instanceof Error) throw items; return items; }) });

  it('leaves a priced result alone and does not call eBay', async () => {
    const client = ebay();
    const lookup = new EbayFallbackLookup({ find: async () => priced }, client, new ClaimStore(':memory:'));
    expect(await lookup.find('Front Bumper', lada)).toEqual(priced);
    expect(client.search).not.toHaveBeenCalled();
  });

  it('prices the part from eBay when the first source has no listing, keeping both links', async () => {
    const client = ebay();
    const found = await new EbayFallbackLookup({ find: async () => nothing }, client, new ClaimStore(':memory:')).find('Front Bumper', lada);
    expect(client.search).toHaveBeenCalledWith('LADA Samara front bumper');
    expect(found!.offer!.cheapest).toMatchObject({ price: 60, source: 'ebay.com' });
    expect(found!.offer!.alternatives.map((a) => a.price)).toEqual([95]);
    expect(found!.searchLinks).toEqual([rockPage, { source: 'ebay.com', url: ebaySearchPage('LADA Samara front bumper') }]);
  });

  it('works when the vehicle is not in the first source at all, or there is no first source', async () => {
    const viaNull = await new EbayFallbackLookup({ find: async () => null }, ebay(), new ClaimStore(':memory:')).find('Front Bumper', lada);
    expect(viaNull!.offer!.cheapest.price).toBe(60);
    const alone = await new EbayFallbackLookup(null, ebay(), new ClaimStore(':memory:')).find('Front Bumper', lada);
    expect(alone!.offer!.cheapest.price).toBe(60);
    expect(alone!.searchLinks).toHaveLength(1);
  });

  it('still links the eBay search when nothing there matches', async () => {
    const found = await new EbayFallbackLookup({ find: async () => nothing }, ebay([item('Lada Samara bumper bracket', 30)]), new ClaimStore(':memory:')).find('Front Bumper', lada);
    expect(found!.offer).toBeNull();
    expect(found!.searchLinks.map((l) => l.source)).toEqual(['rockauto.com', 'ebay.com']);
  });

  it('returns the first source\'s result unchanged when eBay fails, and does not cache the failure', async () => {
    const client = ebay(new Error('503'));
    const lookup = new EbayFallbackLookup({ find: async () => nothing }, client, new ClaimStore(':memory:'));
    expect(await lookup.find('Front Bumper', lada)).toEqual(nothing);
    await lookup.find('Front Bumper', lada);
    expect(client.search).toHaveBeenCalledTimes(2);
  });

  it('caches eBay results for 24 hours', async () => {
    let now = 1_000_000;
    const client = ebay();
    const lookup = new EbayFallbackLookup(null, client, new ClaimStore(':memory:'), () => now);
    await lookup.find('Front Bumper', lada);
    await lookup.find('Front Bumper', lada);
    expect(client.search).toHaveBeenCalledTimes(1);
    now += 24 * 3600 * 1000 + 1;
    await lookup.find('Front Bumper', lada);
    expect(client.search).toHaveBeenCalledTimes(2);
  });

  it('does not search for an unknown make or model', async () => {
    const client = ebay();
    const lookup = new EbayFallbackLookup(null, client, new ClaimStore(':memory:'));
    expect(await lookup.find('Hood', { ...lada, make: 'Unknown' })).toBeNull();
    expect(await lookup.find('Hood', { ...lada, model: 'Unknown' })).toBeNull();
    expect(client.search).not.toHaveBeenCalled();
  });
});

describe('EbayApi', () => {
  afterEach(() => vi.unstubAllGlobals());
  const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status });
  const searchBody = { itemSummaries: [
    { title: 'Lada Samara front bumper', price: { value: '95.50', currency: 'USD' }, itemWebUrl: 'https://www.ebay.com/itm/1' },
    { title: 'No price listed' },
  ] };

  it('gets an application token, then searches eBay Motors parts on the US site', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ access_token: 'tok', expires_in: 7200 }))
      .mockResolvedValueOnce(json(searchBody));
    vi.stubGlobal('fetch', fetchMock);

    const items = await new EbayApi('id', 'secret').search('LADA Samara front bumper');
    expect(items).toEqual([{ title: 'Lada Samara front bumper', price: 95.5, currency: 'USD', url: 'https://www.ebay.com/itm/1' }]);

    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0];
    expect(tokenUrl).toBe('https://api.ebay.com/identity/v1/oauth2/token');
    expect(tokenInit.headers.Authorization).toBe(`Basic ${Buffer.from('id:secret').toString('base64')}`);
    expect(String(tokenInit.body)).toContain('grant_type=client_credentials');

    const [searchUrl, searchInit] = fetchMock.mock.calls[1];
    const url = new URL(searchUrl);
    expect(url.origin + url.pathname).toBe('https://api.ebay.com/buy/browse/v1/item_summary/search');
    expect(url.searchParams.get('q')).toBe('LADA Samara front bumper');
    expect(url.searchParams.get('category_ids')).toBe('6028');
    expect(searchInit.headers.Authorization).toBe('Bearer tok');
    expect(searchInit.headers['X-EBAY-C-MARKETPLACE-ID']).toBe('EBAY_US');
  });

  it('reuses the token for later searches', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ access_token: 'tok', expires_in: 7200 }))
      .mockImplementation(async () => json({ itemSummaries: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new EbayApi('id', 'secret');
    await api.search('a');
    expect(await api.search('b')).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('reports rejected credentials and failed searches clearly', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'invalid_client' }, 401)));
    await expect(new EbayApi('id', 'bad').search('a')).rejects.toThrow(/EBAY_CLIENT_ID/);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ access_token: 'tok', expires_in: 7200 })).mockResolvedValueOnce(json({}, 500)));
    await expect(new EbayApi('id', 'secret').search('a')).rejects.toThrow(/500/);
  });
});
