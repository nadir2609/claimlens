import { ClaudeAnalyzer } from './claude';
import { DemoAnalyzer } from './demo';
import type { VisionAnalyzer } from './types';

export function createAnalyzer(config: { apiKey: string | undefined; model: string }): VisionAnalyzer {
  return config.apiKey ? ClaudeAnalyzer.fromApiKey(config.apiKey, config.model) : new DemoAnalyzer();
}

export type { PhotoInput, VisionAnalyzer } from './types';
