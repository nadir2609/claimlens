import { join } from 'node:path';
import { createAnalyzer } from './analyzers';
import { createApp } from './app';
import { config } from './config';
import { EventBus } from './events';
import { LocalLookup } from './parts/local';
import { DirectFetcher, FallbackLookup, FirecrawlFetcher, RockAutoLookup } from './parts/lookup';
import { ClaimStore } from './store';

const analyzer = createAnalyzer(config);
const store = new ClaimStore(join(config.dataDir, 'claims.db'));
const interrupted = store.failInterrupted();
if (interrupted) console.log(`Marked ${interrupted} interrupted claim(s) as failed; they can be retried.`);

const app = createApp({
  store,
  analyzer,
  events: new EventBus(),
  uploadsDir: config.uploadsDir,
  // Demo analysis is instant; pace the stages so the progress view is readable.
  stageDelayMs: analyzer.mode === 'demo' ? 450 : 0,
  clientDist: config.clientDist,
  // Local marketplaces first; RockAuto is asked only for parts they do not list, and only when a Firecrawl key is set.
  partLookup: new FallbackLookup([
    new LocalLookup(new DirectFetcher(), store),
    ...(config.firecrawlApiKey ? [new RockAutoLookup(new FirecrawlFetcher(config.firecrawlApiKey), store)] : []),
  ]),
});

app.listen(config.port, () => {
  console.log(`ClaimLens API on http://localhost:${config.port} (analysis mode: ${analyzer.mode}, part prices: ehtiyathisseleri.az and avtopro.az${config.firecrawlApiKey ? ', then rockauto.com and partsouq.com' : ''})`);
});
