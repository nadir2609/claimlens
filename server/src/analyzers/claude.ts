import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { DAMAGE_TYPES, PARTS, type VisionResult } from '@claimlens/shared';
import { modelImage } from '../images';
import { VisionOutputSchema, sanitizeVision } from './schema';
import type { PhotoInput, VisionAnalyzer } from './types';

/** The slice of the Anthropic client this analyzer uses, so tests can substitute a fake. */
export interface ParseClient {
  messages: { parse(params: any): Promise<{ stop_reason: string | null; parsed_output: unknown }> };
}

const SYSTEM = `You assess vehicle damage for an insurance claims system. You receive several photos of what should be one vehicle. Each photo is preceded by a line giving its photo id.

For each photo report:
- angle: the viewpoint. Use "detail" for close-ups where the overall viewpoint cannot be determined.
- visibleParts: which of these parts are visible well enough to inspect: ${PARTS.join(', ')}. Leave a part out if it is hidden, cropped away, or too small to judge.
- damages: every damaged region you can actually see. Do not infer damage that is out of view. If the same damage appears in several photos, report it in each one.
  - part: one of the parts above. type: one of ${DAMAGE_TYPES.join(', ')}.
  - severity: Low = cosmetic, surface only. Medium = clear damage that needs bodywork but the part is repairable. High = the part is structurally compromised or needs replacing.
  - bbox: a tight box around the damaged region, as fractions of the image width and height (0 to 1), with x and y at the top-left corner.
  - confidence: 0 to 1. note: one short sentence describing what you see.

For the vehicle give your best estimate of make, model, year (a single year or a range such as "2019-2022") and body type. Use "Unknown" for anything you cannot determine. confidence is 0 to 1.

fraudObservations: add an entry only when it is clearly evident. vehicle_mismatch: the photos show different vehicles. screen_recapture: a photo is a picture of a screen or of a printed photo. damage_inconsistency: damage visible in one photo is clearly absent from another photo of the same area. Otherwise return an empty list.

An undamaged vehicle is a valid result: return empty damages lists.`;

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
