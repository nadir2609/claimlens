import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PhotoRecord, PipelineEvent, VisionResult } from '@claimlens/shared';
import { DemoAnalyzer } from '../src/analyzers/demo';
import type { VisionAnalyzer } from '../src/analyzers/types';
import { EventBus } from '../src/events';
import { prepareImage } from '../src/images';
import { emptyReport } from '../src/pipeline/report';
import { runPipeline, type PipelineDeps } from '../src/pipeline/run';
import { ClaimStore } from '../src/store';
import { sceneJpeg } from './helpers';

let deps: PipelineDeps;

async function addClaim(seeds: number[]): Promise<string> {
  const id = deps.store.nextId(new Date('2026-10-09T00:00:00Z'));
  await mkdir(join(deps.uploadsDir, id), { recursive: true });
  const photos: PhotoRecord[] = [];
  for (const [i, seed] of seeds.entries()) {
    const p = await prepareImage(await sceneJpeg(seed, 1000, 800));
    const photoId = `p${i + 1}`;
    await writeFile(join(deps.uploadsDir, id, `${photoId}.jpg`), p.display);
    photos.push({
      id: photoId, filename: `${photoId}.jpg`, url: `/uploads/${id}/${photoId}.jpg`, width: p.width, height: p.height,
      quality: p.quality, sha256: p.sha256, dhash: p.dhash, exif: { software: p.software, capturedAt: p.capturedAt },
      angle: null, visibleParts: [], damages: [],
    });
  }
  deps.store.insert(emptyReport(id, '2026-10-09T00:00:00.000Z', deps.analyzer.mode, photos));
  return id;
}

const fixed = (result: (ids: string[]) => VisionResult): VisionAnalyzer => ({
  mode: 'demo',
  analyze: async (photos) => result(photos.map((p) => p.id)),
});

beforeEach(async () => {
  deps = {
    store: new ClaimStore(':memory:'),
    analyzer: new DemoAnalyzer(),
    events: new EventBus(),
    uploadsDir: await mkdtemp(join(tmpdir(), 'claimlens-')),
    stageDelayMs: 0,
  };
});

describe('ClaimStore', () => {
  it('issues sequential claim ids per year', async () => {
    expect(await addClaim([1, 2, 3, 4])).toBe('CLM-2026-0001');
    expect(await addClaim([5, 6, 7, 8])).toBe('CLM-2026-0002');
  });

  it('returns null for unknown ids and updates status', async () => {
    const id = await addClaim([1, 2, 3, 4]);
    expect(deps.store.get('CLM-2026-9999')).toBeNull();
    expect(deps.store.setStatus('CLM-2026-9999', 'approved')).toBeNull();
    expect(deps.store.setStatus(id, 'approved')?.status).toBe('approved');
    expect(deps.store.list()[0].status).toBe('approved');
  });

  it('returns hashes from earlier claims only, never its own or later ones', async () => {
    const a = await addClaim([1, 2, 3, 4]);
    const b = await addClaim([5, 6, 7, 8]);
    expect(deps.store.earlierHashes(a)).toEqual([]);
    expect(deps.store.earlierHashes(b)).toHaveLength(4);
    expect(deps.store.earlierHashes(b).every((h) => h.claimId === a)).toBe(true);
  });

  it('marks runs interrupted by a restart as failed so they can be retried', async () => {
    const id = await addClaim([1, 2, 3, 4]);
    expect(deps.store.get(id)!.state).toBe('processing');
    expect(deps.store.failInterrupted()).toBe(1);
    const r = deps.store.get(id)!;
    expect(r.state).toBe('failed');
    expect(r.error).toMatch(/interrupted/i);
    expect(deps.store.failInterrupted()).toBe(0);
  });
});

