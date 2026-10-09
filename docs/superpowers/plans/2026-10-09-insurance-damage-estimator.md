# AI-Powered Insurance Damage Estimator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build "ClaimLens", a local web app that takes 4–10 vehicle damage photos, runs a quality → vision → coverage → severity → cost → fraud pipeline, and shows an interactive report plus an adjuster claims list.

**Architecture:** One npm-workspaces repo: `shared/` (vocabulary, types, the image-quality metric), `server/` (Express API, SQLite, pipeline), `client/` (Vite + React). The only model-dependent step sits behind a `VisionAnalyzer` interface with a Claude implementation and a deterministic demo implementation; severity, cost, fraud and the recommendation are plain rule functions.

**Tech Stack:** TypeScript, Node 24 (`node:sqlite`), Express 5, multer, sharp, exifr, zod, `@anthropic-ai/sdk`, React 19, react-router-dom, Vite, Vitest, supertest, tsx.

**Spec:** `docs/superpowers/specs/2026-10-09-insurance-damage-estimator-design.md`

## Global Constraints

- Parts vocabulary, exactly: Front Bumper, Hood, Headlights, Doors, Rear Bumper, Fenders, Windshield.
- Damage types, exactly: Scratch, Dent, Crack, Broken Glass, Paint Damage, Severe Deformation. Severities: Low, Medium, High.
- Bounding boxes are `[x, y, width, height]` as fractions (0–1) of the displayed image, origin top-left.
- Quality thresholds: Laplacian variance ≥ 60 on a greyscale copy resized to 512 px long side; mean luma 50–215; original long side ≥ 800 and short side ≥ 600.
- Uploads: 4–10 photos per claim, JPEG/PNG/WebP, 15 MB each; at least 4 must pass quality.
- Labour rate $95/hour. Recommendation thresholds: manual review when fraud ≥ 60, severity ≥ 60, total > $8,000 or any part not inspected; fast-track when fraud < 30, severity < 25 and total < $2,500.
- Claude model `claude-opus-5-5` (override with `CLAUDE_MODEL`). Forced `tool_choice` is rejected by this model, so structured output uses `client.messages.parse` with `output_config.format`. Do not send `temperature`, `budget_tokens` or `thinking: disabled`.
- A failed Claude call marks the claim `failed`; it never falls back to demo data.
- Every stored photo is orientation-corrected JPEG, so what the model sees, what the browser shows and what boxes refer to are the same pixels.
- ESM everywhere (`"type": "module"`); no `__dirname` (derive from `import.meta.url`).

## Review Focus

1. A phone photo with an EXIF rotation tag: boxes must line up with the picture as displayed. Pinned in Task 3 (`prepareImage` swaps dimensions for orientation 6).
2. A file with an image MIME type that cannot be decoded (corrupt or renamed): the upload returns 400 naming the file, not a 500. Pinned in Task 6.
3. The model invents a photo id, omits a photo, or returns a box outside the image: bad items are dropped or clamped and the pipeline completes. Pinned in Task 4.
4. An undamaged vehicle (zero damages): score 0, total $0, a recommendation is still produced and the report renders. Pinned in Task 2 and Task 5.
5. Rerunning a claim (adding photos or retrying) must not flag the claim's own photos as duplicates of themselves. Pinned in Task 5.

## File Structure

```
package.json, tsconfig.base.json, vitest.config.ts, .env.example, README.md
shared/package.json
shared/src/index.ts        re-exports
shared/src/vocab.ts        fixed vocabularies and their types
shared/src/types.ts        report, photo, cost, fraud, coverage shapes
shared/src/quality.ts      blur / brightness / resolution metric (browser + server)
server/package.json, server/tsconfig.json
server/src/config.ts       env and paths
server/src/util/prng.ts    seeded random numbers
server/src/images.ts       decode, orient, resize, hash, EXIF
server/src/pipeline/coverage.ts | severity.ts | cost.ts | fraud.ts | action.ts
server/src/pipeline/report.ts   empty report factory
server/src/pipeline/run.ts      orchestrator
server/src/analyzers/types.ts | schema.ts | demo.ts | claude.ts | index.ts
server/src/store.ts        SQLite claim store
server/src/events.ts       per-claim progress events
server/src/app.ts          Express app factory
server/src/index.ts        process entry
server/test/*.test.ts, server/test/helpers.ts
client/package.json, client/tsconfig.json, client/vite.config.ts, client/index.html
client/src/main.tsx, App.tsx, styles.css, theme.ts, api.ts
client/src/lib/imageQuality.ts | boxes.ts | claimsFilter.ts | format.ts
client/src/pages/SubmitPage.tsx | ReportPage.tsx | ClaimsPage.tsx | NotFoundPage.tsx
client/src/components/*.tsx
```

---

### Task 1: Workspace scaffold, shared vocabulary and the quality metric

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `vitest.config.ts`, `shared/package.json`, `shared/src/{index,vocab,types,quality}.ts`
- Test: `shared/src/quality.test.ts`

**Interfaces:**
- Produces: everything exported from `@claimlens/shared` (below). Later tasks import types and constants from there only.

- [ ] **Step 1: Root files**

`package.json`:

```json
{
  "name": "claimlens",
  "private": true,
  "type": "module",
  "workspaces": ["shared", "server", "client"],
  "scripts": {
    "dev": "concurrently -n server,client -c blue,green \"npm run dev -w server\" \"npm run dev -w client\"",
    "test": "vitest run",
    "typecheck": "tsc -p server --noEmit && tsc -p client --noEmit",
    "build": "npm run build -w client",
    "start": "npm run build && npm run start -w server"
  }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "isolatedModules": true,
    "resolveJsonModule": true
  }
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['shared/src/**/*.test.ts', 'server/test/**/*.test.ts', 'client/src/**/*.test.ts'],
    testTimeout: 20000,
  },
});
```

`shared/package.json`:

```json
{
  "name": "@claimlens/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts"
}
```

Run: `npm install -D typescript vitest concurrently`

- [ ] **Step 2: `shared/src/vocab.ts`**

```ts
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
```

- [ ] **Step 3: `shared/src/types.ts`**

```ts
import type {
  Angle, AnalysisMode, Band3, ClaimStatus, DamageType, FraudObservationKind, Part,
  RecommendedAction, Severity, SeverityBand, Stage,
} from './vocab';

export type QualityIssue = 'blurry' | 'dark' | 'bright' | 'low_resolution';

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

export interface CostLine {
  damageId: string;
  part: Part;
  type: DamageType;
  severity: Severity;
  operation: 'Repair' | 'Replace';
  parts: number;
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
```

