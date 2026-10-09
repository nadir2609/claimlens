import { join } from 'node:path';
import { createAnalyzer } from './analyzers';
import { createApp } from './app';
import { config } from './config';
import { EventBus } from './events';
import { FirecrawlFetcher, RockAutoLookup } from './parts/lookup';
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
  partLookup: config.firecrawlApiKey ? new RockAutoLookup(new FirecrawlFetcher(config.firecrawlApiKey), store) : undefined,
});

app.listen(config.port, () => {
  console.log(`ClaimLens API on http://localhost:${config.port} (analysis mode: ${analyzer.mode}, part prices: ${config.firecrawlApiKey ? 'live from rockauto.com and partsouq.com' : 'fallback table'})`);
});
