import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { PipelineEvent } from '@claimlens/shared';
import { DemoAnalyzer } from '../src/analyzers/demo';
import { createApp } from '../src/app';
import { EventBus } from '../src/events';
import type { PipelineDeps } from '../src/pipeline/run';
import { ClaimStore } from '../src/store';
import { flatJpeg, sceneJpeg } from './helpers';

let app: Express;
let deps: PipelineDeps;

const finished = (id: string) => new Promise<PipelineEvent>((resolve) => {
  deps.events.subscribe(id, (e) => { if (e.type !== 'stage') resolve(e); });
});

async function upload(path: string, files: { buf: Buffer; name: string; type?: string }[]) {
  let req = request(app).post(path);
  for (const f of files) req = req.attach('photos', f.buf, { filename: f.name, contentType: f.type ?? 'image/jpeg' });
  return req;
}
const scenes = (seeds: number[]) => Promise.all(seeds.map(async (s) => ({ buf: await sceneJpeg(s, 1000, 800), name: `car-${s}.jpg` })));

beforeEach(async () => {
  deps = {
    store: new ClaimStore(':memory:'), analyzer: new DemoAnalyzer(), events: new EventBus(),
    uploadsDir: await mkdtemp(join(tmpdir(), 'claimlens-api-')), stageDelayMs: 0,
  };
  app = createApp(deps);
});

describe('claims API', () => {
  it('runs a claim from upload to report', async () => {
    const res = await upload('/api/claims', await scenes([1, 2, 3, 4]));
    expect(res.status).toBe(201);
    const id = res.body.id as string;
    expect(id).toMatch(/^CLM-\d{4}-0001$/);
    expect((await finished(id)).type).toBe('done');

    const report = (await request(app).get(`/api/claims/${id}`)).body;
    expect(report.state).toBe('done');
    expect(report.photos).toHaveLength(4);
    expect(report.photos[0].filename).toBe('car-1.jpg');

    const img = await request(app).get(report.photos[0].url);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toContain('image/jpeg');

    const list = (await request(app).get('/api/claims')).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, status: 'pending', state: 'done' });
  });

  it('rejects too few and too many photos', async () => {
    const few = await upload('/api/claims', await scenes([1, 2, 3]));
    expect(few.status).toBe(400);
    expect(few.body.error).toMatch(/4 to 10/);
    const many = await upload('/api/claims', await scenes([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]));
    expect(many.status).toBe(400);
    expect((await request(app).get('/api/claims')).body).toEqual([]);
  });

  it('rejects unsupported types and undecodable images with 400, naming the file', async () => {
    const good = await scenes([1, 2, 3]);
    const pdf = await upload('/api/claims', [...good, { buf: Buffer.from('%PDF-1.4'), name: 'doc.pdf', type: 'application/pdf' }]);
    expect(pdf.status).toBe(400);
    expect(pdf.body.error).toMatch(/JPEG, PNG or WebP/);

    const corrupt = await upload('/api/claims', [...good, { buf: Buffer.from('definitely not a jpeg'), name: 'broken.jpg' }]);
    expect(corrupt.status).toBe(400);
    expect(corrupt.body.error).toContain('broken.jpg');
  });

  it('requires four photos to pass quality and reports each result', async () => {
    const res = await upload('/api/claims', [...(await scenes([1, 2, 3])), { buf: await flatJpeg(), name: 'blurry.jpg' }]);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least 4/i);
    expect(res.body.photos.find((p: { filename: string }) => p.filename === 'blurry.jpg').quality.issues).toContain('blurry');
  });

  it('keeps a failing photo when enough others pass', async () => {
    const res = await upload('/api/claims', [...(await scenes([1, 2, 3, 4])), { buf: await flatJpeg(), name: 'blurry.jpg' }]);
    expect(res.status).toBe(201);
    await finished(res.body.id);
    const report = (await request(app).get(`/api/claims/${res.body.id}`)).body;
    expect(report.photos).toHaveLength(5);
    expect(report.photos[4].quality.pass).toBe(false);
    expect(report.photos[4].angle).toBeNull();
  });

  it('adds photos to a claim and reruns, within the 10-photo limit', async () => {
    const id = (await upload('/api/claims', await scenes([1, 2, 3, 4]))).body.id;
    await finished(id);
    const add = await upload(`/api/claims/${id}/photos`, await scenes([5]));
    expect(add.status).toBe(200);
    await finished(id);
    const report = (await request(app).get(`/api/claims/${id}`)).body;
    expect(report.photos.map((p: { id: string }) => p.id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);

    const over = await upload(`/api/claims/${id}/photos`, await scenes([6, 7, 8, 9, 10, 11]));
    expect(over.status).toBe(400);
    expect(over.body.error).toMatch(/10/);
  });

  it('streams progress, and replays it to a subscriber who connects after the run', async () => {
    const id = (await upload('/api/claims', await scenes([1, 2, 3, 4]))).body.id;
    await finished(id);
    const res = await request(app).get(`/api/claims/${id}/events`);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.text).toContain('"stage":"vision"');
    expect(res.text.trim().endsWith('data: {"type":"done"}')).toBe(true);
  });

  it('reports the stored outcome when no run is in memory (for example after a restart)', async () => {
    const id = (await upload('/api/claims', await scenes([1, 2, 3, 4]))).body.id;
    await finished(id);
    const fresh = createApp({ ...deps, events: new EventBus() });
    const res = await request(fresh).get(`/api/claims/${id}/events`);
    expect(res.text.trim()).toBe('data: {"type":"done"}');
  });

  it('retries a failed claim', async () => {
    const good = deps.analyzer;
    deps.analyzer = { mode: 'claude', analyze: async () => { throw new Error('boom'); } };
    app = createApp(deps);
    const id = (await upload('/api/claims', await scenes([1, 2, 3, 4]))).body.id;
    expect(await finished(id)).toEqual({ type: 'failed', error: 'boom' });
    expect((await request(app).get(`/api/claims/${id}`)).body).toMatchObject({ state: 'failed', error: 'boom' });

    deps.analyzer = good;
    expect((await request(app).post(`/api/claims/${id}/retry`)).status).toBe(200);
    await finished(id);
    expect((await request(app).get(`/api/claims/${id}`)).body.state).toBe('done');
  });

  it('updates status and validates it', async () => {
    const id = (await upload('/api/claims', await scenes([1, 2, 3, 4]))).body.id;
    await finished(id);
    expect((await request(app).patch(`/api/claims/${id}`).send({ status: 'approved' })).body.status).toBe('approved');
    expect((await request(app).patch(`/api/claims/${id}`).send({ status: 'paid' })).status).toBe(400);
  });

  it('returns 404 for unknown claims on every claim route', async () => {
    const id = 'CLM-2026-9999';
    expect((await request(app).get(`/api/claims/${id}`)).status).toBe(404);
    expect((await request(app).get(`/api/claims/${id}/events`)).status).toBe(404);
    expect((await request(app).patch(`/api/claims/${id}`).send({ status: 'approved' })).status).toBe(404);
    expect((await request(app).post(`/api/claims/${id}/retry`)).status).toBe(404);
    expect((await upload(`/api/claims/${id}/photos`, await scenes([1]))).status).toBe(404);
  });

  it('reports the analysis mode', async () => {
    expect((await request(app).get('/api/config')).body).toEqual({ analysisMode: 'demo' });
  });
});
