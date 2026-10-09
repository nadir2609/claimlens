import { describe, expect, it, vi } from 'vitest';
import type { PartSearchResult, VehicleInfo } from '@claimlens/shared';
import {
  AVTOPRO, AVTOPRO_MAKES_URL, EHTIYAT, LocalLookup, avtoproApiUrl, ehtiyatUrl, fold, matchAvtoproMake,
  parseAvtopro, parseAvtoproMakes, parseEhtiyat, selectLocal, type LocalListing,
} from '../src/parts/local';
import { FallbackLookup, type PageFetcher, type PartLookup } from '../src/parts/lookup';
import { ClaimStore } from '../src/store';

// Markup as served by ehtiyathisseleri.az search pages.
const ehtiyatItem = (path: string, title: string, price: string) => `<div class="nobj prod prodbig"><div class="holderimg">
  <a href="${path}" title="${title}"><img src="/uploads/news/x.jpg" alt="${title}"></a></div>
  <div class="prodname"><a href="${path}" title="${title}">${title}</a></div>
  <p class="prodful">Toyota Fara Body Kapot Krilo bufer buferler</p>${price ? `<span class="sprice">${price}</span>` : ''} </div>`;

const doorsPage = [
  ehtiyatItem('/toyota-corolla-cross-sag-qabaq-qapisi-932.html', 'Toyota Corolla Cross sağ qabaq qapısı', '1100 Azn'),
  ehtiyatItem('/toyota-corolla-arxa-qapi-12.html', 'Toyota Corolla arxa qapı', '300 Azn'),
  ehtiyatItem('/toyota-corolla-cross-qapi-desteyi-7.html', 'Toyota Corolla Cross qapı dəstəyi', '70 Azn'),
  ehtiyatItem('/toyota-corolla-cross-qapi-55.html', 'Toyota Corolla Cross qapı', '1 Azn'),
  ehtiyatItem('/toyota-prado-qapi-90.html', 'Toyota Prado qapı', ''),
  ehtiyatItem('/byd-destroyer-05-qapilari-41.html', 'Byd Destroyer 05 qapıları', '555 Azn'),
].join('\n');

// Shape of api.avtopro.az responses.
const avtoproPage = (names: [id: number, name: string, price: string][], next = false) => JSON.stringify({
  success: true,
  data: { current_page: 1, data: names.map(([id, product_name, price]) => ({ id, product_name, price })), next_page_url: next ? 'x' : null },
});
const makesJson = JSON.stringify({ success: true, data: [
  { id: 344, name: 'Mazda', id_car_type: 2 }, { id: 113, name: 'Mazda', id_car_type: 1 },
  { id: 215, name: 'VAZ (Lada)', id_car_type: 1 }, { id: 116, name: 'Mercedes-Benz', id_car_type: 1 },
  { id: 176, name: 'Toyota', id_car_type: 1 },
] });

const cross: VehicleInfo = { make: 'Toyota', model: 'Corolla Cross', year: '2022', bodyType: 'SUV', confidence: 0.9 };
const univ: VehicleInfo = { make: 'Changan', model: 'UNI-V', year: '2022-2024', bodyType: 'Sedan', confidence: 0.9 };

const listing = (title: string, azn: number, n = 1): LocalListing => ({ title, azn, url: `https://ehtiyathisseleri.az/${n}.html`, source: EHTIYAT });

function site(pages: Record<string, string | Error>) {
  const html = vi.fn(async (url: string) => {
    const page = pages[url];
    if (page === undefined) return '';
    if (page instanceof Error) throw page;
    return page;
  });
  return { fetcher: { html } satisfies PageFetcher, html };
}

