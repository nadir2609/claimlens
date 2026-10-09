import type {
  Angle, AnalysisMode, Band3, ClaimStatus, DamageType, FraudObservationKind, Part,
  RecommendedAction, Severity, SeverityBand, Stage,
} from './vocab';

export type QualityIssue = 'blurry' | 'dark' | 'bright';

export interface QualityResult {
  pass: boolean;
  sharpness: number;
  brightness: number;
  width: number;
  height: number;
  issues: QualityIssue[];
}

export type BBox = [x: number, y: number, width: number, height: number];

export interface Damage {
  part: Part;
  type: DamageType;
  severity: Severity;
  bbox: BBox;
  confidence: number;
  note: string;
}

export interface VehicleInfo {
  make: string;
  model: string;
  year: string;
  bodyType: string;
  confidence: number;
}

export interface FraudObservation {
  kind: FraudObservationKind;
  detail: string;
}

export interface PhotoAnalysis {
  photoId: string;
  angle: Angle;
  visibleParts: Part[];
  damages: Damage[];
}

export interface VisionResult {
  vehicle: VehicleInfo;
  photos: PhotoAnalysis[];
  fraudObservations: FraudObservation[];
}

export interface PhotoRecord {
  id: string;
  filename: string;
  url: string;
  width: number;
  height: number;
  quality: QualityResult;
  sha256: string;
  dhash: string;
  exif: { software: string | null; capturedAt: string | null };
  angle: Angle | null;
  visibleParts: Part[];
  damages: Damage[];
}

export interface DamageItem {
  id: string;
  part: Part;
  type: DamageType;
  severity: Severity;
  score: number;
  photoIds: string[];
}

export interface PartListing {
  title: string;
  price: number;
  url: string;
  /** The site the listing came from, for example "avtopro.az". */
  source: string;
}

export interface PartOffer {
  cheapest: PartListing;
  alternatives: PartListing[];
}

export interface SearchLink {
  source: string;
  url: string;
}

/** What a marketplace search found for one part of one vehicle. */
export interface PartSearchResult {
  /** The match for this vehicle's make, or null when nothing is listed for it. */
  offer: PartOffer | null;
  /** The same part for other vehicles, as a price reference only. */
  similar: PartListing[];
  /** The search-result pages, so a person can check for themselves. */
  searchLinks: SearchLink[];
}

export interface CostLine {
  damageId: string;
  part: Part;
  type: DamageType;
  severity: Severity;
  operation: 'Repair' | 'Replace';
  parts: number;
  /**
   * Where the parts price came from: a marketplace listing, the fallback table, no part needed,
   * or already charged on an earlier line for the same part.
   */
  partsBasis: 'listing' | 'estimate' | 'none' | 'included';
  partListing: PartListing | null;
  alternatives: PartListing[];
  similarListings: PartListing[];
  searchLinks: SearchLink[];
  paint: number;
  laborHours: number;
  laborRate: number;
  labor: number;
  total: number;
}

export interface CostEstimate {
  lines: CostLine[];
  partsTotal: number;
  paintTotal: number;
  laborTotal: number;
  laborHours: number;
  total: number;
  makeTier: 'economy' | 'mid' | 'luxury';
  tierMultiplier: number;
  laborRate: number;
  currency: 'AZN';
}

export interface Coverage {
  angles: { front: boolean; side: boolean; rear: boolean };
  parts: Record<Part, boolean>;
  prompts: string[];
  complete: boolean;
}

export interface FraudSignal {
  kind: string;
  label: string;
  detail: string;
  points: number;
}

export interface FraudAssessment {
  score: number;
  band: Band3;
  signals: FraudSignal[];
  notes: string[];
}

export interface Recommendation {
  action: RecommendedAction;
  reasons: string[];
}

export interface ClaimReport {
  id: string;
  createdAt: string;
  status: ClaimStatus;
  state: 'processing' | 'done' | 'failed';
  error: string | null;
  analysisMode: AnalysisMode;
  vehicle: VehicleInfo;
  photos: PhotoRecord[];
  damages: DamageItem[];
  severity: { score: number; band: SeverityBand };
  coverage: Coverage;
  cost: CostEstimate;
  fraud: FraudAssessment;
  recommendation: Recommendation;
}

export interface ClaimSummary {
  id: string;
  createdAt: string;
  vehicle: string;
  totalCost: number;
  fraudScore: number;
  fraudBand: Band3;
  severityScore: number;
  action: RecommendedAction;
  status: ClaimStatus;
  state: ClaimReport['state'];
  thumbnailUrl: string | null;
}

export type PipelineEvent =
  | { type: 'stage'; stage: Stage; status: 'running' | 'done' }
  | { type: 'done' }
  | { type: 'failed'; error: string };
