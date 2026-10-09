import { describe, expect, it, vi } from 'vitest';
import { PARTS } from '@claimlens/shared';
import { ClaudeAnalyzer } from '../src/analyzers/claude';
import { DemoAnalyzer } from '../src/analyzers/demo';
import { sanitizeVision } from '../src/analyzers/schema';
import { assessCoverage } from '../src/pipeline/coverage';
import { sceneJpeg } from './helpers';

const vehicle = { make: 'Toyota', model: 'Camry', year: '2022', bodyType: 'Sedan', confidence: 0.9 };
const damage = (over: object = {}) => ({
  part: 'Hood', type: 'Dent', severity: 'Medium',
  bbox: { x: 0.2, y: 0.3, width: 0.2, height: 0.1 }, confidence: 0.8, note: 'n', ...over,
});

describe('sanitizeVision', () => {
  it('converts boxes to [x, y, width, height] and keeps valid items', () => {
    const r = sanitizeVision({ vehicle, photos: [{ photoId: 'p1', angle: 'front', visibleParts: ['Hood'], damages: [damage()] }], fraudObservations: [] }, ['p1']);
    expect(r.photos[0].damages[0].bbox).toEqual([0.2, 0.3, 0.2, 0.1]);
  });

  it('clamps boxes into the image and drops empty ones', () => {
    const r = sanitizeVision({
      vehicle,
      photos: [{ photoId: 'p1', angle: 'front', visibleParts: [], damages: [
        damage({ bbox: { x: -0.1, y: 0.9, width: 0.5, height: 0.5 } }),
        damage({ bbox: { x: 1.2, y: 0.2, width: 0.3, height: 0.3 } }),
      ] }],
      fraudObservations: [],
    }, ['p1']);
    expect(r.photos[0].damages).toHaveLength(1);
    const [x, y, w, h] = r.photos[0].damages[0].bbox;
    expect(x).toBe(0);
    expect(y).toBeCloseTo(0.9);
    expect(w).toBeCloseTo(0.4);
    expect(h).toBeCloseTo(0.1);
  });

  it('drops damages with unknown vocabulary but keeps the rest', () => {
    const r = sanitizeVision({
      vehicle,
      photos: [{ photoId: 'p1', angle: 'front', visibleParts: ['Hood', 'Spoiler'], damages: [damage({ part: 'Spoiler' }), damage({ type: 'Rust' }), damage()] }],
      fraudObservations: [{ kind: 'aliens', detail: 'x' }, { kind: 'screen_recapture', detail: 'moire pattern' }],
    }, ['p1']);
    expect(r.photos[0].damages).toHaveLength(1);
    expect(r.photos[0].visibleParts).toEqual(['Hood']);
    expect(r.fraudObservations).toEqual([{ kind: 'screen_recapture', detail: 'moire pattern' }]);
  });

  it('drops invented photo ids and fills in omitted photos', () => {
    const r = sanitizeVision({ vehicle, photos: [
      { photoId: 'p9', angle: 'front', visibleParts: [], damages: [damage()] },
      { photoId: 'p1', angle: 'rear', visibleParts: ['Rear Bumper'], damages: [] },
    ], fraudObservations: [] }, ['p1', 'p2']);
    expect(r.photos.map((p) => p.photoId)).toEqual(['p1', 'p2']);
    expect(r.photos[1]).toEqual({ photoId: 'p2', angle: 'other', visibleParts: [], damages: [] });
  });

  it('accepts photo ids the model wrapped in extra text', () => {
    const r = sanitizeVision({ vehicle, photos: [{ photoId: 'Photo id: p1', angle: 'front', visibleParts: ['Hood'], damages: [damage()] }], fraudObservations: [] }, ['p1']);
    expect(r.photos[0].damages).toHaveLength(1);
  });

  it('fails rather than reporting no damage when no returned photo id matches', () => {
    expect(() => sanitizeVision({ vehicle, photos: [{ photoId: 'first', angle: 'front', visibleParts: [], damages: [damage()] }], fraudObservations: [] }, ['p1']))
      .toThrow('Model returned an invalid analysis');
  });

  it('treats a damaged part as visible, and clamps confidence', () => {
    const r = sanitizeVision({ vehicle: { ...vehicle, confidence: 7 }, photos: [{ photoId: 'p1', angle: 'front', visibleParts: [], damages: [damage()] }], fraudObservations: [] }, ['p1']);
    expect(r.photos[0].visibleParts).toEqual(['Hood']);
    expect(r.vehicle.confidence).toBe(1);
  });

  it('defaults missing vehicle fields to Unknown', () => {
    const r = sanitizeVision({ vehicle: { make: '' }, photos: [], fraudObservations: [] }, ['p1']);
    expect(r.vehicle).toEqual({ make: 'Unknown', model: 'Unknown', year: 'Unknown', bodyType: 'Unknown', confidence: 0 });
  });

  it('throws on a wholly invalid response', () => {
    expect(() => sanitizeVision(null, ['p1'])).toThrow('Model returned an invalid analysis');
    expect(() => sanitizeVision({ photos: 'nope' }, ['p1'])).toThrow('Model returned an invalid analysis');
  });
});

