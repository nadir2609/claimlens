import { join } from 'node:path';
import { createAnalyzer } from './analyzers';
import { createApp } from './app';
import { config } from './config';
import { EventBus } from './events';
import { EbayApi, EbayFallbackLookup } from './parts/ebay';
import { FirecrawlFetcher, RockAutoLookup, type PartLookup } from './parts/lookup';
import { ClaimStore } from './store';

const analyzer = createAnalyzer(config);
const store = new ClaimStore(join(config.dataDir, 'claims.db'));
const interrupted = store.failInterrupted();
if (interrupted) console.log(`Marked ${interrupted} interrupted claim(s) as failed; they can be retried.`);

// Part prices: RockAuto and PartSouq (through Firecrawl) first, then eBay for anything they do not stock.
const catalogs = config.firecrawlApiKey ? new RockAutoLookup(new FirecrawlFetcher(config.firecrawlApiKey), store) : null;
const ebay = config.ebayClientId && config.ebayClientSecret ? new EbayApi(config.ebayClientId, config.ebayClientSecret) : null;
const partLookup: PartLookup | undefined = ebay ? new EbayFallbackLookup(catalogs, ebay, store) : catalogs ?? undefined;
const priceSources = [...(catalogs ? ['rockauto.com', 'partsouq.com'] : []), ...(ebay ? ['ebay.com'] : [])];

const app = createApp({
  store,
  analyzer,
  events: new EventBus(),
  uploadsDir: config.uploadsDir,
  // Demo analysis is instant; pace the stages so the progress view is readable.
  stageDelayMs: analyzer.mode === 'demo' ? 450 : 0,
  clientDist: config.clientDist,
  partLookup,
});

app.listen(config.port, () => {
  console.log(`ClaimLens API on http://localhost:${config.port} (analysis mode: ${analyzer.mode}, part prices: ${priceSources.length ? `live from ${priceSources.join(', ')}` : 'fallback table'})`);
});