- [ ] **Step 4: Write the failing quality test** (`shared/src/quality.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { analysisDimensions, assessQuality, laplacianVariance, rgbaToGray } from './quality';

const flat = (w: number, h: number, v: number) => new Uint8Array(w * h).fill(v);
const checker = (w: number, h: number, lo: number, hi: number) => {
  const g = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = (x + y) % 2 ? hi : lo;
  return g;
};

describe('quality metric', () => {
  it('flags a featureless image as blurry', () => {
    const q = assessQuality(flat(64, 64, 128), 64, 64, 1200, 900);
    expect(q.sharpness).toBe(0);
    expect(q.issues).toEqual(['blurry']);
    expect(q.pass).toBe(false);
  });

  it('passes a sharp, well-lit, large image', () => {
    const q = assessQuality(checker(64, 64, 0, 255), 64, 64, 1200, 900);
    expect(q.pass).toBe(true);
    expect(q.issues).toEqual([]);
    expect(q.brightness).toBeCloseTo(127.5, 1);
  });

  it('flags dark and bright images', () => {
    expect(assessQuality(checker(64, 64, 0, 40), 64, 64, 1200, 900).issues).toEqual(['dark']);
    expect(assessQuality(checker(64, 64, 220, 255), 64, 64, 1200, 900).issues).toEqual(['bright']);
  });

  it('checks resolution on the original size in either orientation', () => {
    const g = checker(64, 64, 0, 255);
    expect(assessQuality(g, 64, 64, 640, 480).issues).toEqual(['low_resolution']);
    expect(assessQuality(g, 64, 64, 600, 800).pass).toBe(true);
    expect(assessQuality(g, 64, 64, 800, 599).issues).toEqual(['low_resolution']);
  });

  it('returns 0 sharpness for images too small to convolve', () => {
    expect(laplacianVariance(flat(2, 2, 9), 2, 2)).toBe(0);
  });

  it('scales the analysis size to a 512 px long side without enlarging', () => {
    expect(analysisDimensions(4000, 3000)).toEqual({ width: 512, height: 384 });
    expect(analysisDimensions(300, 200)).toEqual({ width: 300, height: 200 });
  });

  it('converts RGBA to luma', () => {
    expect(Array.from(rgbaToGray(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255])))).toEqual([255, 0]);
  });
});
```

- [ ] **Step 5: Run it and confirm it fails**

Run: `npx vitest run shared`
Expected: FAIL, cannot resolve `./quality`.

- [ ] **Step 6: `shared/src/quality.ts`**

```ts
import type { QualityIssue, QualityResult } from './types';

export const QUALITY = {
  analysisSize: 512,
  minSharpness: 60,
  minBrightness: 50,
  maxBrightness: 215,
  minLongSide: 800,
  minShortSide: 600,
} as const;

export const QUALITY_MESSAGES: Record<QualityIssue, string> = {
  blurry: 'Too blurry',
  dark: 'Too dark',
  bright: 'Too bright',
  low_resolution: 'Resolution too low',
};

export function analysisDimensions(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, QUALITY.analysisSize / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function rgbaToGray(rgba: Uint8ClampedArray | Uint8Array): Uint8Array {
  const gray = new Uint8Array(rgba.length / 4);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
    gray[j] = Math.round(0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]);
  }
  return gray;
}

/** Variance of the 4-neighbour Laplacian over interior pixels. */
export function laplacianVariance(gray: Uint8Array, width: number, height: number): number {
  if (width < 3 || height < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const v = gray[i - width] + gray[i + width] + gray[i - 1] + gray[i + 1] - 4 * gray[i];
      sum += v;
      sumSq += v * v;
      n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

export function meanBrightness(gray: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < gray.length; i++) sum += gray[i];
  return gray.length ? sum / gray.length : 0;
}

export function assessQuality(
  gray: Uint8Array, width: number, height: number, originalWidth: number, originalHeight: number,
): QualityResult {
  const sharpness = laplacianVariance(gray, width, height);
  const brightness = meanBrightness(gray);
  const issues: QualityIssue[] = [];
  if (sharpness < QUALITY.minSharpness) issues.push('blurry');
  if (brightness < QUALITY.minBrightness) issues.push('dark');
  if (brightness > QUALITY.maxBrightness) issues.push('bright');
  const long = Math.max(originalWidth, originalHeight);
  const short = Math.min(originalWidth, originalHeight);
  if (long < QUALITY.minLongSide || short < QUALITY.minShortSide) issues.push('low_resolution');
  return {
    pass: issues.length === 0,
    sharpness: Math.round(sharpness * 10) / 10,
    brightness: Math.round(brightness * 10) / 10,
    width: originalWidth,
    height: originalHeight,
    issues,
  };
}
```

`shared/src/index.ts`:

```ts
export * from './vocab';
export * from './types';
export * from './quality';
```

- [ ] **Step 7: Run tests** — `npx vitest run shared` → all pass.
- [ ] **Step 8: Commit** — `git add -A && git commit -m "feat: workspace scaffold, shared vocabulary and quality metric"`

---

### Task 2: Rule modules (coverage, severity, cost, fraud, recommendation)

**Files:**
- Create: `server/package.json`, `server/tsconfig.json`, `server/src/pipeline/{coverage,severity,cost,fraud,action}.ts`
- Test: `server/test/rules.test.ts`

**Interfaces:**
- Consumes: types from `@claimlens/shared`.
- Produces:
  - `assessCoverage(photos: { angle: Angle | null; visibleParts: Part[] }[]): Coverage`
  - `mergeDamages(photos: { id: string; damages: Damage[] }[]): DamageItem[]`, `scoreSeverity(items: DamageItem[]): { score: number; band: SeverityBand }`
  - `makeTier(make: string): { tier: 'economy' | 'mid' | 'luxury'; multiplier: number }`, `estimateCost(items: DamageItem[], make: string): CostEstimate`
  - `assessFraud(input: FraudInput): FraudAssessment`, `hamming(a: string, b: string): number`, types `FraudInput`, `PriorHash`
  - `recommend(input: { fraudScore: number; severityScore: number; totalCost: number; coverage: Coverage }): Recommendation`

- [ ] **Step 1: Server package**

`server/package.json`:

```json
{
  "name": "@claimlens/server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts"
  },
  "dependencies": { "@claimlens/shared": "*" }
}
```

`server/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["src", "test", "../shared/src"]
}
```

Run: `npm install -w server express multer sharp exifr zod @anthropic-ai/sdk` then `npm install -w server -D tsx supertest @types/node @types/express @types/multer @types/supertest`

- [ ] **Step 2: Write the failing tests** (`server/test/rules.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import type { Coverage, Damage, DamageItem } from '@claimlens/shared';
import { PARTS } from '@claimlens/shared';
import { assessCoverage } from '../src/pipeline/coverage';
import { mergeDamages, scoreSeverity } from '../src/pipeline/severity';
import { estimateCost, makeTier } from '../src/pipeline/cost';
import { assessFraud, hamming } from '../src/pipeline/fraud';
import { recommend } from '../src/pipeline/action';

const dmg = (part: Damage['part'], type: Damage['type'], severity: Damage['severity']): Damage =>
  ({ part, type, severity, bbox: [0.1, 0.1, 0.2, 0.2], confidence: 0.9, note: '' });
const item = (part: Damage['part'], type: Damage['type'], severity: Damage['severity']): DamageItem =>
  mergeDamages([{ id: 'p1', damages: [dmg(part, type, severity)] }])[0];
const fullCoverage: Coverage = {
  angles: { front: true, side: true, rear: true },
  parts: Object.fromEntries(PARTS.map((p) => [p, true])) as Coverage['parts'],
  prompts: [],
  complete: true,
};

describe('coverage', () => {
  it('is complete when corner shots cover every angle and all parts are seen', () => {
    const c = assessCoverage([
      { angle: 'front-left', visibleParts: ['Front Bumper', 'Hood', 'Headlights', 'Windshield', 'Fenders', 'Doors'] },
      { angle: 'rear-right', visibleParts: ['Rear Bumper'] },
    ]);
    expect(c.complete).toBe(true);
    expect(c.prompts).toEqual([]);
  });

  it('prompts for missing angles and parts', () => {
    const c = assessCoverage([{ angle: 'left', visibleParts: ['Doors', 'Fenders'] }]);
    expect(c.angles).toEqual({ front: false, side: true, rear: false });
    expect(c.parts['Front Bumper']).toBe(false);
    expect(c.complete).toBe(false);
    expect(c.prompts).toContain('No front view found. Please add a photo of the front of the vehicle.');
    expect(c.prompts).toContain('No rear view found. Please add a photo of the back of the vehicle.');
    expect(c.prompts).toContain('Please upload a clearer image of the front bumper.');
  });

  it('ignores photos that were not analysed', () => {
    expect(assessCoverage([{ angle: null, visibleParts: [] }]).angles.side).toBe(false);
  });
});

describe('severity', () => {
  it('merges the same part and type across photos, keeping the highest severity', () => {
    const items = mergeDamages([
      { id: 'p1', damages: [dmg('Doors', 'Dent', 'Medium')] },
      { id: 'p2', damages: [dmg('Doors', 'Dent', 'High')] },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'doors-dent', severity: 'High', score: 32, photoIds: ['p1', 'p2'] });
  });

  it('sums weighted items and bands the score', () => {
    const items = [item('Doors', 'Dent', 'High'), item('Hood', 'Scratch', 'Low')];
    expect(scoreSeverity(items)).toEqual({ score: 37, band: 'Moderate' });
  });

  it('caps at 100 and scores an undamaged vehicle as 0', () => {
    const many = PARTS.map((p) => item(p, 'Severe Deformation', 'High'));
    expect(scoreSeverity(many)).toEqual({ score: 100, band: 'Severe' });
    expect(scoreSeverity([])).toEqual({ score: 0, band: 'Minor' });
  });
});

describe('cost', () => {
  it('prices a repair with paint and labour only', () => {
    const c = estimateCost([item('Doors', 'Dent', 'Medium')], 'Toyota');
    expect(c.lines[0]).toMatchObject({ operation: 'Repair', parts: 0, paint: 300, laborHours: 3, labor: 285, total: 585 });
    expect(c.total).toBe(585);
    expect(c.makeTier).toBe('economy');
  });

  it('replaces the part at high severity, scaled by make tier', () => {
    const c = estimateCost([item('Front Bumper', 'Dent', 'High')], 'bmw');
    expect(c.lines[0]).toMatchObject({ operation: 'Replace', parts: 855, paint: 450, laborHours: 5, labor: 475, total: 1780 });
  });

  it('always replaces broken glass, with no paint, and uses the mid tier for unknown makes', () => {
    const c = estimateCost([item('Windshield', 'Broken Glass', 'Low')], 'Unknown');
    expect(c.lines[0]).toMatchObject({ operation: 'Replace', parts: 520, paint: 0, laborHours: 1.5, labor: 142.5, total: 662.5 });
    expect(c.tierMultiplier).toBe(1.3);
  });

  it('totals equal the sum of the lines, and an empty estimate is zero', () => {
    const c = estimateCost(
      [item('Doors', 'Dent', 'Medium'), item('Hood', 'Scratch', 'Low'), item('Headlights', 'Crack', 'High')], 'Audi');
    expect(c.total).toBeCloseTo(c.lines.reduce((s, l) => s + l.total, 0), 2);
    expect(c.total).toBeCloseTo(c.partsTotal + c.paintTotal + c.laborTotal, 2);
    expect(estimateCost([], 'Toyota').total).toBe(0);
  });

  it('matches make names loosely', () => {
    expect(makeTier('Mercedes').tier).toBe('luxury');
    expect(makeTier('HONDA').tier).toBe('economy');
    expect(makeTier('').tier).toBe('mid');
  });
});

describe('fraud', () => {
  const photo = (id: string, over: Partial<{ sha256: string; dhash: string; software: string | null; capturedAt: string | null }> = {}) =>
    ({ id, sha256: `sha-${id}`, dhash: '00000000000000ff', software: null, capturedAt: '2026-10-01T10:00:00.000Z', ...over });
  const base = { priorHashes: [], observations: [], totalCost: 1000 };

  it('scores a clean claim as 0', () => {
    expect(assessFraud({ ...base, photos: [photo('p1'), photo('p2')] })).toMatchObject({ score: 0, band: 'Low', signals: [] });
  });

  it('flags exact and near duplicates from earlier claims', () => {
    const exact = assessFraud({ ...base, photos: [photo('p1')],
      priorHashes: [{ claimId: 'CLM-2026-0001', photoId: 'p3', sha256: 'sha-p1', dhash: 'ffffffffffffffff' }] });
    expect(exact.score).toBe(40);
    expect(exact.band).toBe('Medium');
    expect(exact.signals[0].detail).toContain('CLM-2026-0001');

    const near = assessFraud({ ...base, photos: [photo('p1')],
      priorHashes: [{ claimId: 'CLM-2026-0002', photoId: 'p1', sha256: 'other', dhash: '00000000000000fc' }] });
    expect(near.score).toBe(40);

    const far = assessFraud({ ...base, photos: [photo('p1')],
      priorHashes: [{ claimId: 'CLM-2026-0002', photoId: 'p1', sha256: 'other', dhash: 'ffffffffffffffff' }] });
    expect(far.score).toBe(0);
  });

  it('flags editing software and widely spread capture dates', () => {
    expect(assessFraud({ ...base, photos: [photo('p1', { software: 'Adobe Photoshop 25.0' })] }).score).toBe(20);
    expect(assessFraud({ ...base, photos: [photo('p1'), photo('p2', { capturedAt: '2026-08-01T10:00:00.000Z' })] }).score).toBe(10);
  });

  it('scores analyzer observations once per kind and caps at 100', () => {
    const f = assessFraud({
      photos: [photo('p1')],
      priorHashes: [{ claimId: 'CLM-2026-0001', photoId: 'p1', sha256: 'sha-p1', dhash: '0' }],
      observations: [
        { kind: 'vehicle_mismatch', detail: 'a' }, { kind: 'vehicle_mismatch', detail: 'b' },
        { kind: 'screen_recapture', detail: 'c' },
      ],
      totalCost: 1000,
    });
    expect(f.score).toBe(100);
    expect(f.band).toBe('High');
    expect(f.signals.filter((s) => s.kind === 'vehicle_mismatch')).toHaveLength(1);
  });

  it('flags totals above $12,000 only', () => {
    expect(assessFraud({ ...base, photos: [photo('p1')], totalCost: 12000 }).score).toBe(0);
    expect(assessFraud({ ...base, photos: [photo('p1')], totalCost: 12000.01 }).score).toBe(10);
  });

  it('reports missing EXIF as a note without scoring it', () => {
    const f = assessFraud({ ...base, photos: [photo('p1', { capturedAt: null })] });
    expect(f.score).toBe(0);
    expect(f.notes[0]).toMatch(/no EXIF/i);
  });

  it('computes Hamming distance between hex hashes', () => {
    expect(hamming('00000000000000ff', '00000000000000fc')).toBe(2);
  });
});

describe('recommendation', () => {
  const ok = { fraudScore: 0, severityScore: 10, totalCost: 500, coverage: fullCoverage };

  it('fast-tracks low-risk, minor, cheap claims, including undamaged vehicles', () => {
    expect(recommend(ok).action).toBe('Fast-track approval');
    expect(recommend({ ...ok, severityScore: 0, totalCost: 0 }).action).toBe('Fast-track approval');
  });

  it('requires manual review at each threshold', () => {
    expect(recommend({ ...ok, fraudScore: 60 }).action).toBe('Manual Adjuster Review Required');
    expect(recommend({ ...ok, severityScore: 60 }).action).toBe('Manual Adjuster Review Required');
    expect(recommend({ ...ok, totalCost: 8000.01 }).action).toBe('Manual Adjuster Review Required');
    const gap = { ...fullCoverage, complete: false, parts: { ...fullCoverage.parts, Hood: false } };
    const r = recommend({ ...ok, coverage: gap });
    expect(r.action).toBe('Manual Adjuster Review Required');
    expect(r.reasons.join(' ')).toContain('Hood');
  });

  it('falls back to standard review and says why', () => {
    const r = recommend({ ...ok, totalCost: 2500 });
    expect(r.action).toBe('Standard review');
    expect(r.reasons.length).toBeGreaterThan(0);
    expect(recommend({ ...ok, fraudScore: 30 }).action).toBe('Standard review');
    expect(recommend({ ...ok, severityScore: 25 }).action).toBe('Standard review');
  });
});
```

- [ ] **Step 3: Run and confirm failure** — `npx vitest run server/test/rules.test.ts` → FAIL (modules missing).

- [ ] **Step 4: `server/src/pipeline/coverage.ts`**

```ts
import { PARTS, type Angle, type Coverage, type Part } from '@claimlens/shared';

const FRONT: Angle[] = ['front', 'front-left', 'front-right'];
const SIDE: Angle[] = ['left', 'right', 'front-left', 'front-right', 'rear-left', 'rear-right'];
const REAR: Angle[] = ['rear', 'rear-left', 'rear-right'];

export function assessCoverage(photos: { angle: Angle | null; visibleParts: Part[] }[]): Coverage {
  const seen = photos.filter((p) => p.angle !== null);
  const has = (set: Angle[]) => seen.some((p) => set.includes(p.angle as Angle));
  const angles = { front: has(FRONT), side: has(SIDE), rear: has(REAR) };
  const parts = Object.fromEntries(
    PARTS.map((part) => [part, seen.some((p) => p.visibleParts.includes(part))]),
  ) as Record<Part, boolean>;

  const prompts: string[] = [];
  if (!angles.front) prompts.push('No front view found. Please add a photo of the front of the vehicle.');
  if (!angles.side) prompts.push('No side view found. Please add a photo of the side of the vehicle.');
  if (!angles.rear) prompts.push('No rear view found. Please add a photo of the back of the vehicle.');
  for (const part of PARTS) {
    if (!parts[part]) prompts.push(`Please upload a clearer image of the ${part.toLowerCase()}.`);
  }
  return { angles, parts, prompts, complete: prompts.length === 0 };
}
```

- [ ] **Step 5: `server/src/pipeline/severity.ts`**

```ts
import type { Damage, DamageItem, DamageType, Severity, SeverityBand } from '@claimlens/shared';

export const SEVERITY_WEIGHT: Record<Severity, number> = { Low: 8, Medium: 18, High: 32 };
export const TYPE_MULTIPLIER: Record<DamageType, number> = {
  Scratch: 0.6, 'Paint Damage': 0.7, Dent: 1.0, Crack: 1.1, 'Broken Glass': 1.3, 'Severe Deformation': 1.6,
};
const RANK: Record<Severity, number> = { Low: 0, Medium: 1, High: 2 };

const slug = (s: string) => s.toLowerCase().replace(/\s+/g, '-');
const itemScore = (type: DamageType, severity: Severity) =>
  Math.round(SEVERITY_WEIGHT[severity] * TYPE_MULTIPLIER[type] * 10) / 10;

export function mergeDamages(photos: { id: string; damages: Damage[] }[]): DamageItem[] {
  const byKey = new Map<string, DamageItem>();
  for (const photo of photos) {
    for (const d of photo.damages) {
      const id = `${slug(d.part)}-${slug(d.type)}`;
      const existing = byKey.get(id);
      if (!existing) {
        byKey.set(id, { id, part: d.part, type: d.type, severity: d.severity, score: itemScore(d.type, d.severity), photoIds: [photo.id] });
        continue;
      }
      if (RANK[d.severity] > RANK[existing.severity]) {
        existing.severity = d.severity;
        existing.score = itemScore(d.type, d.severity);
      }
      if (!existing.photoIds.includes(photo.id)) existing.photoIds.push(photo.id);
    }
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

export function scoreSeverity(items: DamageItem[]): { score: number; band: SeverityBand } {
  const score = Math.min(100, Math.round(items.reduce((sum, i) => sum + i.score, 0)));
  const band: SeverityBand = score >= 60 ? 'Severe' : score >= 25 ? 'Moderate' : 'Minor';
  return { score, band };
}
```

- [ ] **Step 6: `server/src/pipeline/cost.ts`**

```ts
import type { CostEstimate, CostLine, DamageItem, DamageType, Part, Severity } from '@claimlens/shared';

export const LABOR_RATE = 95;

export const PART_PRICE: Record<Part, number> = {
  'Front Bumper': 450, 'Rear Bumper': 420, Hood: 600, Headlights: 350, Doors: 700, Fenders: 380, Windshield: 400,
};

export const LABOR_HOURS: Record<DamageType, Record<Severity, number>> = {
  Scratch: { Low: 1.0, Medium: 2.0, High: 3.0 },
  'Paint Damage': { Low: 1.5, Medium: 2.5, High: 3.5 },
  Dent: { Low: 1.5, Medium: 3.0, High: 5.0 },
  Crack: { Low: 1.5, Medium: 2.5, High: 4.0 },
  'Broken Glass': { Low: 1.5, Medium: 2.0, High: 2.5 },
  'Severe Deformation': { Low: 4.0, Medium: 6.0, High: 9.0 },
};

export const PAINT: Record<Severity, number> = { Low: 150, Medium: 300, High: 450 };
const UNPAINTED: Part[] = ['Windshield', 'Headlights'];

const TIERS = {
  economy: { multiplier: 1.0, makes: ['toyota', 'honda', 'hyundai', 'kia', 'ford', 'chevrolet', 'nissan'] },
  mid: { multiplier: 1.3, makes: ['volkswagen', 'mazda', 'subaru', 'volvo', 'jeep'] },
  luxury: { multiplier: 1.9, makes: ['bmw', 'mercedes-benz', 'audi', 'lexus', 'tesla', 'porsche'] },
} as const;
type Tier = keyof typeof TIERS;

const round2 = (n: number) => Math.round(n * 100) / 100;

export function makeTier(make: string): { tier: Tier; multiplier: number } {
  const n = make.trim().toLowerCase();
  if (n.length >= 3) {
    for (const tier of Object.keys(TIERS) as Tier[]) {
      if (TIERS[tier].makes.some((m) => n === m || n.startsWith(m) || m.startsWith(n))) {
        return { tier, multiplier: TIERS[tier].multiplier };
      }
    }
  }
  return { tier: 'mid', multiplier: TIERS.mid.multiplier };
}

export function estimateCost(items: DamageItem[], make: string): CostEstimate {
  const { tier, multiplier } = makeTier(make);
  const lines: CostLine[] = items.map((item) => {
    const replace = item.severity === 'High' || item.type === 'Broken Glass';
    const parts = replace ? round2(PART_PRICE[item.part] * multiplier) : 0;
    const paint = UNPAINTED.includes(item.part) ? 0 : PAINT[item.severity];
    const laborHours = LABOR_HOURS[item.type][item.severity];
    const labor = round2(laborHours * LABOR_RATE);
    return {
      damageId: item.id, part: item.part, type: item.type, severity: item.severity,
      operation: replace ? 'Replace' : 'Repair',
      parts, paint, laborHours, laborRate: LABOR_RATE, labor, total: round2(parts + paint + labor),
    };
  });
  const sum = (pick: (l: CostLine) => number) => round2(lines.reduce((s, l) => s + pick(l), 0));
  return {
    lines,
    partsTotal: sum((l) => l.parts),
    paintTotal: sum((l) => l.paint),
    laborTotal: sum((l) => l.labor),
    laborHours: sum((l) => l.laborHours),
    total: sum((l) => l.total),
    makeTier: tier,
    tierMultiplier: multiplier,
    laborRate: LABOR_RATE,
  };
}
```

- [ ] **Step 7: `server/src/pipeline/fraud.ts`**

```ts
import type { Band3, FraudAssessment, FraudObservation, FraudObservationKind, FraudSignal } from '@claimlens/shared';

export interface PriorHash { claimId: string; photoId: string; sha256: string; dhash: string }
export interface FraudInput {
  photos: { id: string; sha256: string; dhash: string; software: string | null; capturedAt: string | null }[];
  priorHashes: PriorHash[];
  observations: FraudObservation[];
  totalCost: number;
}

export const DHASH_MAX_DISTANCE = 6;
const EDITORS = /photoshop|gimp|lightroom|affinity|pixelmator|snapseed|picsart|facetune/i;
const OBSERVATION: Record<FraudObservationKind, { label: string; points: number }> = {
  vehicle_mismatch: { label: 'Photos show different vehicles', points: 35 },
  screen_recapture: { label: 'Photo of a screen or printed photo', points: 30 },
  damage_inconsistency: { label: 'Damage inconsistent between angles', points: 20 },
};

export function hamming(a: string, b: string): number {
  let x = BigInt(`0x${a || '0'}`) ^ BigInt(`0x${b || '0'}`);
  let bits = 0;
  while (x > 0n) { bits += Number(x & 1n); x >>= 1n; }
  return bits;
}

export function assessFraud(input: FraudInput): FraudAssessment {
  const signals: FraudSignal[] = [];
  const notes: string[] = [];

  const dupes: string[] = [];
  for (const p of input.photos) {
    const match = input.priorHashes.find(
      (h) => h.sha256 === p.sha256 || (h.dhash.length === p.dhash.length && hamming(h.dhash, p.dhash) <= DHASH_MAX_DISTANCE),
    );
    if (match) dupes.push(`${p.id} matches ${match.photoId} in claim ${match.claimId}`);
  }
  if (dupes.length) {
    signals.push({ kind: 'duplicate_photo', label: 'Photo duplicates one in an earlier claim', detail: dupes.join('; '), points: 40 });
  }

  for (const kind of Object.keys(OBSERVATION) as FraudObservationKind[]) {
    const found = input.observations.filter((o) => o.kind === kind);
    if (found.length) {
      signals.push({ kind, label: OBSERVATION[kind].label, detail: found.map((o) => o.detail).join('; '), points: OBSERVATION[kind].points });
    }
  }

  const edited = input.photos.filter((p) => p.software && EDITORS.test(p.software));
  if (edited.length) {
    signals.push({
      kind: 'editing_software', label: 'EXIF shows editing software',
      detail: edited.map((p) => `${p.id}: ${p.software}`).join('; '), points: 20,
    });
  }

  const times = input.photos.map((p) => (p.capturedAt ? Date.parse(p.capturedAt) : NaN)).filter((t) => !Number.isNaN(t));
  if (times.length >= 2) {
    const days = (Math.max(...times) - Math.min(...times)) / 86_400_000;
    if (days > 30) {
      signals.push({ kind: 'date_spread', label: 'Capture dates more than 30 days apart', detail: `Photos span ${Math.round(days)} days`, points: 10 });
    }
  }
  const missing = input.photos.length - times.length;
  if (missing > 0) notes.push(`${missing} of ${input.photos.length} photos have no EXIF capture date (informational; many apps strip metadata).`);

  if (input.totalCost > 12_000) {
    signals.push({ kind: 'high_cost', label: 'Total cost above $12,000', detail: `Estimate is $${input.totalCost.toFixed(2)}`, points: 10 });
  }

  const score = Math.min(100, signals.reduce((s, x) => s + x.points, 0));
  const band: Band3 = score >= 60 ? 'High' : score >= 30 ? 'Medium' : 'Low';
  return { score, band, signals, notes };
}
```

- [ ] **Step 8: `server/src/pipeline/action.ts`**

```ts
import { PARTS, type Coverage, type Recommendation } from '@claimlens/shared';

export function recommend(input: {
  fraudScore: number; severityScore: number; totalCost: number; coverage: Coverage;
}): Recommendation {
  const { fraudScore, severityScore, totalCost, coverage } = input;
  const missing = PARTS.filter((p) => !coverage.parts[p]);

  const manual: string[] = [];
  if (fraudScore >= 60) manual.push(`Fraud score ${fraudScore} is 60 or higher`);
  if (severityScore >= 60) manual.push(`Severity score ${severityScore} is 60 or higher`);
  if (totalCost > 8000) manual.push('Estimated total exceeds $8,000');
  if (missing.length) manual.push(`Not inspected: ${missing.join(', ')}`);
  if (manual.length) return { action: 'Manual Adjuster Review Required', reasons: manual };

  if (fraudScore < 30 && severityScore < 25 && totalCost < 2500) {
    return { action: 'Fast-track approval', reasons: ['Low fraud risk, minor damage, and total under $2,500'] };
  }

  const reasons: string[] = [];
  if (fraudScore >= 30) reasons.push(`Fraud score ${fraudScore} is 30 or higher`);
  if (severityScore >= 25) reasons.push(`Severity score ${severityScore} is 25 or higher`);
  if (totalCost >= 2500) reasons.push('Estimated total is $2,500 or more');
  return { action: 'Standard review', reasons };
}
```

- [ ] **Step 9: Run tests** — `npx vitest run server/test/rules.test.ts` → all pass.
- [ ] **Step 10: Commit** — `git commit -am "feat: coverage, severity, cost, fraud and recommendation rules"` (after `git add -A`).

---

### Task 3: Image utilities

**Files:**
- Create: `server/src/util/prng.ts`, `server/src/images.ts`, `server/test/helpers.ts`
- Test: `server/test/images.test.ts`

**Interfaces:**
- Produces:
  - `mulberry32(seed: number): () => number`, `seedFromHex(hex: string): number`
  - `class UnreadableImageError extends Error`
  - `prepareImage(buf: Buffer): Promise<PreparedImage>` where `PreparedImage = { display: Buffer; width: number; height: number; quality: QualityResult; sha256: string; dhash: string; software: string | null; capturedAt: string | null }` (`display` is an orientation-corrected JPEG at most 2000 px on the long side; `width`/`height` are its dimensions; `quality.width/height` are the original oriented dimensions)
  - `modelImage(display: Buffer): Promise<string>` (base64 JPEG, long side ≤ 1568)
  - Test helpers: `sceneJpeg(seed: number, width?: number, height?: number): Promise<Buffer>`, `flatJpeg(width?: number, height?: number): Promise<Buffer>`

- [ ] **Step 1: `server/src/util/prng.ts`**

```ts
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const seedFromHex = (hex: string): number => parseInt(hex.slice(0, 8), 16) >>> 0;
```

- [ ] **Step 2: `server/test/helpers.ts`**

```ts
import sharp from 'sharp';
import { mulberry32 } from '../src/util/prng';

/** A sharp, mid-brightness synthetic photo: large blocks (stable perceptual hash) plus noise (high sharpness). */
export async function sceneJpeg(seed: number, width = 1200, height = 900): Promise<Buffer> {
  const rnd = mulberry32(seed);
  const blocks = Array.from({ length: 6 }, () => ({
    x: rnd() * width * 0.8, y: rnd() * height * 0.8,
    w: width * (0.15 + rnd() * 0.3), h: height * (0.15 + rnd() * 0.3), v: 70 + rnd() * 120,
  }));
  const px = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let base = 128;
      for (const b of blocks) if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) base = b.v;
      const v = Math.max(0, Math.min(255, Math.round(base + (rnd() - 0.5) * 90)));
      px.fill(v, (y * width + x) * 3, (y * width + x) * 3 + 3);
    }
  }
  return sharp(px, { raw: { width, height, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
}

export async function flatJpeg(width = 1200, height = 900): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 128, g: 128, b: 128 } } }).jpeg().toBuffer();
}
```

- [ ] **Step 3: Write the failing tests** (`server/test/images.test.ts`)

```ts
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { UnreadableImageError, modelImage, prepareImage } from '../src/images';
import { hamming } from '../src/pipeline/fraud';
import { flatJpeg, sceneJpeg } from './helpers';

describe('prepareImage', () => {
  it('passes a sharp photo and fails a featureless one', async () => {
    expect((await prepareImage(await sceneJpeg(1))).quality.pass).toBe(true);
    expect((await prepareImage(await flatJpeg())).quality.issues).toContain('blurry');
  });

  it('flags low resolution from the original size', async () => {
    const q = (await prepareImage(await sceneJpeg(1, 640, 480))).quality;
    expect(q.issues).toEqual(['low_resolution']);
    expect([q.width, q.height]).toEqual([640, 480]);
  });

  it('applies EXIF orientation so stored pixels match what a browser displays', async () => {
    const rotated = await sharp(await sceneJpeg(2, 1200, 900)).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const p = await prepareImage(rotated);
    expect([p.width, p.height]).toEqual([900, 1200]);
    expect([p.quality.width, p.quality.height]).toEqual([900, 1200]);
    const meta = await sharp(p.display).metadata();
    expect([meta.width, meta.height]).toEqual([900, 1200]);
    expect(meta.orientation ?? 1).toBe(1);
  });

  it('caps the stored image at 2000 px and outputs JPEG', async () => {
    const p = await prepareImage(await sceneJpeg(3, 2600, 1300));
    expect([p.width, p.height]).toEqual([2000, 1000]);
    expect((await sharp(p.display).metadata()).format).toBe('jpeg');
  });

  it('hashes: identical bytes match, re-encoded copies are near, different scenes are far', async () => {
    const a = await sceneJpeg(4);
    const reencoded = await sharp(a).jpeg({ quality: 55 }).toBuffer();
    const [pa, pa2, pr, pb] = await Promise.all([prepareImage(a), prepareImage(a), prepareImage(reencoded), prepareImage(await sceneJpeg(5))]);
    expect(pa.sha256).toBe(pa2.sha256);
    expect(pa.dhash).toHaveLength(16);
    expect(pr.sha256).not.toBe(pa.sha256);
    expect(hamming(pa.dhash, pr.dhash)).toBeLessThanOrEqual(6);
    expect(hamming(pa.dhash, pb.dhash)).toBeGreaterThan(6);
  });

  it('reads no EXIF from a synthetic image', async () => {
    const p = await prepareImage(await sceneJpeg(6));
    expect(p.software).toBeNull();
    expect(p.capturedAt).toBeNull();
  });

  it('rejects bytes that are not an image', async () => {
    await expect(prepareImage(Buffer.from('not an image at all'))).rejects.toBeInstanceOf(UnreadableImageError);
  });
});

describe('modelImage', () => {
  it('returns base64 JPEG no larger than 1568 px', async () => {
    const p = await prepareImage(await sceneJpeg(7, 2400, 1800));
    const meta = await sharp(Buffer.from(await modelImage(p.display), 'base64')).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBe(1568);
  });
});
```

- [ ] **Step 4: Run and confirm failure** — `npx vitest run server/test/images.test.ts` → FAIL.

- [ ] **Step 5: `server/src/images.ts`**

```ts
import { createHash } from 'node:crypto';
import exifr from 'exifr';
import sharp from 'sharp';
import { analysisDimensions, assessQuality, type QualityResult } from '@claimlens/shared';

export class UnreadableImageError extends Error {
  constructor() { super('File is not a readable image'); }
}

export interface PreparedImage {
  display: Buffer;
  width: number;
  height: number;
  quality: QualityResult;
  sha256: string;
  dhash: string;
  software: string | null;
  capturedAt: string | null;
}

const DISPLAY_MAX = 2000;
const MODEL_MAX = 1568;

async function dHash(buf: Buffer): Promise<string> {
  const px = await sharp(buf).rotate().greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) bits = (bits << 1n) | (px[y * 9 + x] > px[y * 9 + x + 1] ? 1n : 0n);
  }
  return bits.toString(16).padStart(16, '0');
}

async function readExif(buf: Buffer): Promise<{ software: string | null; capturedAt: string | null }> {
  try {
    const tags = await exifr.parse(buf, { pick: ['Software', 'DateTimeOriginal'] });
    const taken = tags?.DateTimeOriginal;
    return {
      software: typeof tags?.Software === 'string' ? tags.Software : null,
      capturedAt: taken instanceof Date && !Number.isNaN(taken.getTime()) ? taken.toISOString() : null,
    };
  } catch {
    return { software: null, capturedAt: null };
  }
}

export async function prepareImage(buf: Buffer): Promise<PreparedImage> {
  try {
    const meta = await sharp(buf).metadata();
    if (!meta.width || !meta.height) throw new UnreadableImageError();
    const swapped = (meta.orientation ?? 1) >= 5;
    const originalWidth = swapped ? meta.height : meta.width;
    const originalHeight = swapped ? meta.width : meta.height;

    const size = analysisDimensions(originalWidth, originalHeight);
    const gray = await sharp(buf).rotate().resize(size.width, size.height, { fit: 'fill' }).greyscale().raw().toBuffer();
    const quality = assessQuality(new Uint8Array(gray), size.width, size.height, originalWidth, originalHeight);

    const { data: display, info } = await sharp(buf).rotate()
      .resize(DISPLAY_MAX, DISPLAY_MAX, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 88 }).toBuffer({ resolveWithObject: true });

    return {
      display, width: info.width, height: info.height, quality,
      sha256: createHash('sha256').update(buf).digest('hex'),
      dhash: await dHash(buf),
      ...(await readExif(buf)),
    };
  } catch (err) {
    if (err instanceof UnreadableImageError) throw err;
    throw new UnreadableImageError();
  }
}

export async function modelImage(display: Buffer): Promise<string> {
  const out = await sharp(display)
    .resize(MODEL_MAX, MODEL_MAX, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  return out.toString('base64');
}
```

- [ ] **Step 6: Run tests** — `npx vitest run server/test/images.test.ts` → all pass. If the near-duplicate assertion is flaky for seed 4, change the seed, not the threshold.
- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat: image preparation, hashing and EXIF"`

---

### Task 4: Vision analyzers

**Files:**
- Create: `server/src/analyzers/{types,schema,demo,claude,index}.ts`
- Test: `server/test/analyzers.test.ts`

**Interfaces:**
- Consumes: `mulberry32`, `seedFromHex`, `modelImage`.
- Produces:
  - `interface PhotoInput { id: string; sha256: string; image: Buffer }`
  - `interface VisionAnalyzer { readonly mode: AnalysisMode; analyze(photos: PhotoInput[]): Promise<VisionResult> }`
  - `VisionOutputSchema` (zod), `sanitizeVision(raw: unknown, photoIds: string[]): VisionResult` (throws `Error('Model returned an invalid analysis')` when unusable)
  - `class DemoAnalyzer implements VisionAnalyzer`
  - `class ClaudeAnalyzer implements VisionAnalyzer` with `constructor(client: ParseClient, model: string)`
  - `createAnalyzer(config: { apiKey: string | undefined; model: string }): VisionAnalyzer`

- [ ] **Step 1: `server/src/analyzers/types.ts`**

```ts
import type { AnalysisMode, VisionResult } from '@claimlens/shared';

export interface PhotoInput { id: string; sha256: string; image: Buffer }

export interface VisionAnalyzer {
  readonly mode: AnalysisMode;
  analyze(photos: PhotoInput[]): Promise<VisionResult>;
}
```

- [ ] **Step 2: Write the failing tests** (`server/test/analyzers.test.ts`)

```ts
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
    const empty = new ClaudeAnalyzer({ messages: { parse: vi.fn().mockResolvedValue({ stop_reason: 'max_tokens', parsed_output: null }) } }, 'm');
    await expect(empty.analyze([{ id: 'p1', sha256: 'aa', image }])).rejects.toThrow(/invalid analysis/i);
  });
});
```

- [ ] **Step 3: Run and confirm failure** — `npx vitest run server/test/analyzers.test.ts` → FAIL.

- [ ] **Step 4: `server/src/analyzers/schema.ts`**

```ts
import { z } from 'zod';
import {
  ANGLES, DAMAGE_TYPES, FRAUD_OBSERVATION_KINDS, PARTS, SEVERITIES,
  type Damage, type FraudObservation, type Part, type PhotoAnalysis, type VehicleInfo, type VisionResult,
} from '@claimlens/shared';

const DamageSchema = z.object({
  part: z.enum(PARTS),
  type: z.enum(DAMAGE_TYPES),
  severity: z.enum(SEVERITIES),
  bbox: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  confidence: z.number(),
  note: z.string(),
});

const ObservationSchema = z.object({ kind: z.enum(FRAUD_OBSERVATION_KINDS), detail: z.string() });

/** The strict shape requested from the model. No numeric bounds: structured outputs do not enforce them. */
export const VisionOutputSchema = z.object({
  vehicle: z.object({
    make: z.string(), model: z.string(), year: z.string(), bodyType: z.string(), confidence: z.number(),
  }),
  photos: z.array(z.object({
    photoId: z.string(),
    angle: z.enum(ANGLES),
    visibleParts: z.array(z.enum(PARTS)),
    damages: z.array(DamageSchema),
  })),
  fraudObservations: z.array(ObservationSchema),
});

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : 'Unknown');
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function cleanDamage(raw: unknown): Damage | null {
  const parsed = DamageSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { bbox, ...rest } = parsed.data;
  const x = clamp01(bbox.x);
  const y = clamp01(bbox.y);
  const width = Math.min(clamp01(bbox.x + bbox.width), 1) - x;
  const height = Math.min(clamp01(bbox.y + bbox.height), 1) - y;
  if (!(width > 0.005) || !(height > 0.005)) return null;
  return { ...rest, bbox: [x, y, width, height], confidence: clamp01(rest.confidence) };
}

/** Lenient clean-up of analyzer output: drop what is invalid, keep what is usable. */
export function sanitizeVision(raw: unknown, photoIds: string[]): VisionResult {
  if (!isRecord(raw) || !Array.isArray(raw.photos)) throw new Error('Model returned an invalid analysis');

  const v = isRecord(raw.vehicle) ? raw.vehicle : {};
  const vehicle: VehicleInfo = {
    make: text(v.make), model: text(v.model), year: text(v.year), bodyType: text(v.bodyType),
    confidence: typeof v.confidence === 'number' ? clamp01(v.confidence) : 0,
  };

  const byId = new Map<string, PhotoAnalysis>();
  for (const p of raw.photos) {
    if (!isRecord(p) || typeof p.photoId !== 'string' || !photoIds.includes(p.photoId) || byId.has(p.photoId)) continue;
    const angle = z.enum(ANGLES).safeParse(p.angle);
    const damages = (Array.isArray(p.damages) ? p.damages : []).map(cleanDamage).filter((d): d is Damage => d !== null);
    const visible = new Set<Part>(
      (Array.isArray(p.visibleParts) ? p.visibleParts : []).filter((x): x is Part => PARTS.includes(x as Part)),
    );
    for (const d of damages) visible.add(d.part);
    byId.set(p.photoId, {
      photoId: p.photoId,
      angle: angle.success ? angle.data : 'other',
      visibleParts: PARTS.filter((part) => visible.has(part)),
      damages,
    });
  }

  const photos = photoIds.map((id) => byId.get(id) ?? { photoId: id, angle: 'other' as const, visibleParts: [], damages: [] });
  const fraudObservations: FraudObservation[] = (Array.isArray(raw.fraudObservations) ? raw.fraudObservations : [])
    .map((o) => ObservationSchema.safeParse(o))
    .flatMap((r) => (r.success ? [r.data] : []));

  return { vehicle, photos, fraudObservations };
}
```

- [ ] **Step 5: `server/src/analyzers/demo.ts`**

```ts
import { createHash } from 'node:crypto';
import {
  DAMAGE_TYPES, SEVERITIES,
  type Angle, type Damage, type DamageType, type Part, type PhotoAnalysis, type VehicleInfo, type VisionResult,
} from '@claimlens/shared';
import { mulberry32, seedFromHex } from '../util/prng';
import type { PhotoInput, VisionAnalyzer } from './types';

const VEHICLES: Omit<VehicleInfo, 'confidence'>[] = [
  { make: 'Toyota', model: 'Camry', year: '2022', bodyType: 'Sedan' },
  { make: 'Honda', model: 'CR-V', year: '2021', bodyType: 'SUV' },
  { make: 'BMW', model: '3 Series', year: '2020', bodyType: 'Sedan' },
  { make: 'Ford', model: 'F-150', year: '2019', bodyType: 'Pickup' },
  { make: 'Volkswagen', model: 'Golf', year: '2021', bodyType: 'Hatchback' },
  { make: 'Tesla', model: 'Model 3', year: '2023', bodyType: 'Sedan' },
];

const ANGLE_ORDER: Angle[] = ['front-left', 'rear-right', 'left', 'front', 'rear', 'right', 'front-right', 'rear-left', 'detail', 'detail'];

const VISIBLE: Record<Angle, Part[]> = {
  front: ['Front Bumper', 'Hood', 'Headlights', 'Windshield'],
  'front-left': ['Front Bumper', 'Hood', 'Headlights', 'Windshield', 'Fenders', 'Doors'],
  'front-right': ['Front Bumper', 'Hood', 'Headlights', 'Windshield', 'Fenders', 'Doors'],
  left: ['Doors', 'Fenders'],
  right: ['Doors', 'Fenders'],
  rear: ['Rear Bumper'],
  'rear-left': ['Rear Bumper', 'Doors', 'Fenders'],
  'rear-right': ['Rear Bumper', 'Doors', 'Fenders'],
  detail: [],
  other: [],
};

const GLASS: Part[] = ['Windshield', 'Headlights'];

/** Deterministic stand-in used when no API key is configured. Results are seeded from the photo hashes. */
export class DemoAnalyzer implements VisionAnalyzer {
  readonly mode = 'demo' as const;

  async analyze(photos: PhotoInput[]): Promise<VisionResult> {
    const digest = createHash('sha256').update(photos.map((p) => p.sha256).sort().join('|')).digest('hex');
    const rnd = mulberry32(seedFromHex(digest));
    const pick = <T,>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)];

    const result: PhotoAnalysis[] = photos.map((p, i) => {
      const angle = ANGLE_ORDER[i % ANGLE_ORDER.length];
      return { photoId: p.id, angle, visibleParts: [...VISIBLE[angle]], damages: [] };
    });

    const candidates = result.filter((p) => p.visibleParts.length > 0);
    const count = candidates.length ? 2 + Math.floor(rnd() * 3) : 0;
    const used = new Set<string>();
    for (let placed = 0, tries = 0; placed < count && tries < 60; tries++) {
      const photo = pick(candidates);
      const part = pick(photo.visibleParts);
      const type: DamageType = GLASS.includes(part)
        ? pick(['Crack', 'Broken Glass'] as const)
        : pick(DAMAGE_TYPES.filter((t) => t !== 'Broken Glass'));
      if (used.has(`${photo.photoId}|${part}|${type}`)) continue;
      used.add(`${photo.photoId}|${part}|${type}`);
      const width = 0.14 + rnd() * 0.2;
      const height = 0.12 + rnd() * 0.18;
      const damage: Damage = {
        part, type, severity: pick(SEVERITIES),
        bbox: [0.08 + rnd() * (0.84 - width), 0.15 + rnd() * (0.75 - height), width, height],
        confidence: Math.round((0.7 + rnd() * 0.28) * 100) / 100,
        note: `Simulated ${type.toLowerCase()} on the ${part.toLowerCase()} (demo mode).`,
      };
      photo.damages.push(damage);
      placed++;
    }

    return {
      vehicle: { ...pick(VEHICLES), confidence: Math.round((0.75 + rnd() * 0.2) * 100) / 100 },
      photos: result,
      fraudObservations: [],
    };
  }
}
```

- [ ] **Step 6: `server/src/analyzers/claude.ts`**

```ts
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { DAMAGE_TYPES, PARTS, type VisionResult } from '@claimlens/shared';
import { modelImage } from '../images';
import { VisionOutputSchema, sanitizeVision } from './schema';
import type { PhotoInput, VisionAnalyzer } from './types';

/** The slice of the Anthropic client this analyzer uses, so tests can substitute a fake. */
export interface ParseClient {
  messages: { parse(params: any): Promise<{ stop_reason: string | null; parsed_output: unknown }> };
}

const SYSTEM = `You assess vehicle damage for an insurance claims system. You receive several photos of what should be one vehicle. Each photo is preceded by a line giving its photo id.

For each photo report:
- angle: the viewpoint. Use "detail" for close-ups where the overall viewpoint cannot be determined.
- visibleParts: which of these parts are visible well enough to inspect: ${PARTS.join(', ')}. Leave a part out if it is hidden, cropped away, or too small to judge.
- damages: every damaged region you can actually see. Do not infer damage that is out of view. If the same damage appears in several photos, report it in each one.
  - part: one of the parts above. type: one of ${DAMAGE_TYPES.join(', ')}.
  - severity: Low = cosmetic, surface only. Medium = clear damage that needs bodywork but the part is repairable. High = the part is structurally compromised or needs replacing.
  - bbox: a tight box around the damaged region, as fractions of the image width and height (0 to 1), with x and y at the top-left corner.
  - confidence: 0 to 1. note: one short sentence describing what you see.

For the vehicle give your best estimate of make, model, year (a single year or a range such as "2019-2022") and body type. Use "Unknown" for anything you cannot determine. confidence is 0 to 1.

fraudObservations: add an entry only when it is clearly evident. vehicle_mismatch: the photos show different vehicles. screen_recapture: a photo is a picture of a screen or of a printed photo. damage_inconsistency: damage visible in one photo is clearly absent from another photo of the same area. Otherwise return an empty list.

An undamaged vehicle is a valid result: return empty damages lists.`;

export class ClaudeAnalyzer implements VisionAnalyzer {
  readonly mode = 'claude' as const;

  constructor(private readonly client: ParseClient, private readonly model: string) {}

  static fromApiKey(apiKey: string, model: string): ClaudeAnalyzer {
    return new ClaudeAnalyzer(new Anthropic({ apiKey }) as unknown as ParseClient, model);
  }

  async analyze(photos: PhotoInput[]): Promise<VisionResult> {
    const content: Anthropic.ContentBlockParam[] = [];
    for (const photo of photos) {
      content.push({ type: 'text', text: `Photo id: ${photo.id}` });
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await modelImage(photo.image) } });
    }
    content.push({ type: 'text', text: `Assess these ${photos.length} photos. Return one entry per photo id.` });

    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 16000,
      system: SYSTEM,
      messages: [{ role: 'user', content }],
      output_config: { effort: 'medium', format: zodOutputFormat(VisionOutputSchema) },
    });

    if (response.stop_reason === 'refusal') throw new Error('The model declined to analyse these photos');
    if (!response.parsed_output) throw new Error('Model returned an invalid analysis');
    return sanitizeVision(response.parsed_output, photos.map((p) => p.id));
  }
}
```

`server/src/analyzers/index.ts`:

```ts
import { ClaudeAnalyzer } from './claude';
import { DemoAnalyzer } from './demo';
import type { VisionAnalyzer } from './types';

export function createAnalyzer(config: { apiKey: string | undefined; model: string }): VisionAnalyzer {
  return config.apiKey ? ClaudeAnalyzer.fromApiKey(config.apiKey, config.model) : new DemoAnalyzer();
}

export type { PhotoInput, VisionAnalyzer } from './types';
```

- [ ] **Step 7: Run tests** — `npx vitest run server/test/analyzers.test.ts` → all pass. Then `npx tsc -p server --noEmit`; if the SDK types reject `output_config.effort` beside `format` or the `zodOutputFormat` import path, fix against the installed SDK's type errors (do not add `tool_choice`).
- [ ] **Step 8: Commit** — `git add -A && git commit -m "feat: demo and Claude vision analyzers with output sanitizing"`

---

### Task 5: Claim store, progress events and the pipeline

**Files:**
- Create: `server/src/store.ts`, `server/src/events.ts`, `server/src/pipeline/report.ts`, `server/src/pipeline/run.ts`
- Test: `server/test/pipeline.test.ts`

**Interfaces:**
- Consumes: Task 2 rules, `VisionAnalyzer`, `PriorHash`.
- Produces:
  - `class ClaimStore { constructor(path: string); nextId(now?: Date): string; insert(r: ClaimReport): void; save(r: ClaimReport): void; get(id: string): ClaimReport | null; list(): ClaimSummary[]; setStatus(id: string, status: ClaimStatus): ClaimReport | null; hashesExcluding(claimId: string): PriorHash[]; close(): void }`
  - `class EventBus { start(id: string): void; emit(id: string, e: PipelineEvent): void; subscribe(id: string, fn: (e: PipelineEvent) => void): () => void; hasRun(id: string): boolean }` (subscribe replays history)
  - `emptyReport(id: string, createdAt: string, mode: AnalysisMode, photos: PhotoRecord[]): ClaimReport`
  - `interface PipelineDeps { store: ClaimStore; analyzer: VisionAnalyzer; events: EventBus; uploadsDir: string; stageDelayMs: number }`, `runPipeline(deps: PipelineDeps, claimId: string): Promise<void>` (never rejects for analysis errors; records `failed`)
  - Photo files live at `<uploadsDir>/<claimId>/<photoId>.jpg`.

- [ ] **Step 1: Write the failing tests** (`server/test/pipeline.test.ts`)

```ts
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

  it('never returns a claim’s own hashes as prior hashes', async () => {
    const a = await addClaim([1, 2, 3, 4]);
    const b = await addClaim([5, 6, 7, 8]);
    expect(deps.store.hashesExcluding(a).every((h) => h.claimId === b)).toBe(true);
    expect(deps.store.hashesExcluding(a)).toHaveLength(4);
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
```

- [ ] **Step 2: Run and confirm failure** — `npx vitest run server/test/pipeline.test.ts` → FAIL.

- [ ] **Step 3: `server/src/events.ts`**

```ts
import type { PipelineEvent } from '@claimlens/shared';

type Listener = (event: PipelineEvent) => void;

/** In-memory progress events per claim. History is kept so late subscribers see the whole run. */
export class EventBus {
  private runs = new Map<string, { history: PipelineEvent[]; listeners: Set<Listener> }>();

  start(id: string): void {
    const existing = this.runs.get(id);
    this.runs.set(id, { history: [], listeners: existing?.listeners ?? new Set() });
  }

  emit(id: string, event: PipelineEvent): void {
    const run = this.runs.get(id);
    if (!run) return;
    run.history.push(event);
    for (const listener of [...run.listeners]) listener(event);
  }

  subscribe(id: string, listener: Listener): () => void {
    let run = this.runs.get(id);
    if (!run) { run = { history: [], listeners: new Set() }; this.runs.set(id, run); }
    for (const event of run.history) listener(event);
    run.listeners.add(listener);
    return () => { this.runs.get(id)?.listeners.delete(listener); };
  }

  hasRun(id: string): boolean {
    return (this.runs.get(id)?.history.length ?? 0) > 0;
  }
}
```

- [ ] **Step 4: `server/src/pipeline/report.ts`**

```ts
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
```

- [ ] **Step 5: `server/src/store.ts`**

```ts
import { DatabaseSync } from 'node:sqlite';
import type { ClaimReport, ClaimStatus, ClaimSummary } from '@claimlens/shared';
import type { PriorHash } from './pipeline/fraud';

const vehicleLabel = (r: ClaimReport) =>
  [r.vehicle.year, r.vehicle.make, r.vehicle.model].filter((s) => s && s !== 'Unknown').join(' ') || 'Unknown vehicle';

export class ClaimStore {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS claims (
        id TEXT PRIMARY KEY, year INTEGER NOT NULL, seq INTEGER NOT NULL, created_at TEXT NOT NULL,
        status TEXT NOT NULL, state TEXT NOT NULL, vehicle TEXT NOT NULL, total_cost REAL NOT NULL,
        fraud_score INTEGER NOT NULL, action TEXT NOT NULL, report TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS photo_hashes (
        claim_id TEXT NOT NULL, photo_id TEXT NOT NULL, sha256 TEXT NOT NULL, dhash TEXT NOT NULL,
        PRIMARY KEY (claim_id, photo_id)
      );
      CREATE INDEX IF NOT EXISTS claims_created ON claims (created_at);
    `);
  }

  nextId(now = new Date()): string {
    const year = now.getUTCFullYear();
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM claims WHERE year = ?').get(year) as { seq: number };
    return `CLM-${year}-${String(row.seq + 1).padStart(4, '0')}`;
  }

  insert(report: ClaimReport): void {
    const [, year, seq] = report.id.split('-');
    this.db.prepare(
      `INSERT INTO claims (id, year, seq, created_at, status, state, vehicle, total_cost, fraud_score, action, report)
       VALUES (?, ?, ?, ?, '', '', '', 0, 0, '', '')`,
    ).run(report.id, Number(year), Number(seq), report.createdAt);
    this.save(report);
  }

  save(report: ClaimReport): void {
    this.db.prepare(
      `UPDATE claims SET status = ?, state = ?, vehicle = ?, total_cost = ?, fraud_score = ?, action = ?, report = ? WHERE id = ?`,
    ).run(report.status, report.state, vehicleLabel(report), report.cost.total, report.fraud.score,
      report.recommendation.action, JSON.stringify(report), report.id);
    this.db.prepare('DELETE FROM photo_hashes WHERE claim_id = ?').run(report.id);
    const add = this.db.prepare('INSERT INTO photo_hashes (claim_id, photo_id, sha256, dhash) VALUES (?, ?, ?, ?)');
    for (const p of report.photos) add.run(report.id, p.id, p.sha256, p.dhash);
  }

  get(id: string): ClaimReport | null {
    const row = this.db.prepare('SELECT report FROM claims WHERE id = ?').get(id) as { report: string } | undefined;
    return row ? (JSON.parse(row.report) as ClaimReport) : null;
  }

  list(): ClaimSummary[] {
    const rows = this.db.prepare('SELECT report FROM claims ORDER BY created_at DESC, seq DESC').all() as { report: string }[];
    return rows.map((row) => {
      const r = JSON.parse(row.report) as ClaimReport;
      return {
        id: r.id, createdAt: r.createdAt, vehicle: vehicleLabel(r), totalCost: r.cost.total,
        fraudScore: r.fraud.score, fraudBand: r.fraud.band, severityScore: r.severity.score,
        action: r.recommendation.action, status: r.status, state: r.state, thumbnailUrl: r.photos[0]?.url ?? null,
      };
    });
  }

  setStatus(id: string, status: ClaimStatus): ClaimReport | null {
    const report = this.get(id);
    if (!report) return null;
    report.status = status;
    this.save(report);
    return report;
  }

  hashesExcluding(claimId: string): PriorHash[] {
    const rows = this.db.prepare(
      'SELECT claim_id AS claimId, photo_id AS photoId, sha256, dhash FROM photo_hashes WHERE claim_id <> ?',
    ).all(claimId);
    return rows as unknown as PriorHash[];
  }

  close(): void { this.db.close(); }
}
```

- [ ] **Step 6: `server/src/pipeline/run.ts`**

```ts
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
      priorHashes: store.hashesExcluding(claimId),
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
```

- [ ] **Step 7: Run tests** — `npx vitest run server/test/pipeline.test.ts` → all pass. If Vitest cannot resolve `node:sqlite`, add `server: { deps: { external: [/node:sqlite/] } }` under `test` in `vitest.config.ts`.
- [ ] **Step 8: Commit** — `git add -A && git commit -m "feat: claim store, progress events and pipeline orchestrator"`

---

### Task 6: HTTP API

**Files:**
- Create: `server/src/config.ts`, `server/src/app.ts`, `server/src/index.ts`, `.env.example`
- Test: `server/test/api.test.ts`

**Interfaces:**
- Consumes: `PipelineDeps`, `runPipeline`, `prepareImage`, `UnreadableImageError`, `emptyReport`.
- Produces: `createApp(deps: PipelineDeps & { clientDist?: string }): express.Express` and the routes in spec section 4. Error bodies are `{ error: string, photos?: { filename: string; quality: QualityResult | null; error?: string }[] }`. Upload field name is `photos`.

- [ ] **Step 1: Write the failing tests** (`server/test/api.test.ts`)

```ts
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
```

Note for the retry test: `createApp` must read `deps.analyzer` at request time (pass the `deps` object through, do not destructure the analyzer at construction).

- [ ] **Step 2: Run and confirm failure** — `npx vitest run server/test/api.test.ts` → FAIL.

- [ ] **Step 3: `server/src/app.ts`**

```ts
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
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 20 } });
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

  const start = (claimId: string) => {
    void runPipeline(deps, claimId).catch((err) => console.error(`Pipeline crashed for ${claimId}`, err));
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
    const id = deps.store.nextId();
    deps.store.insert(emptyReport(id, new Date().toISOString(), deps.analyzer.mode, []));
    const report = deps.store.get(id)!;
    report.photos = await storePhotos(id, 0, prepared);
    deps.store.save(report);
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
    if (report.state === 'processing') throw new HttpError(409, 'This claim is still being analysed.');
    const prepared = await prepareAll(files);
    report.photos.push(...(await storePhotos(report.id, report.photos.length, prepared)));
    deps.store.save(report);
    start(report.id);
    res.json({ id: report.id });
  });

  app.post('/api/claims/:id/retry', (req, res) => {
    const report = claimOr404(req);
    if (report.state === 'processing') throw new HttpError(409, 'This claim is still being analysed.');
    start(report.id);
    res.json({ id: report.id });
  });

  app.get('/api/claims/:id', (req, res) => { res.json(claimOr404(req)); });

  app.patch('/api/claims/:id', (req, res) => {
    claimOr404(req);
    const status = req.body?.status as ClaimStatus;
    if (!CLAIM_STATUSES.includes(status)) throw new HttpError(400, 'Status must be pending, approved or rejected.');
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
```

The `subscribe` replay can deliver a terminal event before `off` is assigned; the `let off = () => {}` placeholder plus the `writableEnded` check after it covers that.

- [ ] **Step 4: `server/src/config.ts`, `server/src/index.ts`, `.env.example`**

`server/src/config.ts`:

```ts
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

try { process.loadEnvFile(resolve(root, '.env')); } catch { /* no .env file: demo mode */ }

export const config = {
  port: Number(process.env.PORT ?? 3001),
  apiKey: process.env.ANTHROPIC_API_KEY?.trim() || undefined,
  model: process.env.CLAUDE_MODEL?.trim() || 'claude-opus-5-5',
  dataDir: resolve(root, 'server/data'),
  uploadsDir: resolve(root, 'server/uploads'),
  clientDist: resolve(root, 'client/dist'),
};

mkdirSync(config.dataDir, { recursive: true });
mkdirSync(config.uploadsDir, { recursive: true });
```

`server/src/index.ts`:

```ts
import { join } from 'node:path';
import { createAnalyzer } from './analyzers';
import { createApp } from './app';
import { config } from './config';
import { EventBus } from './events';
import { ClaimStore } from './store';

const analyzer = createAnalyzer(config);
const app = createApp({
  store: new ClaimStore(join(config.dataDir, 'claims.db')),
  analyzer,
  events: new EventBus(),
  uploadsDir: config.uploadsDir,
  // Demo analysis is instant; pace the stages so the progress view is readable.
  stageDelayMs: analyzer.mode === 'demo' ? 450 : 0,
  clientDist: config.clientDist,
});

app.listen(config.port, () => {
  console.log(`ClaimLens API on http://localhost:${config.port} (analysis mode: ${analyzer.mode})`);
});
```

`.env.example`:

```
# Leave ANTHROPIC_API_KEY empty to run in demo mode (simulated analysis).
ANTHROPIC_API_KEY=
CLAUDE_MODEL=claude-opus-5-5
PORT=3001
```

- [ ] **Step 5: Run everything** — `npx vitest run` → all pass; `npx tsc -p server --noEmit` → clean.
- [ ] **Step 6: Smoke-start** — `npm run start -w server` prints the listening line with `analysis mode: demo`; stop it.
- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat: claims HTTP API with uploads and progress stream"`

---

### Task 7: Client shell (scaffold, theme, routing, API client, design tokens)

**Files:**
- Create: `client/package.json`, `client/tsconfig.json`, `client/vite.config.ts`, `client/index.html`, `client/src/{main.tsx,App.tsx,styles.css,theme.ts,api.ts}`, `client/src/lib/{format.ts,boxes.ts,claimsFilter.ts,imageQuality.ts}`, `client/src/pages/NotFoundPage.tsx`, `client/src/components/Badge.tsx`
- Test: `client/src/lib/boxes.test.ts`, `client/src/lib/claimsFilter.test.ts`

**Interfaces:**
- Produces:
  - `api`: `getConfig(): Promise<{ analysisMode: AnalysisMode }>`, `createClaim(files: File[]): Promise<{ id: string }>`, `addPhotos(id: string, files: File[]): Promise<{ id: string }>`, `retryClaim(id: string): Promise<void>`, `getClaim(id: string): Promise<ClaimReport>`, `listClaims(): Promise<ClaimSummary[]>`, `setStatus(id: string, status: ClaimStatus): Promise<ClaimReport>`, `watchClaim(id: string, onEvent: (e: PipelineEvent) => void): () => void`; failures throw `ApiError` with `status`, `message`, `photos?`
  - `checkImageQuality(file: File): Promise<QualityResult>`
  - `toPixels(bbox: BBox, width: number, height: number): BoxRect`, `hitTest(boxes: { id: string; rect: BoxRect }[], x: number, y: number): string | null`
  - `filterClaims(claims: ClaimSummary[], filters: ClaimFilters): ClaimSummary[]`, `sortClaims(claims: ClaimSummary[], key: SortKey, dir: 'asc' | 'desc'): ClaimSummary[]`
  - `money(n: number): string`, `shortDate(iso: string): string`
  - `useTheme(): { theme: 'light' | 'dark'; toggle(): void }`
  - `<Badge tone="good|warn|bad|neutral|info">`

- [ ] **Step 1: Scaffold**

`client/package.json`:

```json
{
  "name": "@claimlens/client",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": { "dev": "vite", "build": "vite build", "preview": "vite preview" },
  "dependencies": { "@claimlens/shared": "*" }
}
```

Run: `npm install -w client react react-dom react-router-dom` and `npm install -w client -D vite @vitejs/plugin-react @types/react @types/react-dom`

`client/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": { "jsx": "react-jsx", "lib": ["ES2022", "DOM", "DOM.Iterable"], "types": ["vite/client"] },
  "include": ["src", "../shared/src"]
}
```

`client/vite.config.ts`:

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3001', '/uploads': 'http://localhost:3001' },
  },
});
```

`client/index.html`: standard Vite entry with `<title>ClaimLens</title>`, `<div id="root">`, `<script type="module" src="/src/main.tsx">`, and an inline script in `<head>` that sets `document.documentElement.dataset.theme` from `localStorage.getItem('claimlens-theme')` or `matchMedia('(prefers-color-scheme: dark)')` before first paint, wrapped in try/catch.

- [ ] **Step 2: Failing tests for the pure helpers**

`client/src/lib/boxes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { hitTest, toPixels } from './boxes';