describe('runPipeline', () => {
  it('produces a complete report and emits every stage in order', async () => {
    const id = await addClaim([1, 2, 3, 4]);
    const seen: PipelineEvent[] = [];
    await runPipeline(deps, id);
    deps.events.subscribe(id, (e) => seen.push(e));

    const r = deps.store.get(id)!;
    expect(r.state).toBe('done');
    expect(r.vehicle.make).not.toBe('Unknown');
    expect(r.damages.length).toBeGreaterThan(0);
    expect(r.cost.total).toBeCloseTo(r.cost.lines.reduce((s, l) => s + l.total, 0), 2);
    expect(r.coverage.complete).toBe(true);
    expect(r.photos.every((p) => p.angle !== null)).toBe(true);
    expect(seen.filter((e) => e.type === 'stage' && e.status === 'running').map((e) => (e as { stage: string }).stage))
      .toEqual(['quality', 'vision', 'coverage', 'severity', 'cost', 'fraud', 'report']);
    expect(seen.at(-1)).toEqual({ type: 'done' });

    const summary = deps.store.list()[0];
    expect(summary).toMatchObject({ id, totalCost: r.cost.total, fraudScore: r.fraud.score, action: r.recommendation.action, state: 'done' });
    expect(summary.vehicle).toContain(r.vehicle.make);
  });

  it('handles an undamaged vehicle', async () => {
    deps.analyzer = fixed((ids) => ({
      vehicle: { make: 'Toyota', model: 'Camry', year: '2022', bodyType: 'Sedan', confidence: 0.9 },
      photos: ids.map((photoId, i) => ({
        photoId, angle: i === 0 ? 'front-left' : 'rear-right',
        visibleParts: i === 0 ? ['Front Bumper', 'Hood', 'Headlights', 'Windshield', 'Fenders', 'Doors'] : ['Rear Bumper'], damages: [],
      })),
      fraudObservations: [],
    }));
    const id = await addClaim([1, 2, 3, 4]);
    await runPipeline(deps, id);
    const r = deps.store.get(id)!;
    expect(r.state).toBe('done');
    expect(r.damages).toEqual([]);
    expect(r.severity).toEqual({ score: 0, band: 'Minor' });
    expect(r.cost.total).toBe(0);
    expect(r.recommendation.action).toBe('Fast-track approval');
  });

  it('prices a replaced part from the marketplace lookup and keeps the link in the report', async () => {
    deps.analyzer = fixed((ids) => ({
      vehicle: { make: 'Mazda', model: 'CX-7', year: '2010', bodyType: 'SUV', confidence: 0.9 },
      photos: ids.map((photoId, i) => ({
        photoId, angle: 'front', visibleParts: ['Front Bumper'],
        damages: i === 0 ? [{ part: 'Front Bumper', type: 'Dent', severity: 'High', bbox: [0.1, 0.1, 0.2, 0.2], confidence: 0.9, note: '' }] : [],
      })),
      fraudObservations: [],
    }));
    const cheapest = { title: 'TECHPRO MA1000200 (Front)', price: 417.61, url: 'https://www.rockauto.com/en/moreinfo.php?pk=1', source: 'rockauto.com' };
    deps.partLookup = { find: async (part) => (part === 'Front Bumper' ? { offer: { cheapest, alternatives: [] }, similar: [], searchLinks: [] } : null) };
    const id = await addClaim([1, 2, 3, 4]);
    await runPipeline(deps, id);
    const line = deps.store.get(id)!.cost.lines[0];
    expect(line).toMatchObject({ parts: 417.61, partsBasis: 'listing', partListing: cheapest });
  });

  it('skips photos that failed quality and marks uncovered parts for manual review', async () => {
    deps.analyzer = fixed((ids) => ({
      vehicle: { make: 'Toyota', model: 'Camry', year: '2022', bodyType: 'Sedan', confidence: 0.9 },
      photos: ids.map((photoId) => ({ photoId, angle: 'left', visibleParts: ['Doors'], damages: [] })),
      fraudObservations: [],
    }));
    const id = await addClaim([1, 2, 3, 4, 5]);
    const r0 = deps.store.get(id)!;
    r0.photos[4].quality = { ...r0.photos[4].quality, pass: false, issues: ['blurry'] };
    deps.store.save(r0);

    await runPipeline(deps, id);
    const r = deps.store.get(id)!;
    expect(r.photos[4].angle).toBeNull();
    expect(r.coverage.complete).toBe(false);
    expect(r.recommendation.action).toBe('Manual Adjuster Review Required');
  });

  it('flags photos reused from an earlier claim, but not on a rerun of the same claim', async () => {
    const first = await addClaim([1, 2, 3, 4]);
    await runPipeline(deps, first);
    await runPipeline(deps, first);
    expect(deps.store.get(first)!.fraud.signals.some((s) => s.kind === 'duplicate_photo')).toBe(false);

    const second = await addClaim([1, 9, 10, 11]);
    await runPipeline(deps, second);
    const fraud = deps.store.get(second)!.fraud;
    expect(fraud.signals.find((s) => s.kind === 'duplicate_photo')?.detail).toContain(first);
    expect(fraud.score).toBeGreaterThanOrEqual(40);

    await runPipeline(deps, first);
    expect(deps.store.get(first)!.fraud.signals.some((s) => s.kind === 'duplicate_photo')).toBe(false);
  });

  it('resets an earlier decision to pending when a claim is re-analysed', async () => {
    const id = await addClaim([1, 2, 3, 4]);
    await runPipeline(deps, id);
    deps.store.setStatus(id, 'approved');
    await runPipeline(deps, id);
    expect(deps.store.get(id)!.status).toBe('pending');
  });

  it('records a failure instead of throwing, and a rerun recovers', async () => {
    const good = deps.analyzer;
    deps.analyzer = { mode: 'claude', analyze: async () => { throw new Error('API unavailable'); } };
    const id = await addClaim([1, 2, 3, 4]);
    await expect(runPipeline(deps, id)).resolves.toBeUndefined();
    expect(deps.store.get(id)).toMatchObject({ state: 'failed', error: 'API unavailable' });
    const seen: PipelineEvent[] = [];
    deps.events.subscribe(id, (e) => seen.push(e));
    expect(seen.at(-1)).toEqual({ type: 'failed', error: 'API unavailable' });

    deps.analyzer = good;
    await runPipeline(deps, id);
    expect(deps.store.get(id)).toMatchObject({ state: 'done', error: null });
  });
});

describe('EventBus', () => {
  it('replays history to late subscribers and stops after unsubscribe', () => {
    const bus = new EventBus();
    expect(bus.hasRun('x')).toBe(false);
    bus.start('x');
    bus.emit('x', { type: 'stage', stage: 'quality', status: 'running' });
    const seen: PipelineEvent[] = [];
    const off = bus.subscribe('x', (e) => seen.push(e));
    bus.emit('x', { type: 'done' });
    off();
    bus.emit('x', { type: 'done' });
    expect(seen).toHaveLength(2);
    expect(bus.hasRun('x')).toBe(true);
  });
});