describe('DemoAnalyzer', () => {
  const inputs = (n: number, salt = 'a') =>
    Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, sha256: `${(i + 1).toString(16).padStart(8, '0')}${salt}`, image: Buffer.alloc(0) }));

  it('is deterministic for the same photos and differs for different photos', async () => {
    const demo = new DemoAnalyzer();
    const a = await demo.analyze(inputs(4));
    expect(await demo.analyze(inputs(4))).toEqual(a);
    expect(await demo.analyze(inputs(4, 'b'))).toBeDefined();
    expect(demo.mode).toBe('demo');
  });

  it('covers every angle and part with four photos and reports valid damages', async () => {
    const r = await new DemoAnalyzer().analyze(inputs(4));
    expect(assessCoverage(r.photos).complete).toBe(true);
    const damages = r.photos.flatMap((p) => p.damages.map((d) => ({ d, p })));
    expect(damages.length).toBeGreaterThanOrEqual(2);
    for (const { d, p } of damages) {
      expect(PARTS).toContain(d.part);
      expect(p.visibleParts).toContain(d.part);
      const [x, y, w, h] = d.bbox;
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + w).toBeLessThanOrEqual(1);
      expect(y + h).toBeLessThanOrEqual(1);
    }
  });
});

describe('ClaudeAnalyzer', () => {
  const output = { vehicle, photos: [{ photoId: 'p1', angle: 'front', visibleParts: ['Hood'], damages: [damage()] }], fraudObservations: [] };

  it('sends every photo with its id and returns the sanitized result', async () => {
    const parse = vi.fn().mockResolvedValue({ stop_reason: 'end_turn', parsed_output: output });
    const analyzer = new ClaudeAnalyzer({ messages: { parse } }, 'claude-opus-5-5');
    const image = await sceneJpeg(1, 900, 700);
    const r = await analyzer.analyze([{ id: 'p1', sha256: 'aa', image }, { id: 'p2', sha256: 'bb', image }]);

    expect(analyzer.mode).toBe('claude');
    expect(r.photos.map((p) => p.photoId)).toEqual(['p1', 'p2']);
    const req = parse.mock.calls[0][0];
    expect(req.model).toBe('claude-opus-5-5');
    expect(req.tool_choice).toBeUndefined();
    expect(req.temperature).toBeUndefined();
    const content = req.messages[0].content;
    expect(content.filter((b: { type: string }) => b.type === 'image')).toHaveLength(2);
    expect(content.some((b: { type: string; text?: string }) => b.type === 'text' && b.text === 'Photo id: p2')).toBe(true);
  });

  it('fails clearly on a refusal or an empty parse', async () => {
    const image = await sceneJpeg(1, 900, 700);
    const refused = new ClaudeAnalyzer({ messages: { parse: vi.fn().mockResolvedValue({ stop_reason: 'refusal', parsed_output: null }) } }, 'm');
    await expect(refused.analyze([{ id: 'p1', sha256: 'aa', image }])).rejects.toThrow(/declined/i);
    const empty = new ClaudeAnalyzer({ messages: { parse: vi.fn().mockResolvedValue({ stop_reason: 'end_turn', parsed_output: null }) } }, 'm');
    await expect(empty.analyze([{ id: 'p1', sha256: 'aa', image }])).rejects.toThrow(/invalid analysis/i);
  });

  it('turns an SDK parse failure into a readable error', async () => {
    const image = await sceneJpeg(1, 900, 700);
    const broken = new ClaudeAnalyzer({ messages: { parse: vi.fn().mockRejectedValue(new Error('Failed to parse structured output: SyntaxError: Unexpected end of JSON input')) } }, 'm');
    await expect(broken.analyze([{ id: 'p1', sha256: 'aa', image }])).rejects.toThrow('Model returned an invalid analysis');
  });
});