describe('boxes', () => {
  it('scales fractional boxes to pixels', () => {
    expect(toPixels([0.25, 0.5, 0.5, 0.25], 800, 400)).toEqual({ x: 200, y: 200, w: 400, h: 100 });
  });

  it('hit-tests, preferring the smallest box under the pointer', () => {
    const boxes = [
      { id: 'big', rect: { x: 0, y: 0, w: 400, h: 400 } },
      { id: 'small', rect: { x: 100, y: 100, w: 50, h: 50 } },
    ];
    expect(hitTest(boxes, 120, 120)).toBe('small');
    expect(hitTest(boxes, 300, 300)).toBe('big');
    expect(hitTest(boxes, 500, 500)).toBeNull();
  });
});
```

`client/src/lib/claimsFilter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { ClaimSummary } from '@claimlens/shared';
import { filterClaims, sortClaims, type ClaimFilters } from './claimsFilter';

const claim = (over: Partial<ClaimSummary>): ClaimSummary => ({
  id: 'CLM-2026-0001', createdAt: '2026-10-01T00:00:00.000Z', vehicle: '2022 Toyota Camry', totalCost: 1000,
  fraudScore: 10, fraudBand: 'Low', severityScore: 20, action: 'Fast-track approval', status: 'pending',
  state: 'done', thumbnailUrl: null, ...over,
});
const all: ClaimFilters = { search: '', action: 'all', status: 'all', fraudBand: 'all' };
const claims = [
  claim({}),
  claim({ id: 'CLM-2026-0002', vehicle: '2020 BMW 3 Series', totalCost: 9000, fraudScore: 70, fraudBand: 'High', action: 'Manual Adjuster Review Required', status: 'rejected' }),
  claim({ id: 'CLM-2026-0003', vehicle: '2021 Honda CR-V', totalCost: 3000, fraudScore: 35, fraudBand: 'Medium', action: 'Standard review', status: 'approved' }),
];

