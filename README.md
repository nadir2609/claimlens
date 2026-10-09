# ClaimLens: AI-Powered Insurance Damage Estimator

Upload 4–10 photos of a damaged vehicle and get an assessment report: vehicle identification, damaged regions drawn on the photos, a severity score, an itemised repair estimate, a fraud risk score and a recommended action. An adjuster portal lists every claim.

## Run it

Requires Node 24 or newer (the server uses the built-in `node:sqlite`).

```bash
npm install
cp .env.example .env      # optional, see "Analysis modes"
npm run dev
```

- App: http://localhost:5173
- API: http://localhost:3001

Other commands:

| Command | What it does |
|---|---|
| `npm test` | Runs the unit and API tests |
| `npm run typecheck` | Type-checks the server and client |
| `npm start` | Builds the client and serves everything from port 3001 |

## Analysis modes

Set a key in `.env` to choose the provider. If both keys are set, Gemini is used.

| Mode | When | What you get |
|---|---|---|
| Gemini | `GEMINI_API_KEY` is set | Photos are analysed by Google Gemini (`gemini-2.5-flash`, change with `GEMINI_MODEL`). Has a free tier with daily and per-minute limits. Get a key at https://aistudio.google.com/apikey |
| Claude | `ANTHROPIC_API_KEY` is set and no Gemini key | Photos are analysed by Claude (`claude-opus-5-5`, change with `CLAUDE_MODEL`). Paid |
| Demo | No key | Vehicle, damage and boxes are **simulated**, seeded from the photos so the same photos give the same report. The UI shows a "Demo mode" badge |

In every mode the image quality check, severity score, cost estimate, fraud score and recommendation are computed by the same code. If a model call fails, the claim is marked failed with a Retry button; it does not fall back to simulated data.

## How the pipeline works

1. **Quality**: blur (variance of the Laplacian) and brightness. Runs in the browser for instant Pass/Fail badges and again on the server, which is authoritative. At least 4 photos must pass.
2. **Vision**: vehicle make, model, year and body type; per photo, the viewing angle, visible parts and damaged regions as `[x, y, width, height]` fractions of the image.
3. **Coverage**: front, side and rear views, and all seven parts (Front Bumper, Hood, Headlights, Doors, Rear Bumper, Fenders, Windshield) must be visible somewhere. Gaps produce re-upload prompts; parts never shown are reported as "Not inspected".
4. **Severity**: a 0–100 score from damage type and severity.
5. **Cost**: parts, paint and labour per damage item, in AZN. For a part that must be replaced, the app searches avtopro.az and ehtiyathisseleri.az through Firecrawl and uses the cheapest matching listing, with a link (see "Part prices").
6. **Fraud**: photos reused from earlier claims, editing software in EXIF, capture dates far apart, model-reported inconsistencies, unusually high totals.
7. **Recommendation**: Fast-track approval, Standard review, or Manual Adjuster Review Required.

The exact weights, prices and thresholds are in [the design spec](docs/superpowers/specs/2026-10-09-insurance-damage-estimator-design.md) and in `server/src/pipeline/`.

## Part prices

Set `FIRECRAWL_API_KEY` in `.env` (key from https://www.firecrawl.dev) to price replaced parts from real listings.

- For each part being replaced, the app reads the search results for the part name in Azerbaijani plus the vehicle make on both sites, for example `https://www.avtopro.az/products?search=bamper%20Mazda`.
- A listing counts only if its title names the part and the make, is not an accessory (bracket, trim, seal, cover and similar), is for the right side (front or rear bumper), and costs at least 20 AZN. If any listing names the model, only those are considered.
- The cheapest match is charged and linked in the cost table; up to four other matches are listed under it.
- Search pages are cached for 24 hours, so each part and make costs at most two Firecrawl credits per day.
- When nothing matches, or no key is set, the part price falls back to a fixed table and the line is marked "Estimated price, no listing found".

Matching is by title text, so a listing can still be the wrong generation or trim: open the link before relying on it. Labour (160 AZN per hour) and paint are placeholder rates, not from these sites. Check the sites' terms before using automated access beyond a demo.

## Project layout

```
shared/   vocabulary, report types, and the quality metric used by browser and server
server/   Express API, SQLite claim store, pipeline, analyzers
client/   React app: submission wizard, assessment report, adjuster portal
```

Data is stored in `server/data/claims.db` and `server/uploads/`. Delete both to reset.

## Known limits

- Damage regions are bounding boxes, not polygons.
- Labour hours, labour rate, paint and the fallback part prices are placeholder figures. Only replaced-part prices come from live listings.
- There is no login; anyone who can open the app can approve or reject claims.
- Submitting the same photos twice raises the duplicate-photo fraud signal on the second claim. That is intended, but worth knowing when you demo with one set of photos.
- "Print / PDF" uses the browser's print dialog; choose "Save as PDF" there.
