import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import multer from 'multer';
import { CLAIM_STATUSES, type ClaimStatus, type PhotoRecord, type QualityResult } from '@claimlens/shared';
import { UnreadableImageError, prepareImage, type PreparedImage } from './images';
import { emptyReport } from './pipeline/report';
import { runPipeline, type PipelineDeps } from './pipeline/run';

const MIN_PHOTOS = 4;
const MAX_PHOTOS = 10;
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly extra: object = {}) { super(message); }
}

type Prepared = { filename: string; image: PreparedImage };

async function prepareAll(files: Express.Multer.File[]): Promise<Prepared[]> {
  const bad = files.find((f) => !ALLOWED.includes(f.mimetype));
  if (bad) throw new HttpError(400, `${bad.originalname} is not a supported type. Upload JPEG, PNG or WebP images.`);
  return Promise.all(files.map(async (f) => {
    try {
      return { filename: f.originalname, image: await prepareImage(f.buffer) };
    } catch (err) {
      if (err instanceof UnreadableImageError) throw new HttpError(400, `${f.originalname} could not be read as an image.`);
      throw err;
    }
  }));
}

export function createApp(deps: PipelineDeps & { clientDist?: string }): express.Express {
  const app = express();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 20 }, defParamCharset: 'utf8' });
  app.use(express.json());
  app.use('/uploads', express.static(deps.uploadsDir));

  const storePhotos = async (claimId: string, startIndex: number, prepared: Prepared[]): Promise<PhotoRecord[]> => {
    await mkdir(join(deps.uploadsDir, claimId), { recursive: true });
    return Promise.all(prepared.map(async ({ filename, image }, i) => {
      const id = `p${startIndex + i + 1}`;
      await writeFile(join(deps.uploadsDir, claimId, `${id}.jpg`), image.display);
      return {
        id, filename, url: `/uploads/${claimId}/${id}.jpg`, width: image.width, height: image.height,
        quality: image.quality, sha256: image.sha256, dhash: image.dhash,
        exif: { software: image.software, capturedAt: image.capturedAt },
        angle: null, visibleParts: [], damages: [],
      };
    }));
  };

  // Claims with an upload or a run in flight. Taken synchronously so two requests cannot both proceed.
  const busy = new Set<string>();
  const lock = (claimId: string) => {
    if (busy.has(claimId)) throw new HttpError(409, 'This claim is still being analysed.');
    busy.add(claimId);
  };
  const start = (claimId: string) => {
    busy.add(claimId);
    void runPipeline(deps, claimId)
      .catch((err) => console.error(`Pipeline crashed for ${claimId}`, err))
      .finally(() => busy.delete(claimId));
  };

  const claimOr404 = (req: Request) => {
    const report = deps.store.get(String(req.params.id));
    if (!report) throw new HttpError(404, 'Claim not found');
    return report;
  };

  app.get('/api/config', (_req, res) => { res.json({ analysisMode: deps.analyzer.mode }); });

  app.get('/api/claims', (_req, res) => { res.json(deps.store.list()); });

  app.post('/api/claims', upload.array('photos'), async (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length < MIN_PHOTOS || files.length > MAX_PHOTOS) {
      throw new HttpError(400, `Upload 4 to 10 photos (received ${files.length}).`);
    }
    const prepared = await prepareAll(files);
    const passing = prepared.filter((p) => p.image.quality.pass).length;
    if (passing < MIN_PHOTOS) {
      const photos: { filename: string; quality: QualityResult }[] =
        prepared.map((p) => ({ filename: p.filename, quality: p.image.quality }));
      throw new HttpError(400, `At least 4 photos must pass the quality check (${passing} passed).`, { photos });
    }
    // Insert before the first await so a concurrent request cannot be issued the same id.
    const id = deps.store.nextId();
    deps.store.insert(emptyReport(id, new Date().toISOString(), deps.analyzer.mode, []));
    busy.add(id);
    try {
      const report = deps.store.get(id)!;
      report.photos = await storePhotos(id, 0, prepared);
      deps.store.save(report);
    } catch (err) {
      busy.delete(id);
      const report = deps.store.get(id)!;
      report.state = 'failed';
      report.error = 'The photos could not be saved. Submit the claim again.';
      deps.store.save(report);
      throw err;
    }
    start(id);
    res.status(201).json({ id });
  });

  app.post('/api/claims/:id/photos', upload.array('photos'), async (req, res) => {
    const report = claimOr404(req);
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) throw new HttpError(400, 'Attach at least one photo.');
    if (report.photos.length + files.length > MAX_PHOTOS) {
      throw new HttpError(400, `A claim can hold at most 10 photos (this one has ${report.photos.length}).`);
    }
    lock(report.id);
    try {
      const prepared = await prepareAll(files);
      report.photos.push(...(await storePhotos(report.id, report.photos.length, prepared)));
      deps.store.save(report);
    } catch (err) {
      busy.delete(report.id);
      throw err;
    }
    start(report.id);
    res.json({ id: report.id });
  });

  app.post('/api/claims/:id/retry', (req, res) => {
    const report = claimOr404(req);
    lock(report.id);
    start(report.id);
    res.json({ id: report.id });
  });

  app.get('/api/claims/:id', (req, res) => { res.json(claimOr404(req)); });

  app.patch('/api/claims/:id', (req, res) => {
    const report = claimOr404(req);
    const status = req.body?.status as ClaimStatus;
    if (!CLAIM_STATUSES.includes(status)) throw new HttpError(400, 'Status must be pending, approved or rejected.');
    if (busy.has(report.id) || report.state !== 'done') {
      throw new HttpError(409, 'A decision can be recorded once the analysis has finished.');
    }
    res.json(deps.store.setStatus(String(req.params.id), status));
  });

  app.get('/api/claims/:id/events', (req: Request, res: Response) => {
    const report = claimOr404(req);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const send = (event: object) => res.write(`data: ${JSON.stringify(event)}\n\n`);

    if (!deps.events.hasRun(report.id) && report.state !== 'processing') {
      send(report.state === 'done' ? { type: 'done' } : { type: 'failed', error: report.error ?? 'Analysis failed' });
      res.end();
      return;
    }
    let off = () => {};
    off = deps.events.subscribe(report.id, (event) => {
      send(event);
      if (event.type !== 'stage') { off(); res.end(); }
    });
    if (res.writableEnded) off();
    req.on('close', () => off());
  });

  if (deps.clientDist && existsSync(deps.clientDist)) {
    app.use(express.static(deps.clientDist));
    app.get(/^(?!\/api|\/uploads).*/, (_req, res) => { res.sendFile(join(deps.clientDist!, 'index.html')); });
  }

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message, ...err.extra }); return; }
    if (err instanceof multer.MulterError) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'Each photo must be 15 MB or smaller.' : `Upload failed: ${err.message}`;
      res.status(400).json({ error: message });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server.' });
  };
  app.use(onError);
  return app;
}
