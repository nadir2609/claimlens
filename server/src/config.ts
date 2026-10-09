import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

try { process.loadEnvFile(resolve(root, '.env')); } catch { /* no .env file: demo mode */ }

export const config = {
  port: Number(process.env.PORT ?? 3001),
  geminiApiKey: process.env.GEMINI_API_KEY?.trim() || undefined,
  geminiModel: process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash',
  apiKey: process.env.ANTHROPIC_API_KEY?.trim() || undefined,
  model: process.env.CLAUDE_MODEL?.trim() || 'claude-opus-5-5',
  dataDir: resolve(root, 'server/data'),
  uploadsDir: resolve(root, 'server/uploads'),
  clientDist: resolve(root, 'client/dist'),
};

mkdirSync(config.dataDir, { recursive: true });
mkdirSync(config.uploadsDir, { recursive: true });
