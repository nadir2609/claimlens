import type { AnalysisMode, VisionResult } from '@claimlens/shared';

export interface PhotoInput { id: string; sha256: string; image: Buffer }

export interface VisionAnalyzer {
  readonly mode: AnalysisMode;
  analyze(photos: PhotoInput[]): Promise<VisionResult>;
}