describe('claims filtering and sorting', () => {
  it('searches claim id and vehicle, case-insensitively', () => {
    expect(filterClaims(claims, { ...all, search: 'bmw' }).map((c) => c.id)).toEqual(['CLM-2026-0002']);
    expect(filterClaims(claims, { ...all, search: '0003' }).map((c) => c.id)).toEqual(['CLM-2026-0003']);
  });

  it('combines filters', () => {
    expect(filterClaims(claims, { ...all, fraudBand: 'High', status: 'rejected' })).toHaveLength(1);
    expect(filterClaims(claims, { ...all, action: 'Standard review', status: 'pending' })).toHaveLength(0);
    expect(filterClaims(claims, all)).toHaveLength(3);
  });

  it('sorts numbers numerically and text alphabetically, in both directions, without mutating', () => {
    expect(sortClaims(claims, 'totalCost', 'desc').map((c) => c.totalCost)).toEqual([9000, 3000, 1000]);
    expect(sortClaims(claims, 'vehicle', 'asc').map((c) => c.id)).toEqual(['CLM-2026-0002', 'CLM-2026-0003', 'CLM-2026-0001']);
    expect(claims[0].id).toBe('CLM-2026-0001');
  });
});
```

Run: `npx vitest run client` → FAIL.

- [ ] **Step 3: Helpers**

`client/src/lib/boxes.ts`:

```ts
import type { BBox } from '@claimlens/shared';

