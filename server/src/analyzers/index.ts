import { ClaudeAnalyzer } from './claude';
import { DemoAnalyzer } from './demo';
import { GeminiAnalyzer } from './gemini';
import type { VisionAnalyzer } from './types';

export interface AnalyzerConfig {
  geminiApiKey: string | undefined;
  geminiModel: string;
  apiKey: string | undefined;
  model: string;
}

/** Gemini if its key is set, otherwise Claude if its key is set, otherwise simulated results. */
export function createAnalyzer(config: AnalyzerConfig): VisionAnalyzer {
  if (config.geminiApiKey) return GeminiAnalyzer.fromApiKey(config.geminiApiKey, config.geminiModel);
  if (config.apiKey) return ClaudeAnalyzer.fromApiKey(config.apiKey, config.model);
  return new DemoAnalyzer();
}

export type { PhotoInput, VisionAnalyzer } from './types';
