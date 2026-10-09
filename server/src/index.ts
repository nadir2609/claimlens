import { join } from 'node:path';
import { createAnalyzer } from './analyzers';
import { createApp } from './app';
import { config } from './config';
import { EventBus } from './events';
import { ClaimStore } from './store';

const analyzer = createAnalyzer(config);
const app = createApp({
  store: new ClaimStore(join(config.dataDir, 'claims.db')),
  analyzer,
  events: new EventBus(),
  uploadsDir: config.uploadsDir,
  // Demo analysis is instant; pace the stages so the progress view is readable.
  stageDelayMs: analyzer.mode === 'demo' ? 450 : 0,
  clientDist: config.clientDist,
});

app.listen(config.port, () => {
  console.log(`ClaimLens API on http://localhost:${config.port} (analysis mode: ${analyzer.mode})`);
});
