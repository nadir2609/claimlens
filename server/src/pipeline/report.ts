import type { AnalysisMode, ClaimReport, PhotoRecord } from '@claimlens/shared';
import { assessCoverage } from './coverage';
import { estimateCost } from './cost';

export function emptyReport(id: string, createdAt: string, mode: AnalysisMode, photos: PhotoRecord[]): ClaimReport {
  return {
    id, createdAt, status: 'pending', state: 'processing', error: null, analysisMode: mode,
    vehicle: { make: 'Unknown', model: 'Unknown', year: 'Unknown', bodyType: 'Unknown', confidence: 0 },
    photos,
    damages: [],
    severity: { score: 0, band: 'Minor' },
    coverage: assessCoverage([]),
    cost: estimateCost([], ''),
    fraud: { score: 0, band: 'Low', signals: [], notes: [] },
    recommendation: { action: 'Standard review', reasons: [] },
  };
}
