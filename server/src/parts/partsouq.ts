// PartSouq sells genuine (car maker) parts and can only be searched by part number or VIN, not by part name.

export const PARTSOUQ = 'partsouq.com';

export interface PartsouqResult {
  name: string;
  partNumber: string;
  make: string;
  /** The cheapest offer on the page, in US dollars. */
  price: number;
}

export const partsouqUrl = (partNumber: string) => `https://partsouq.com/en/search/all?q=${encodeURIComponent(partNumber)}`;

/** Reads a part-number search result. Null when nothing was found or prices are not shown in USD. */
export function parsePartsouq(html: string): PartsouqResult | null {
  // The page title reads "<NAME> <PART NUMBER> | <Make> Parts | PartSouq" when the part exists.
  const title = /<title>\s*(.+?)\s+([A-Z0-9-]{5,})\s*\|\s*(.+?)\s+Parts\s*\|\s*PartSouq\s*<\/title>/i.exec(html);
  const currency = /product:price:currency[^>]*content="([^"]*)"/.exec(html)?.[1];
  if (!title || currency !== 'USD') return null;
  const prices = [...html.matchAll(/class="search-product-price">\s*([\d,]+\.?\d*)/g)]
    .map(([, p]) => Number(p.replace(/,/g, '')))
    .filter((p) => Number.isFinite(p) && p > 0);
  if (!prices.length) return null;
  return { name: title[1].trim(), partNumber: title[2], make: title[3].trim(), price: Math.min(...prices) };
}