export interface BoxRect { x: number; y: number; w: number; h: number }

export function toPixels(bbox: BBox, width: number, height: number): BoxRect {
  return { x: bbox[0] * width, y: bbox[1] * height, w: bbox[2] * width, h: bbox[3] * height };
}

/** The id of the smallest box containing the point, so nested boxes stay selectable. */
export function hitTest(boxes: { id: string; rect: BoxRect }[], x: number, y: number): string | null {
  let best: { id: string; area: number } | null = null;
  for (const { id, rect } of boxes) {
    if (x < rect.x || x > rect.x + rect.w || y < rect.y || y > rect.y + rect.h) continue;
    const area = rect.w * rect.h;
    if (!best || area < best.area) best = { id, area };
  }
  return best?.id ?? null;
}
```

`client/src/lib/claimsFilter.ts`:

```ts
import type { Band3, ClaimStatus, ClaimSummary, RecommendedAction } from '@claimlens/shared';

export interface ClaimFilters {
  search: string;
  action: RecommendedAction | 'all';
  status: ClaimStatus | 'all';
  fraudBand: Band3 | 'all';
}
export type SortKey = 'id' | 'vehicle' | 'totalCost' | 'fraudScore' | 'action' | 'status' | 'createdAt';

export function filterClaims(claims: ClaimSummary[], f: ClaimFilters): ClaimSummary[] {
  const q = f.search.trim().toLowerCase();
  return claims.filter((c) =>
    (!q || c.id.toLowerCase().includes(q) || c.vehicle.toLowerCase().includes(q)) &&
    (f.action === 'all' || c.action === f.action) &&
    (f.status === 'all' || c.status === f.status) &&
    (f.fraudBand === 'all' || c.fraudBand === f.fraudBand));
}

