import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { VisionResult } from '@claimlens/shared';
import { modelImage } from '../images';
import { systemPrompt } from './prompt';
import { VisionOutputSchema, sanitizeVision } from './schema';
import type { PhotoInput, VisionAnalyzer } from './types';

/** The slice of the Anthropic client this analyzer uses, so tests can substitute a fake. */
export interface ParseClient {
  messages: { parse(params: any): Promise<{ stop_reason: string | null; parsed_output: unknown }> };
}

const SYSTEM = systemPrompt(
  'bbox: a tight box around the damaged region, as fractions of the image width and height (0 to 1), with x and y at the top-left corner.',
);

export class ClaudeAnalyzer implements VisionAnalyzer {
  readonly mode = 'claude' as const;

  constructor(private readonly client: ParseClient, private readonly model: string) {}

  static fromApiKey(apiKey: string, model: string): ClaudeAnalyzer {
    return new ClaudeAnalyzer(new Anthropic({ apiKey, timeout: 120_000, maxRetries: 1 }) as unknown as ParseClient, model);
  }

  async analyze(photos: PhotoInput[]): Promise<VisionResult> {
    const content: Anthropic.ContentBlockParam[] = [];
    for (const photo of photos) {
      content.push({ type: 'text', text: `Photo id: ${photo.id}` });
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await modelImage(photo.image) } });
    }
    content.push({ type: 'text', text: `Assess these ${photos.length} photos. Return one entry per photo id.` });

    let response: Awaited<ReturnType<ParseClient['messages']['parse']>>;
    try {
      response = await this.client.messages.parse({
        model: this.model,
        max_tokens: 16000,
        system: SYSTEM,
        messages: [{ role: 'user', content }],
        output_config: { effort: 'medium', format: zodOutputFormat(VisionOutputSchema) },
      });
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) throw new Error('Claude API key was rejected. Check ANTHROPIC_API_KEY.');
      if (err instanceof Anthropic.RateLimitError) throw new Error('Claude API rate limit reached. Retry in a moment.');
      if (err instanceof Anthropic.APIConnectionError) throw new Error('Could not reach the Claude API. Check the network and retry.');
      if (err instanceof Anthropic.APIError) throw new Error(`Claude API error (${err.status ?? 'unknown'}): ${err.message}`);
      // Anything else is the SDK failing to parse the structured output (for example a truncated response).
      throw new Error('Model returned an invalid analysis');
    }

    if (response.stop_reason === 'refusal') throw new Error('The model declined to analyse these photos');
    if (!response.parsed_output) throw new Error('Model returned an invalid analysis');
    return sanitizeVision(response.parsed_output, photos.map((p) => p.id));
  }
}
