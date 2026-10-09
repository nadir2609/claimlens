export const PARTS = [
  'Front Bumper', 'Hood', 'Headlights', 'Doors', 'Rear Bumper', 'Fenders', 'Windshield',
] as const;
export type Part = (typeof PARTS)[number];

export const DAMAGE_TYPES = [
  'Scratch', 'Dent', 'Crack', 'Broken Glass', 'Paint Damage', 'Severe Deformation',
] as const;
export type DamageType = (typeof DAMAGE_TYPES)[number];

export const SEVERITIES = ['Low', 'Medium', 'High'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const ANGLES = [
  'front', 'rear', 'left', 'right', 'front-left', 'front-right',
  'rear-left', 'rear-right', 'detail', 'other',
] as const;
export type Angle = (typeof ANGLES)[number];

export const FRAUD_OBSERVATION_KINDS = [
  'vehicle_mismatch', 'screen_recapture', 'damage_inconsistency',
] as const;
export type FraudObservationKind = (typeof FRAUD_OBSERVATION_KINDS)[number];

export const STAGES = ['quality', 'vision', 'coverage', 'severity', 'cost', 'fraud', 'report'] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  quality: 'Checking image quality',
  vision: 'Identifying vehicle and detecting damage',
  coverage: 'Verifying angle and part coverage',
  severity: 'Scoring severity',
  cost: 'Estimating repair cost',
  fraud: 'Assessing fraud risk',
  report: 'Building report',
};

export const ACTIONS = [
  'Fast-track approval', 'Standard review', 'Manual Adjuster Review Required',
] as const;
export type RecommendedAction = (typeof ACTIONS)[number];

export const CLAIM_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export type Band3 = 'Low' | 'Medium' | 'High';
export type SeverityBand = 'Minor' | 'Moderate' | 'Severe';
export type AnalysisMode = 'claude' | 'demo';
