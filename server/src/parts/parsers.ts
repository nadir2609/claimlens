import type { PartListing } from '@claimlens/shared';

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
const toPrice = (s: string) => Number(s.replace(/\s/g, '').replace(',', '.'));

/**
 * avtopro.az results (as markdown): each product is an image link whose alt text is the full title,
 * followed by the price in bold. Prices on the site are in AZN.
 */
export function parseAvtopro(markdown: string): PartListing[] {
  const pattern = /\[!\[([^\]]*)\]\([^)]*\)\]\((https:\/\/www\.avtopro\.az\/products\/[^)\s]+)\)\s+\*\*([\d\s.,]+)\*\*/g;
  const seen = new Set<string>();
  const items: PartListing[] = [];
  for (const [, title, url, price] of markdown.matchAll(pattern)) {
    const value = toPrice(price);
    if (seen.has(url) || !clean(title) || !Number.isFinite(value)) continue;
    seen.add(url);
    items.push({ title: clean(title), price: value, url, source: 'avtopro.az' });
  }
  return items;
}

/**
 * ehtiyathisseleri.az results (as markdown): a title link to a ".html" listing, some description lines,
 * then a line such as "115 Azn". Listings without a price are skipped.
 */
export function parseEhtiyat(markdown: string): PartListing[] {
  const titleLink = /^\[([^\]!][^\]]*)\]\((https:\/\/ehtiyathisseleri\.az\/[^)\s]+\.html)/;
  const priceLine = /^([\d\s.,]+)\s*Azn\s*$/i;
  const seen = new Set<string>();
  const items: PartListing[] = [];
  let current: { title: string; url: string } | null = null;
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    const link = titleLink.exec(line);
    if (link) {
      current = { title: clean(link[1]), url: link[2] };
      continue;
    }
    const price = priceLine.exec(line);
    if (price && current) {
      const value = toPrice(price[1]);
      if (!seen.has(current.url) && Number.isFinite(value)) {
        seen.add(current.url);
        items.push({ ...current, price: value, source: 'ehtiyathisseleri.az' });
      }
      current = null;
    }
  }
  return items;
}