export function sortClaims(claims: ClaimSummary[], key: SortKey, dir: 'asc' | 'desc'): ClaimSummary[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...claims].sort((a, b) => {
    const x = a[key];
    const y = b[key];
    const order = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
    return order * sign;
  });
}
```

`client/src/lib/format.ts`:

```ts
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
export const money = (n: number) => usd.format(n);
export const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
```

`client/src/lib/imageQuality.ts`:

```ts
import { analysisDimensions, assessQuality, rgbaToGray, type QualityResult } from '@claimlens/shared';

/** Runs the same quality metric as the server, in the browser, for instant feedback. */
export async function checkImageQuality(file: File): Promise<QualityResult> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const size = analysisDimensions(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0, size.width, size.height);
    const gray = rgbaToGray(ctx.getImageData(0, 0, size.width, size.height).data);
    return assessQuality(gray, size.width, size.height, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}
```

Run: `npx vitest run client` → pass.

- [ ] **Step 4: `client/src/api.ts`**

```ts
import type { AnalysisMode, ClaimReport, ClaimStatus, ClaimSummary, PipelineEvent, QualityResult } from '@claimlens/shared';

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly photos?: { filename: string; quality: QualityResult }[]) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check that it is running.');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body?.error ?? `Request failed (${res.status})`, body?.photos);
  return body as T;
}

