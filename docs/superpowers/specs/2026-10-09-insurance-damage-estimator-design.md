# AI-Powered Insurance Damage Estimator: Design

Date: 2026-10-09
Status: awaiting review

## 1. Goal

A web app where a customer uploads 4–10 photos of a damaged vehicle. An AI pipeline
checks photo quality, identifies the vehicle, locates and classifies damage, scores
severity, estimates repair cost, and scores fraud risk. The result is an interactive
report for the customer and a claims list for insurance adjusters.

Assumptions (not stated in the brief):

- Hackathon demo: runs locally, no login, single currency (USD).
- The customer and the adjuster use the same app; the adjuster portal is a separate screen, not a separate deployment.

Out of scope: authentication, payments, real parts-pricing feeds, polygon
segmentation (damage regions are bounding boxes), mobile-native apps, deployment.

## 2. Architecture

One TypeScript repository, npm workspaces:

```
client/   Vite + React + TypeScript (UI)
server/   Express + TypeScript (API, pipeline, storage)
shared/   Types and constants used by both (parts, damage types, report shape)
```

- `npm run dev` at the root starts both; the client proxies `/api` and `/uploads` to the server.
- Storage: SQLite through Node 24's built-in `node:sqlite` (file `server/data/claims.db`). Photos are stored on disk under `server/uploads/<claimId>/`.
- Server image work (decode, resize, greyscale, hashing) uses `sharp`; EXIF reading uses `exifr`.
- Configuration through `.env`: `ANTHROPIC_API_KEY` (optional), `CLAUDE_MODEL` (default `claude-opus-5-5`), `PORT`.

### Analyzer interface

The only part of the pipeline that needs a model sits behind one interface:

```ts
interface VisionAnalyzer {
  readonly mode: 'claude' | 'demo';
  analyze(photos: PhotoInput[]): Promise<VisionResult>;
}
```

- `ClaudeAnalyzer` is used when `ANTHROPIC_API_KEY` is set. It sends all photos (resized to at most 1568 px on the long side) in one request and forces a JSON result through a tool schema.
- `DemoAnalyzer` is used otherwise. It is deterministic: results are seeded from the photos' SHA-256 hashes, so the same photos always give the same report. The UI shows a "Demo mode" badge and the report records `analysisMode: "demo"`.
- If the key is set and the Claude call fails, the claim is marked `failed` with the error message and a Retry button. It does not silently switch to demo data.

`VisionResult`:

```ts
{
  vehicle: { make, model, year, bodyType, confidence },   // strings may be "Unknown"
  photos: [{
    photoId,
    angle: 'front' | 'rear' | 'left' | 'right' | 'front-left' | 'front-right'
         | 'rear-left' | 'rear-right' | 'detail' | 'other',
    visibleParts: Part[],
    damages: [{ part, type, severity, bbox: [x, y, width, height], confidence, note }]
  }],
  fraudObservations: [{ kind: 'vehicle_mismatch' | 'screen_recapture' | 'damage_inconsistency', detail }]
}
```

`bbox` values are fractions of the image (0–1), origin top-left, so they render
correctly at any display size.

Fixed vocabularies (in `shared/`):

- Parts: Front Bumper, Hood, Headlights, Doors, Rear Bumper, Fenders, Windshield.
- Damage types: Scratch, Dent, Crack, Broken Glass, Paint Damage, Severe Deformation.
- Severity: Low, Medium, High.

## 3. Pipeline

Stages run in order on the server. Each stage emits a progress event over
Server-Sent Events so the wizard can show which stage is running.

### 3.1 Image quality

Computed on a greyscale copy resized to 512 px on the long side.

| Check | Metric | Pass when |
|---|---|---|
| Sharpness | Variance of the 3×3 Laplacian | ≥ 60 |
| Brightness | Mean luma (0–255) | 50 to 215 |
| Resolution | Original pixel size | long side ≥ 800 and short side ≥ 600 |

The same function runs in the browser (canvas) for instant Pass/Fail badges as
photos are dropped, and on the server as the authoritative result. A failed photo
shows the reason ("Too blurry", "Too dark", "Too bright", "Resolution too low").
Photos that fail on the server are still stored but excluded from vision analysis.
Fewer than 4 passing photos blocks submission.

### 3.2 Vision analysis

One `VisionAnalyzer.analyze` call, as defined above.

### 3.3 Coverage

- Angle coverage: at least one photo each showing the front, a side, and the rear (corner angles count for both of their sides).
- Part coverage: each of the 7 parts must appear in `visibleParts` of at least one photo.

Each gap produces a prompt, for example "Please upload a clearer image of the front
bumper" or "No rear view found. Please add a photo of the back of the vehicle".

The pipeline still completes. When gaps exist, the wizard shows the prompts with
two choices: **Add photos and re-run** (adds photos to the same claim and reruns
the pipeline) or **Continue to report**. In the report, uncovered parts appear as
"Not inspected" and the claim is routed to manual review.

### 3.4 Severity score

Damages for the same part and type across photos are merged, keeping the highest
severity. Each merged item scores `severityWeight × typeMultiplier`:

| Severity | Weight | | Type | Multiplier |
|---|---|---|---|---|
| Low | 8 | | Scratch | 0.6 |
| Medium | 18 | | Paint Damage | 0.7 |
| High | 32 | | Dent | 1.0 |
| | | | Crack | 1.1 |
| | | | Broken Glass | 1.3 |
| | | | Severe Deformation | 1.6 |

Overall score = sum of item scores, rounded, capped at 100.
Bands: 0–24 Minor, 25–59 Moderate, 60–100 Severe.

### 3.5 Repair cost

Rules-based so every figure can be explained. One line per merged damage item:

