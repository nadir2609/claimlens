import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import {
  ANGLES, DAMAGE_TYPES, FRAUD_OBSERVATION_KINDS, PARTS, SEVERITIES, type VisionResult,
} from '@claimlens/shared';
import { modelImage } from '../images';
import { systemPrompt } from './prompt';
import { sanitizeVision } from './schema';
import type { PhotoInput, VisionAnalyzer } from './types';

/** The slice of the Google GenAI client this analyzer uses, so tests can substitute a fake. */
export interface GenerateClient {
  models: {
    generateContent(params: any): Promise<{ text?: string; promptFeedback?: { blockReason?: string } }>;
  };
}

// Gemini is trained to locate objects as [ymin, xmin, ymax, xmax] on a 0-1000 scale, so ask for that
// and convert, rather than asking for the report's own box format.
const GeminiOutputSchema = z.object({
  vehicle: z.object({
    make: z.string(), model: z.string(), year: z.string(), bodyType: z.string(), confidence: z.number(),
  }),
  photos: z.array(z.object({
    photoId: z.string(),
    angle: z.enum(ANGLES),
    visibleParts: z.array(z.enum(PARTS)),
    damages: z.array(z.object({
      part: z.enum(PARTS),
      type: z.enum(DAMAGE_TYPES),
      severity: z.enum(SEVERITIES),
      box_2d: z.array(z.number()),
      confidence: z.number(),
      note: z.string(),
    })),
  })),
  fraudObservations: z.array(z.object({ kind: z.enum(FRAUD_OBSERVATION_KINDS), detail: z.string() })),
});

const SYSTEM = systemPrompt(
  'box_2d: a tight box around the damaged region as [ymin, xmin, ymax, xmax], each normalised to 0-1000 relative to the image height and width.',
);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Rewrites each damage's box_2d as the { x, y, width, height } fractions the shared sanitizer expects. */
function convertBoxes(raw: unknown): unknown {
  if (!isRecord(raw) || !Array.isArray(raw.photos)) return raw;
  for (const photo of raw.photos) {
    if (!isRecord(photo) || !Array.isArray(photo.damages)) continue;
    for (const damage of photo.damages) {
      if (!isRecord(damage)) continue;
      const box = damage.box_2d;
      if (Array.isArray(box) && box.length === 4 && box.every((n) => typeof n === 'number')) {
        const [yMin, xMin, yMax, xMax] = box as number[];
        damage.bbox = { x: xMin / 1000, y: yMin / 1000, width: (xMax - xMin) / 1000, height: (yMax - yMin) / 1000 };
      }
    }
  }
  return raw;
}

export class GeminiAnalyzer implements VisionAnalyzer {
  readonly mode = 'gemini' as const;

  constructor(private readonly client: GenerateClient, private readonly model: string) {}

  static fromApiKey(apiKey: string, model: string): GeminiAnalyzer {
    return new GeminiAnalyzer(new GoogleGenAI({ apiKey, httpOptions: { timeout: 120_000 } }), model);
  }

  async analyze(photos: PhotoInput[]): Promise<VisionResult> {
    const contents: object[] = [];
    for (const photo of photos) {
      contents.push({ text: `Photo id: ${photo.id}` });
      contents.push({ inlineData: { mimeType: 'image/jpeg', data: await modelImage(photo.image) } });
    }
    contents.push({ text: `Assess these ${photos.length} photos. Return one entry per photo id.` });

    let response: Awaited<ReturnType<GenerateClient['models']['generateContent']>>;
    try {
      response = await this.client.models.generateContent({
        model: this.model,
        contents,
        config: {
          systemInstruction: SYSTEM,
          responseMimeType: 'application/json',
          responseJsonSchema: z.toJSONSchema(GeminiOutputSchema),
        },
      });
    } catch (err) {
      const status = isRecord(err) && typeof err.status === 'number' ? err.status : null;
      const message = err instanceof Error ? err.message : String(err);
      if (status === 429) {
        throw new Error('Gemini rate limit reached (the free tier allows a limited number of requests). Wait a minute and retry.');
      }
      if (status === 401 || status === 403 || /api key/i.test(message)) {
        throw new Error('Gemini API key was rejected. Check GEMINI_API_KEY.');
      }
      if (status === 404) throw new Error(`Gemini model "${this.model}" was not found. Check GEMINI_MODEL.`);
      if (status === null) throw new Error('Could not reach the Gemini API. Check the network and retry.');
      throw new Error(`Gemini API error (${status}): ${message}`);
    }

    if (response.promptFeedback?.blockReason) throw new Error('The model declined to analyse these photos');
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.text ?? '');
    } catch {
      // Empty or truncated output.
      throw new Error('Model returned an invalid analysis');
    }
    return sanitizeVision(convertBoxes(parsed), photos.map((p) => p.id));
  }
}