const form = (files: File[]) => {
  const data = new FormData();
  for (const f of files) data.append('photos', f);
  return data;
};
const json = (method: string, body: unknown): RequestInit =>
  ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const api = {
  getConfig: () => call<{ analysisMode: AnalysisMode }>('/api/config'),
  createClaim: (files: File[]) => call<{ id: string }>('/api/claims', { method: 'POST', body: form(files) }),
  addPhotos: (id: string, files: File[]) => call<{ id: string }>(`/api/claims/${id}/photos`, { method: 'POST', body: form(files) }),
  retryClaim: (id: string) => call<{ id: string }>(`/api/claims/${id}/retry`, { method: 'POST' }).then(() => undefined),
  getClaim: (id: string) => call<ClaimReport>(`/api/claims/${id}`),
  listClaims: () => call<ClaimSummary[]>('/api/claims'),
  setStatus: (id: string, status: ClaimStatus) => call<ClaimReport>(`/api/claims/${id}`, json('PATCH', { status })),

  /** Streams pipeline progress. If the stream drops, reports the stored outcome instead. */
  watchClaim(id: string, onEvent: (e: PipelineEvent) => void): () => void {
    const source = new EventSource(`/api/claims/${id}/events`);
    let finished = false;
    source.onmessage = (msg) => {
      const event = JSON.parse(msg.data) as PipelineEvent;
      if (event.type !== 'stage') { finished = true; source.close(); }
      onEvent(event);
    };
    source.onerror = () => {
      if (finished) return;
      source.close();
      api.getClaim(id).then(
        (r) => onEvent(r.state === 'done' ? { type: 'done' } : { type: 'failed', error: r.error ?? 'Lost connection during analysis.' }),
        () => onEvent({ type: 'failed', error: 'Lost connection during analysis.' }),
      );
    };
    return () => { finished = true; source.close(); };
  },
};
```

- [ ] **Step 5: Theme, shell, tokens**

`client/src/theme.ts`: `useTheme()` holds `'light' | 'dark'` in state initialised from `document.documentElement.dataset.theme`; `toggle()` flips it, writes `dataset.theme`, and saves to `localStorage['claimlens-theme']` inside try/catch.

`client/src/App.tsx`: `BrowserRouter` with a header (wordmark "ClaimLens", nav links "New claim" → `/`, "Claims" → `/claims`, a "Demo mode" `Badge` when `api.getConfig()` returns `demo` with the title text "No API key set: analysis results are simulated", and the theme toggle button with `aria-label`). Routes: `/` → `SubmitPage`, `/claims` → `ClaimsPage`, `/claims/:id` → `ReportPage`, `*` → `NotFoundPage`. Until Tasks 8–10 land, each page is a stub exporting a heading.

`client/src/styles.css`: one stylesheet. Colour tokens on `:root` for light and overridden under `:root[data-theme="dark"]`: `--bg`, `--surface`, `--surface-2`, `--border`, `--text`, `--text-muted`, `--accent`, `--accent-contrast`, `--good`, `--warn`, `--bad`, `--info`, each with a `-soft` background partner for badges; severity colours `--sev-low`, `--sev-medium`, `--sev-high` chosen to stay distinguishable in both themes. Layout primitives: `.page` (max-width 1200px, 16px gutters), `.card`, `.grid` helpers, `.btn` / `.btn-primary` / `.btn-ghost`, `.badge`, `.table`, visible `:focus-visible` rings. Tabular numerals on money and score columns. `@media (prefers-reduced-motion: reduce)` disables transitions. `@media print` rules are added in Task 9.

`client/src/components/Badge.tsx`: `<span className={`badge badge-${tone}`}>{children}</span>`.

- [ ] **Step 6: Verify** — `npx tsc -p client --noEmit` clean; `npm run dev`, open `http://localhost:5173`, confirm the header renders, navigation works, the theme toggle switches and survives reload, and the Demo mode badge shows.
- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat: client shell, theme toggle, API client and helpers"`