describe('local site parsing', () => {
  it('folds Azerbaijani letters so spellings compare equal', () => {
    expect(fold('Sağ  qabaq QAPISI')).toBe('sag qabaq qapisi');
    expect(fold('Ön şüşə')).toBe('on suse');
  });

  it('reads title, price in AZN and link from ehtiyathisseleri.az, skipping listings without a price', () => {
    const items = parseEhtiyat(doorsPage);
    expect(items).toHaveLength(5);
    expect(items[0]).toEqual({
      title: 'Toyota Corolla Cross sağ qabaq qapısı', azn: 1100,
      url: 'https://ehtiyathisseleri.az/toyota-corolla-cross-sag-qabaq-qapisi-932.html', source: EHTIYAT,
    });
    expect(parseEhtiyat('<html><body>Sizin sorğunuza uyğun nəticə tapılmadı</body></html>')).toEqual([]);
  });

  it('reads avtopro.az products, naming the make the search was filtered by when the title lacks it', () => {
    const { listings, more } = parseAvtopro(avtoproPage([[230653, 'Bamper ön Mazda', '1067.17'], [7, 'Bamper kantı ön', '43.66']], true), 'Mazda');
    expect(more).toBe(true);
    expect(listings).toEqual([
      { title: 'Bamper ön Mazda', azn: 1067.17, url: 'https://www.avtopro.az/products/bamper-on-mazda-230653', source: AVTOPRO },
      { title: 'Bamper kantı ön (Mazda)', azn: 43.66, url: 'https://www.avtopro.az/products/bamper-kanti-on-7', source: AVTOPRO },
    ]);
    expect(() => parseAvtopro('<html>blocked</html>', 'Mazda')).toThrow();
  });

  it('finds the passenger-car make id on avtopro.az, including Lada listed as "VAZ (Lada)"', () => {
    const makes = parseAvtoproMakes(makesJson);
    expect(matchAvtoproMake(makes, 'Mazda')).toEqual({ id: 113, name: 'Mazda' });
    expect(matchAvtoproMake(makes, 'LADA')).toEqual({ id: 215, name: 'VAZ (Lada)' });
    expect(matchAvtoproMake(makes, 'mercedes-benz')?.id).toBe(116);
    expect(matchAvtoproMake(makes, 'Changan')).toBeNull();
  });
});

describe('selectLocal', () => {
  it('charges the cheapest listing that names the part, make and model, converted to US dollars', () => {
    const { offer, similar } = selectLocal(parseEhtiyat(doorsPage), 'Doors', cross);
    expect(offer!.cheapest).toEqual({
      title: 'Toyota Corolla Cross sağ qabaq qapısı', price: 647.06, listedPrice: '1100 AZN',
      url: 'https://ehtiyathisseleri.az/toyota-corolla-cross-sag-qabaq-qapisi-932.html', source: EHTIYAT,
    });
    expect(offer!.alternatives).toEqual([]);
    expect(similar).toEqual([]);
  });

  it('keeps a listing for another model of the same make as a reference only', () => {
    const corolla: VehicleInfo = { ...cross, model: 'Camry' };
    const { offer, similar } = selectLocal(parseEhtiyat(doorsPage), 'Doors', corolla);
    expect(offer).toBeNull();
    expect(similar.map((l) => l.title)).toEqual(['Toyota Corolla arxa qapı', 'Toyota Corolla Cross sağ qabaq qapısı']);
  });

  it('rejects accessories, placeholder prices and the wrong end of the car', () => {
    const titles = (part: Parameters<typeof selectLocal>[1], ...items: LocalListing[]) =>
      [selectLocal(items, part, cross).offer].flatMap((o) => (o ? [o.cheapest, ...o.alternatives] : [])).map((l) => l.title);
    expect(titles('Doors', listing('Toyota Corolla Cross qapı dəstəyi', 70, 1), listing('Toyota Corolla Cross qapı', 1, 2),
      listing('Toyota Corolla Cross baqaj qapısı', 900, 3), listing('Toyota Corolla Cross qapı işıqları', 25, 4))).toEqual([]);
    expect(titles('Front Bumper', listing('Toyota Corolla Cross arxa bamper', 200, 1), listing('Toyota Corolla Cross ön bamper', 300, 2),
      listing('Toyota Corolla Cross bamper bərkidicisi ön', 30, 3), listing('Bamper deflektoru Toyota Corolla Cross', 60, 4),
      listing('Bamper naqilləri ön Toyota Corolla Cross', 146, 5), listing('Toyota Corolla Cross bufer altlığı', 60, 6))).toEqual(['Toyota Corolla Cross ön bamper']);
    expect(titles('Hood', listing('Kapot paneli Toyota Corolla Cross', 30, 1), listing('Kapot yayı Toyota Corolla Cross', 38, 2))).toEqual([]);
    expect(titles('Fenders', listing('Toyota Corolla Cross - Qanad Altlığı', 35, 1), listing('Qanadaltı ön sol Toyota Corolla Cross', 760, 2),
      listing('Toyota Corolla Cross ön sol qanad', 420, 3))).toEqual(['Toyota Corolla Cross ön sol qanad']);
    expect(titles('Headlights', listing('Toyota Corolla Cross fara', 400, 1), listing('Toyota Corolla Cross duman farası', 90, 2)))
      .toEqual(['Toyota Corolla Cross fara']);
  });

  it('matches the model however sellers punctuate it, and not a different model with a similar name', () => {
    const items = [listing('Changan uni v qapı', 800, 1), listing('Changan Uni-Z qapı', 500, 2), listing('Changan UNI-V arxa qapı', 900, 3)];
    const { offer, similar } = selectLocal(items, 'Doors', univ);
    expect([offer!.cheapest.title, ...offer!.alternatives.map((l) => l.title)]).toEqual(['Changan uni v qapı', 'Changan UNI-V arxa qapı']);
    expect(similar).toEqual([]);
    const w124: VehicleInfo = { make: 'Mercedes-Benz', model: 'E-Class (W124)', year: '1990', bodyType: 'Sedan', confidence: 0.9 };
    expect(selectLocal([listing('Mercedes w124 kapot', 250)], 'Hood', w124).offer!.cheapest.price).toBe(147.06);
  });
});