- **Operation**: High severity, or Broken Glass at any severity, means *Replace*; otherwise *Repair*.
- **Parts**: base part price × make tier, charged only for *Replace*.
- **Labour**: hours from a table by damage type and severity, × $95/hour.
- **Paint**: flat amount per painted panel by severity; none for Windshield and Headlights.

Base part prices (USD): Front Bumper 450, Rear Bumper 420, Hood 600, Headlights 350,
Doors 700, Fenders 380, Windshield 400.

Make tiers: economy ×1.0 (e.g. Toyota, Honda, Hyundai, Kia, Ford, Chevrolet, Nissan),
mid ×1.3 (e.g. Volkswagen, Mazda, Subaru, Volvo, Jeep), luxury ×1.9 (e.g. BMW,
Mercedes-Benz, Audi, Lexus, Tesla, Porsche). Unknown makes use ×1.3.

Labour hours:

| Type | Low | Medium | High |
|---|---|---|---|
| Scratch | 1.0 | 2.0 | 3.0 |
| Paint Damage | 1.5 | 2.5 | 3.5 |
| Dent | 1.5 | 3.0 | 5.0 |
| Crack | 1.5 | 2.5 | 4.0 |
| Broken Glass | 1.5 | 2.0 | 2.5 |
| Severe Deformation | 4.0 | 6.0 | 9.0 |

Paint per panel: Low 150, Medium 300, High 450.

The table shows part, damage, operation, parts, paint, labour hours, labour rate,
labour cost and line total, then subtotals and a grand total. The grand total always
equals the sum of the line totals.

### 3.6 Fraud risk

The brief names fraud alerts without defining them. Signals and points:

| Signal | Source | Points |
|---|---|---|
| Photo duplicates one in an earlier claim | SHA-256 match, or 64-bit dHash within Hamming distance 6 | 40 |
| Photos show different vehicles | Analyzer observation | 35 |
| Photo of a screen or printed photo | Analyzer observation | 30 |
| Damage inconsistent between angles | Analyzer observation | 20 |
| EXIF shows editing software | `Software` tag (Photoshop, GIMP, Lightroom, etc.) | 20 |
| Capture dates more than 30 days apart | EXIF `DateTimeOriginal` | 10 |
| Total cost above $12,000 | Cost stage | 10 |

Fraud score = sum, capped at 100. Bands: 0–29 Low, 30–59 Medium, 60–100 High.
Each triggered signal is listed in the report with its detail. Missing EXIF is
reported as informational and scores 0, because many apps strip it.

### 3.7 Recommended action

First matching rule wins:

1. Fraud ≥ 60, or severity ≥ 60, or total > $8,000, or any part not inspected: **Manual Adjuster Review Required**.
2. Fraud < 30 and severity < 25 and total < $2,500: **Fast-track approval**.
3. Otherwise: **Standard review**.

The report states which conditions produced the recommendation.

## 4. API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/claims` | Multipart upload of 4–10 photos (JPEG, PNG, WebP; 15 MB each). Creates the claim, starts the pipeline, returns `{ id }`. |
| GET | `/api/claims/:id/events` | SSE stream of stage progress, ending with `done` or `failed`. |
| POST | `/api/claims/:id/photos` | Add photos to an existing claim and rerun the pipeline. |
| POST | `/api/claims/:id/retry` | Rerun the pipeline after a failure. |
| GET | `/api/claims/:id` | Full report JSON. |
| GET | `/api/claims` | Claim list for the adjuster portal. |
| PATCH | `/api/claims/:id` | Set status: `pending`, `approved` or `rejected`. |
| GET | `/api/config` | `{ analysisMode }` for the demo-mode badge. |

Claim IDs look like `CLM-2026-0001`. The full report is stored as one JSON column
plus indexed summary columns (vehicle, total, fraud score, action, status, created
date) for the list view.

## 5. Screens

A shared shell has the navigation, a dark/light toggle (saved per browser, defaulting
to the system setting) and the demo-mode badge.

1. **Claim submission wizard** (`/`): drop zone for 4–10 photos; a thumbnail grid where each photo gets a Pass/Fail badge and reason as soon as it is added; Submit enabled when at least 4 photos pass; a stepper showing the running pipeline stage; the coverage prompt screen when gaps exist.
2. **Assessment report** (`/claims/:id`): photo strip and a large viewer drawing damage boxes on a canvas, coloured by severity, with hover and click linking a box to its row in the damage list; vehicle card; severity gauge with band; cost table; fraud indicators; part coverage checklist; recommended action with reasons; Export JSON; Print / PDF preview (a print stylesheet that lays the report out for paper, opened with the browser's print dialog).
3. **Adjuster portal** (`/claims`): table with Claim ID, Vehicle, Total Cost, Fraud Score, Recommended Action, Status and date; sort on every column; text search plus filters for action, status and fraud band; Approve / Reject on each row; rows open the report.

## 6. Error handling

- Upload validation errors (wrong type, too large, wrong count) return 400 with a message shown inline in the wizard.
- A stage failure marks the claim `failed`, stores the message and ends the SSE stream with `failed`; the wizard offers Retry.
- Malformed model output (schema mismatch, box outside 0–1, unknown part) is validated with `zod`: invalid damage items are dropped, boxes are clamped, and a wholly invalid response fails the stage.
- Unknown claim IDs return 404 and the client shows a not-found page.

## 7. Testing

- Unit tests (Vitest) for the pure modules: quality metrics, coverage, severity, cost, fraud scoring, recommended action, and model-output validation.
- API tests for the claim lifecycle using `DemoAnalyzer` and a temporary database.
- A manual end-to-end run of all three screens in demo mode before calling the work complete; a run against the Claude API if a key is available.