---

### Task 8: Claim submission wizard

**Files:**
- Create: `client/src/pages/SubmitPage.tsx`, `client/src/components/{DropZone,PhotoCard,PipelineProgress,CoveragePrompt}.tsx`
- Modify: `client/src/styles.css`

**Interfaces:**
- Consumes: `api`, `checkImageQuality`, `QUALITY_MESSAGES`, `STAGES`, `STAGE_LABELS`.
- Produces: the `/` screen. On completion it navigates to `/claims/:id`.

Behaviour (each bullet is a step; verify in the browser after each):

- [ ] **Step 1: `DropZone`** — props `{ onFiles(files: File[]): void; disabled?: boolean }`. A labelled region that accepts drag-and-drop and click/keyboard to open a hidden `<input type="file" multiple accept="image/jpeg,image/png,image/webp">`. Highlights on drag-over. Non-image files are ignored with an inline message naming them.
- [ ] **Step 2: Photo list state in `SubmitPage`** — items `{ key: string; file: File; previewUrl: string; quality: QualityResult | null; error: string | null }`. Adding files appends up to 10 total (extra files are refused with "A claim can hold at most 10 photos"), creates object URLs, and runs `checkImageQuality` per file; a rejected promise sets `error: 'Could not read this image'`. Object URLs are revoked on removal and unmount.
- [ ] **Step 3: `PhotoCard`** — props `{ item; onRemove(): void }`. Thumbnail, filename, and a badge: "Checking…" while `quality` is null, green "Pass", or red "Fail" followed by the reasons from `QUALITY_MESSAGES` joined with ", ". A remove button with `aria-label="Remove <filename>"`.
- [ ] **Step 4: Submit bar** — shows "N of 10 photos, M passed". The Submit button is enabled when there are 4–10 photos, none still checking, and at least 4 pass. When disabled, a line says exactly what is missing ("Add at least 4 photos" / "At least 4 photos must pass the quality check"). A hint lists the required views: front, side, rear.
- [ ] **Step 5: Submitting** — call `api.createClaim(files)`. On `ApiError` show its message inline above the grid; when it carries `photos`, overwrite each matching item's quality with the server's result (the server is authoritative). On success switch to the progress view and call `api.watchClaim`.
- [ ] **Step 6: `PipelineProgress`** — props `{ events: PipelineEvent[]; mode: AnalysisMode }`. A vertical stepper over `STAGES` with `STAGE_LABELS`; each step is pending, running (spinner) or done (check) from the events. Heading "Running AI analysis pipeline"; in demo mode a sub-line "Demo mode: results are simulated". Uses `aria-live="polite"` for the current stage.
- [ ] **Step 7: Outcomes** — on `done`, fetch the report. If `coverage.complete`, navigate to `/claims/:id`. Otherwise render `CoveragePrompt` with props `{ prompts: string[]; canAdd: boolean; onAdd(files: File[]): void; onContinue(): void }`: the list of prompts, a small drop zone ("Add photos and re-run", hidden when the claim already has 10 photos) that calls `api.addPhotos` then returns to the progress view, and "Continue to report" with the note "Parts not shown will be marked Not inspected and the claim will go to manual review". On `failed`, show the error with a Retry button (`api.retryClaim`, then watch again) and a "Start over" button.
- [ ] **Step 8: Verify** — with the server in demo mode: drop 3 photos (Submit disabled with reason); add a tiny or blurred image (Fail badge with reason); drop 5 good photos (Pass badges), submit, watch the stages advance, land on the report URL. `npx tsc -p client --noEmit` clean.
- [ ] **Step 9: Commit** — `git add -A && git commit -m "feat: claim submission wizard"`

---

### Task 9: Interactive assessment report

**Files:**
- Create: `client/src/pages/ReportPage.tsx`, `client/src/components/{DamageViewer,VehicleCard,SeverityGauge,CostTable,FraudPanel,CoverageChecklist,ActionBanner}.tsx`
- Modify: `client/src/styles.css` (report layout and print rules)

**Interfaces:**
- Consumes: `api.getClaim`, `api.setStatus`, `api.retryClaim`, `toPixels`, `hitTest`, `money`, `shortDate`.
- Produces: the `/claims/:id` screen.

- [ ] **Step 1: Page states** — loading skeleton; 404 → the not-found view; `state === 'processing'` → progress view reusing `PipelineProgress` via `api.watchClaim`, then reload; `state === 'failed'` → error with Retry; `done` → the report.
- [ ] **Step 2: Header** — claim id, date, status badge, `analysisMode` badge when demo, and actions: "Export JSON" (downloads `<id>.json` from a Blob of the report, pretty-printed), "Print / PDF" (`window.print()`).
- [ ] **Step 3: `ActionBanner`** — props `{ recommendation: Recommendation }`. Full-width banner coloured by action (good / info / bad) with the action as the heading and the reasons as a list.
- [ ] **Step 4: `DamageViewer`** — props `{ photos: PhotoRecord[]; selectedPhotoId: string; onSelectPhoto(id: string): void; activeDamage: { photoId: string; index: number } | null; onActiveDamage(d: … | null): void }`.
  - A thumbnail strip; each thumbnail shows a damage count and a "Fail" marker for photos that failed quality.
  - The main view is an `<img>` with an absolutely positioned `<canvas>` on top, sized to the image's rendered box with `devicePixelRatio` scaling and redrawn through a `ResizeObserver`.
  - Each damage on the selected photo is drawn from `toPixels(bbox, w, h)`: a 2 px stroke in the severity colour, a translucent fill, and a label chip "`<Part>` · `<Type>`" kept inside the canvas. The active box gets a thicker stroke and stronger fill.
  - `pointermove` uses `hitTest` to set the active damage and the cursor; `pointerleave` clears it. A tooltip beside the pointer shows part, type, severity, confidence as a percentage, and the note.
  - Below the image, the same damages are a keyboard-focusable list; focusing or hovering a row activates its box (and vice versa), so the overlay is not the only way to reach the information.
  - A photo with no damages shows "No damage detected in this photo"; a photo that failed quality shows "Not analysed: " plus its quality reasons.
- [ ] **Step 5: `VehicleCard`** — make, model, year, body type, identification confidence; "Unknown" values are shown muted.
- [ ] **Step 6: `SeverityGauge`** — props `{ score: number; band: SeverityBand }`. A horizontal 0–100 track with the three band segments (0–24, 25–59, 60–100) labelled Minor / Moderate / Severe, a marker at the score, the score as a large number and the band as a badge. Has `role="meter"` with `aria-valuenow/min/max` and `aria-valuetext`. Read the `dataviz` skill before building this component.
- [ ] **Step 7: `CostTable`** — props `{ cost: CostEstimate }`. Columns: Part, Damage, Operation, Parts, Paint, Labour hours, Rate, Labour, Line total. A footer row with the column totals and a prominent grand total. A caption states the make tier and multiplier and the labour rate. Zero damages renders "No repairs required" with a $0.00 total. On narrow screens the table scrolls horizontally inside its card.
- [ ] **Step 8: `FraudPanel`** — props `{ fraud: FraudAssessment }`. Score with band badge, each signal as a row (label, detail, "+N"), then the notes in muted text. No signals renders "No fraud indicators found".
- [ ] **Step 9: `CoverageChecklist`** — props `{ coverage: Coverage }`. The three angles and seven parts with a check or a "Not inspected" marker, each with a text label (not colour alone).
- [ ] **Step 10: Layout** — two columns on wide screens (viewer left, summary panels right), one column under 900 px. Order in a single column: banner, viewer, vehicle, severity, cost, fraud, coverage.
- [ ] **Step 11: Print stylesheet** — under `@media print`: hide the app header, buttons and the thumbnail strip; force light tokens; single column; `break-inside: avoid` on cards; print every photo that has damages as a static image with its damage list beneath (rendered in a print-only section, since canvas overlays are tied to the selected photo); the cost table spans the page width.
- [ ] **Step 12: Verify** — open a demo claim: boxes sit over the image and track on window resize; hover and keyboard focus both highlight; switching photos redraws; Export JSON downloads valid JSON whose `cost.total` matches the screen; print preview shows the whole report on white. Check both themes. `npx tsc -p client --noEmit` clean.
- [ ] **Step 13: Commit** — `git add -A && git commit -m "feat: interactive assessment report with export and print"`

---

### Task 10: Adjuster portal

**Files:**
- Create: `client/src/pages/ClaimsPage.tsx`
- Modify: `client/src/styles.css`

**Interfaces:**
- Consumes: `api.listClaims`, `api.setStatus`, `filterClaims`, `sortClaims`, `money`, `shortDate`.

- [ ] **Step 1: Data and states** — load on mount; loading, error (with Retry) and empty ("No claims yet" with a link to New claim) states.
- [ ] **Step 2: Filter bar** — a search input (Claim ID or vehicle) and three selects: Recommended action, Status, Fraud risk, each with an "All" option. A count "Showing N of M" and a "Clear filters" button when any filter is active. No results under active filters renders "No claims match these filters".
- [ ] **Step 3: Table** — columns Claim ID, Vehicle, Total Cost, Fraud Score, Recommended Action, Status, Submitted. Every header is a button that sorts by that column and toggles direction, with `aria-sort` on the `<th>`. Default sort: Submitted, newest first. Fraud score is a number plus band badge; action and status are badges; a claim still processing or failed shows that state in place of the action.
- [ ] **Step 4: Row actions** — the claim id links to `/claims/:id`. Approve and Reject buttons call `api.setStatus` and update the row in place; the current status's button is disabled; a failed update shows an inline error on that row. A "Reset" action returns the status to pending.
- [ ] **Step 5: Verify** — create three demo claims, then confirm search, each filter, each column sort in both directions, and Approve / Reject persisting across reload. `npx tsc -p client --noEmit` clean.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: adjuster portal with filtering, sorting and status actions"`

---

### Task 11: README and end-to-end verification

**Files:**
- Create: `README.md`

- [ ] **Step 1: README** — what the app does; prerequisites (Node 24+); `npm install`; `cp .env.example .env` and the two modes (demo with no key, Claude with `ANTHROPIC_API_KEY`); `npm run dev` (client on 5173, API on 3001); `npm test`; `npm start` for a single-port build; where data lives (`server/data`, `server/uploads`) and how to reset it; the scoring rules in brief with a pointer to the spec; known limits (bounding boxes not polygons, placeholder pricing, no authentication, demo-mode results are simulated).
- [ ] **Step 2: Full checks** — `npm test` (all pass), `npm run typecheck` (clean), `npm run build` (succeeds).
- [ ] **Step 3: End-to-end in a real browser** — start `npm run dev`; using a Playwright script kept outside the repo, with generated test photos: submit a claim through the wizard, wait for the report, and capture screenshots of the wizard, the report (both themes) and the claims list. Inspect the screenshots for layout problems and misaligned boxes. Confirm the JSON export and the status change through the UI.
- [ ] **Step 4: Claude mode** — if `ANTHROPIC_API_KEY` is available, run one claim with real car photos and confirm the response parses and boxes land on the damage. If no key is available, say so in the final summary rather than claiming it was verified.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "docs: README and final verification"`