describe('LocalLookup', () => {
  const eh = (query: string) => ehtiyatUrl(query);
  const lookup = (pages: Record<string, string | Error>, now = () => 1_000) => {
    const s = site(pages);
    return { ...s, lookup: new LocalLookup(s.fetcher, new ClaimStore(':memory:'), now) };
  };

  it('searches both sites and returns the cheapest listing with links to check', async () => {
    const { lookup: l, html } = lookup({
      [eh('Toyota qapı')]: doorsPage,
      [AVTOPRO_MAKES_URL]: makesJson,
      [avtoproApiUrl('qapı', 176, 1)]: avtoproPage([[5, 'Qapı ön sol Toyota Corolla Cross', '850.00'], [6, 'Qapı kantı', '40']]),
    });
    const found = await l.find('Doors', cross);
    expect(found!.offer!.cheapest).toMatchObject({ source: AVTOPRO, price: 500, listedPrice: '850 AZN', url: 'https://www.avtopro.az/products/qapi-on-sol-toyota-corolla-cross-5' });
    expect(found!.offer!.alternatives.map((a) => a.source)).toEqual([EHTIYAT]);
    expect(found!.searchLinks).toEqual([
      { source: EHTIYAT, url: eh('Toyota qapı') },
      { source: AVTOPRO, url: 'https://www.avtopro.az/products?search=qap%C4%B1' },
    ]);
    expect(html).toHaveBeenCalledTimes(3);
  });

  it('reads further avtopro.az pages while there are more, up to three', async () => {
    const { lookup: l, html } = lookup({
      [AVTOPRO_MAKES_URL]: makesJson,
      [avtoproApiUrl('kapot', 176, 1)]: avtoproPage([[1, 'Kapot kilidi Toyota', '151']], true),
      [avtoproApiUrl('kapot', 176, 2)]: avtoproPage([[2, 'Kapot Toyota Corolla Cross', '680']], true),
      [avtoproApiUrl('kapot', 176, 3)]: avtoproPage([[3, 'Kapot amortizatoru', '14']], true),
    });
    expect((await l.find('Hood', cross))!.offer!.cheapest.price).toBe(400);
    expect(html.mock.calls.map(([u]) => u)).not.toContain(avtoproApiUrl('kapot', 176, 4));
  });

  it('when nothing is listed for the make, gives the same part for other vehicles as a reference', async () => {
    const { lookup: l } = lookup({ [eh('Changan qapı')]: ehtiyatItem('/changan-q07-eylec-bendi-1.html', 'Changan Q07 - Ön Əyləc Bəndi', '90 AZN'), [AVTOPRO_MAKES_URL]: makesJson, [eh('qapı')]: doorsPage });
    const found = await l.find('Doors', univ);
    expect(found!.offer).toBeNull();
    expect(found!.similar.map((s) => s.title)).toEqual(['Toyota Corolla arxa qapı', 'Byd Destroyer 05 qapıları', 'Toyota Corolla Cross sağ qabaq qapısı']);
    expect(found!.similar[0]).toMatchObject({ price: 176.47, listedPrice: '300 AZN' });
    // Changan is not a make avtopro.az lists, so only the site that was searched is linked.
    expect(found!.searchLinks).toEqual([{ source: EHTIYAT, url: eh('Changan qapı') }]);
  });

  it('keeps one site\'s prices when the other fails, caches pages for 24 hours, and does not cache failures', async () => {
    let now = 1_000;
    const { lookup: l, html } = lookup({ [eh('Toyota qapı')]: doorsPage, [AVTOPRO_MAKES_URL]: new Error('down') }, () => now);
    expect((await l.find('Doors', cross))!.offer!.cheapest.source).toBe(EHTIYAT);
    await l.find('Doors', cross);
    expect(html.mock.calls.filter(([u]) => u === eh('Toyota qapı'))).toHaveLength(1);
    expect(html.mock.calls.filter(([u]) => u === AVTOPRO_MAKES_URL)).toHaveLength(2);
    now += 24 * 60 * 60 * 1000 + 1;
    await l.find('Doors', cross);
    expect(html.mock.calls.filter(([u]) => u === eh('Toyota qapı'))).toHaveLength(2);
  });

  it('searches for Lada as sellers list it, and returns null without searching when the make is unknown', async () => {
    const { lookup: l, html } = lookup({});
    expect(await l.find('Hood', { ...cross, make: 'Unknown' })).toBeNull();
    expect(html).not.toHaveBeenCalled();
    await l.find('Hood', { ...cross, make: 'Lada', model: 'Samara' });
    expect(html.mock.calls[0][0]).toBe(eh('Lada kapot'));
  });
});

