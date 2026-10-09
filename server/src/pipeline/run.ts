import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Stage } from '@claimlens/shared';
import type { VisionAnalyzer } from '../analyzers/types';
import type { EventBus } from '../events';
import type { ClaimStore } from '../store';
import { recommend } from './action';
import { assessCoverage } from './coverage';
import { estimateCost } from './cost';
import { assessFraud } from './fraud';
import { mergeDamages, scoreSeverity } from './severity';

export interface PipelineDeps {
  store: ClaimStore;
  analyzer: VisionAnalyzer;
  events: EventBus;
  uploadsDir: string;
  stageDelayMs: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs every stage for a claim. Analysis errors are recorded on the claim, not thrown. */
export async function runPipeline(deps: PipelineDeps, claimId: string): Promise<void> {
  const { store, analyzer, events } = deps;
  const report = store.get(claimId);
  if (!report) throw new Error(`Unknown claim ${claimId}`);

  events.start(claimId);
  report.state = 'processing';
  report.status = 'pending';
  report.error = null;
  report.analysisMode = analyzer.mode;
  store.save(report);

  const stage = async <T>(name: Stage, work: () => T | Promise<T>): Promise<T> => {
    events.emit(claimId, { type: 'stage', stage: name, status: 'running' });
    if (deps.stageDelayMs > 0) await sleep(deps.stageDelayMs);
    const out = await work();
    events.emit(claimId, { type: 'stage', stage: name, status: 'done' });
    return out;
  };

  try {
    const usable = await stage('quality', () => report.photos.filter((p) => p.quality.pass));

    const vision = await stage('vision', async () => {
      const inputs = await Promise.all(usable.map(async (p) => ({
        id: p.id, sha256: p.sha256, image: await readFile(join(deps.uploadsDir, claimId, `${p.id}.jpg`)),
      })));
      return analyzer.analyze(inputs);
    });
    report.vehicle = vision.vehicle;
    for (const photo of report.photos) {
      const found = vision.photos.find((v) => v.photoId === photo.id);
      photo.angle = found?.angle ?? null;
      photo.visibleParts = found?.visibleParts ?? [];
      photo.damages = found?.damages ?? [];
    }

    report.coverage = await stage('coverage', () => assessCoverage(report.photos));
    await stage('severity', () => {
      report.damages = mergeDamages(report.photos);
      report.severity = scoreSeverity(report.damages);
    });
    report.cost = await stage('cost', () => estimateCost(report.damages, report.vehicle.make));
    report.fraud = await stage('fraud', () => assessFraud({
      photos: report.photos.map((p) => ({ id: p.id, sha256: p.sha256, dhash: p.dhash, ...p.exif })),
      priorHashes: store.earlierHashes(claimId),
      observations: vision.fraudObservations,
      totalCost: report.cost.total,
    }));
    await stage('report', () => {
      report.recommendation = recommend({
        fraudScore: report.fraud.score, severityScore: report.severity.score,
        totalCost: report.cost.total, coverage: report.coverage,
      });
      report.state = 'done';
      store.save(report);
    });
    events.emit(claimId, { type: 'done' });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Analysis failed';
    const latest = store.get(claimId) ?? report;
    latest.state = 'failed';
    latest.error = message;
    store.save(latest);
    events.emit(claimId, { type: 'failed', error: message });
  }
}