describe('FallbackLookup', () => {
  const result = (source: string, offer: boolean): PartSearchResult => ({
    offer: offer ? { cheapest: { title: 't', price: 10, url: `https://${source}/1`, source }, alternatives: [] } : null,
    similar: offer ? [] : [{ title: 'ref', price: 5, url: `https://${source}/ref`, source }],
    searchLinks: [{ source, url: `https://${source}/search` }],
  });
  const source = (r: PartSearchResult | null | Error) => ({ find: vi.fn(async () => { if (r instanceof Error) throw r; return r; }) }) satisfies PartLookup;

  it('uses the first source that has an offer and does not ask the ones after it', async () => {
    const [a, b] = [source(result('a.az', true)), source(result('b.com', true))];
    const found = await new FallbackLookup([a, b]).find('Hood', cross);
    expect(found!.offer!.cheapest.source).toBe('a.az');
    expect(b.find).not.toHaveBeenCalled();
  });

  it('moves on when a source has no offer or fails, keeping every link and reference gathered on the way', async () => {
    const found = await new FallbackLookup([source(result('a.az', false)), source(new Error('down')), source(result('c.com', true))]).find('Hood', cross);
    expect(found!.offer!.cheapest.source).toBe('c.com');
    expect(found!.searchLinks.map((l) => l.source)).toEqual(['a.az', 'c.com']);
    expect(found!.similar).toEqual([]);

    const none = await new FallbackLookup([source(result('a.az', false)), source(null)]).find('Hood', cross);
    expect(none).toMatchObject({ offer: null, similar: [{ title: 'ref' }], searchLinks: [{ source: 'a.az' }] });
    expect(await new FallbackLookup([source(null)]).find('Hood', cross)).toBeNull();
  });
});
