# AuraScan (Next.js) — Business Card Scanner, deployable on Vercel

This is a full rewrite of the Python/FastAPI AuraScan backend into
Next.js (App Router, TypeScript), specifically so the whole app —
frontend and backend — deploys natively on Vercel with zero extra
configuration. Storage is still the same Google Apps Script webhook as
before (zero login for scanning users, sheet owned by whoever deployed
the script); only the application code changed language.

## What changed from the Python version

- **Card detection uses OpenCV when the optional local OCR sidecar is
  available, then falls back to Gemini.** Each detected box is cropped from
  the full-resolution image with `jimp`, which has no native dependency.
- **Card text extraction now has two confidence-gated OCR attempts before
  Gemini Vision.** Tesseract runs first in supported local environments. If
  it is below 70% confidence or cannot produce a complete card, the existing
  RapidOCR/ONNX sidecar gets the second attempt at the same 70% threshold.
  Gemini text parsing and then Gemini Vision remain the cloud fallbacks.
- **Industry uses company and card-description evidence first.** Unresolved
  sectors receive a bounded Google Search-grounded Gemini lookup. Ambiguous
  companies stay `Unclassified`; search failures do not prevent saving cards.
- **Department ownership is supported in every scan mode.** The dropdown is
  ready for the organization's department list; see configuration below.
- **Phone and other extracted values are stored as text safely.** Values that
  could be interpreted as spreadsheet formulas are escaped before storage.
  Printed country codes, leading zeros, parentheses, spaces, and dashes are
  preserved; equivalent duplicates are removed and multiple numbers use ` / `.
- **Every newly scanned row records its extraction engine.** The sheet shows
  `Tesseract OCR`, `RapidOCR`, `Gemini Text fallback (...)`, or `Gemini Vision
  fallback`. Two-sided scans record both engines when they differ.
- **Storage remains an Apps Script webhook.** `apps-script/Code.gs` now
  adds missing columns without moving existing ones and forces submitted
  values to safe text. `lib/storage.ts` applies the same safety rule before
  making the webhook request.
- **The frontend is now real React** (this was also part of the ask) -
  same visual design, same dark "AuraScan" theme, same camera
  capture/drag-drop/stats behavior, rebuilt as components instead of
  vanilla DOM manipulation.

## Architecture

```
Browser (React)
   │
   ├─ POST /api/scan/single or /double
   │        ├─► Shared Apps Script rate check
   │        └─► Tesseract (>=70%)
   │              └─► RapidOCR sidecar (>=70%)
   │                    └─► Gemini text
   │                          └─► Gemini Vision
   │                                └─► Industry enrichment (web only if unresolved)
   │                                      └─► Apps Script card storage
   │
   └─ POST /api/scan/bulk
            ├─► Shared Apps Script rate + bulk-permit check
            └─► OpenCV sidecar or Gemini card detection
                  └─► jimp crop per card
                        └─► same extraction pipeline above
```

The shared rate check fails open if Apps Script is temporarily unavailable;
card storage errors still fail visibly so the UI never claims an unsaved card
was saved.

## Recommended organizational operating mode

The deployed control layer is tuned for new-card scanning with occasional
bursts:

- single/double: 10 requests per browser per minute and 30 per IP per minute;
- global: hard burst stop at 120 requests/minute;
- bulk: 5 starts per browser per 10 minutes, 3 concurrent bulk jobs globally,
  and up to 50 detected cards per request.

Excess burst traffic receives HTTP `429` with a retry time. Anonymous browser
IDs and salted IP hashes are used only for abuse controls. There is currently
no monitoring sheet, email alert, scheduled summary, or kill switch.

## Bulk scan and Vercel execution time

This is a real architectural trade-off worth understanding, not just a
footnote. A long-running Python server has no per-request time limit;
**Vercel Functions do**. Bulk detection runs once, then every crop goes through
the OCR/Gemini fallback pipeline and one sheet write. To keep total time
reasonable:

- Cards are processed **concurrently** (5 at a time by default, see
  `CARD_CONCURRENCY` in `app/api/scan/bulk/route.ts`), not one at a time.
- The bulk route requests `maxDuration = 300` seconds. Enable Fluid Compute in
  Vercel so the project receives the current five-minute Hobby allowance (and
  longer paid-plan allowances).

For work that can exceed five minutes, do not keep extending one browser HTTP
request. Upload the source image to object storage, enqueue a durable bulk job,
process cards idempotently in a queue/worker, and let the browser poll job
status. This survives function restarts and permits safe retries. In the short
term:

- On Pro, raise `maxDuration` within the plan's current allowance after
  confirming Fluid Compute is enabled (see [Vercel Function
  limits](https://vercel.com/docs/functions/limitations)).
- Or lower `CARD_CONCURRENCY` if you're hitting Gemini rate limits rather
  than the time limit (the symptom looks similar but the fix is
  opposite - profile before changing this).
- Or split large photos into smaller batches (e.g. 10 cards at a time)
  on the user's side as a practical workaround.

## Known untested area: Gemini's bounding-box accuracy on busy photos

I could not test this against the real Gemini API from my environment
(no network access to Google's APIs in the sandbox this was built in).
The bounding-box detection approach is a documented Gemini capability
and the code path is verified to work correctly end-to-end (build,
runtime, and the crop math were all tested against a synthetic image),
but **how accurately Gemini finds and boxes 20-30 real, physical business
cards in one photo is genuinely unverified** - test this with a real
photo before relying on it for anything important. If accuracy is worse
than the previous OpenCV contour-detection approach, the fix is almost
certainly prompt tuning in `DETECTION_PROMPT` in `lib/detectCards.ts`,
not a change to the crop/extraction logic.

## Setup

### 1. Deploy the Apps Script

1. Go to [script.google.com](https://script.google.com) → **New project**.
2. Delete the default code, paste in the entire contents of
   `apps-script/Code.gs`.
3. Change `SHARED_SECRET` near the top to a long random string.
4. **Deploy → New deployment** → type **Web app** → Execute as **Me**,
   Who has access **Anyone** → **Deploy**. Authorize when prompted (the
   one-time, owner-only consent step).
5. Copy the **Web app URL**.

If upgrading, update the **same Apps Script project** and its deployment version
to retain the saved `SPREADSHEET_ID`. Keep your existing secret. On the next saved
card, missing headers are appended at the right edge; existing columns, custom
columns and historical rows are not moved or relabelled. New rows are mapped by
header name, and migration/row writes share a lock to prevent concurrent scans
from allocating the same row. Existing rows remain blank in newly added columns.
Incoming fields are plain text so phone numbers containing `+`, `-`, `/` or
parentheses cannot become formulas. Redeploy the app and Apps Script together:
an older script will not store the new metadata.

### Department ownership and industry research

- A basic starter list is configured in `DEPARTMENTS` in `lib/departments.ts`.
  Replace those names with the organization's official departments when they
  are available, then rebuild/redeploy the app. Users can choose a department or
  leave the card as `Not assigned`; the backend accepts only configured names.
- Single and double-sided cards use one selection. A bulk upload assigns the
  selected department to **every card in that upload**. This is self-reported
  ownership, not authentication or proof of who scanned the card.
- The existing `Industry` column is the company's business sector, not its web
  address. Product/service text and company evidence are used first; a person's
  job title and generic company suffixes are not sufficient business evidence.
- If the sector is still unresolved and a company name exists, the app uses
  [Google Search grounding](https://ai.google.dev/gemini-api/docs/google-search)
  through the existing Gemini key/model. Only company name and printed website
  are sent to this additional lookup, not contact names, phone numbers, full
  email addresses, or departments. There is no separate search API key.
- A web sector is accepted only when the response declares an unambiguous
  company match and includes a provider-grounded citation supporting the sector.
  A same-name company without enough identity evidence remains `Unclassified`.
  AI classification is still fallible; source links are supplied for review.
- New rows include `Department`, `Industry Source`, and `Industry Sources`.
  The existing `Extraction Engine` still describes the OCR/Gemini extraction,
  independently of industry research. Source links and Google search suggestions
  appear in scan results; suggestion HTML is isolated in a sandboxed frame and
  is not stored in the sheet.
- The optional lookup has a **10-second client timeout**. Single/double requests
  stop starting searches after 35 seconds, bulk requests after 275 seconds, to
  leave time for the existing sheet write. If search fails, is ambiguous, or has
  no time left, the card is saved with `Unclassified` and an explanatory source
  status. This is not a guarantee that the whole OCR request finishes in time.
- Google Search grounding can add latency and provider charges/quota usage.
  Verify availability for your Gemini project/model before rollout. No new
  daily quota, monitoring, email, authentication, or kill switch is introduced.

Validation: `npm test` runs offline tests, including scan-route ownership and
historical-sheet migration. `node scripts/check-industry-search.mjs` runs a real
public-company lookup with the configured Gemini key; it can incur API usage but
does not upload a card or write to Google Sheets.

### Troubleshooting an HTML response during save

The Apps Script health response identifies revision `metadata-columns-jkl-4`. This
version commits pending spreadsheet writes with `SpreadsheetApp.flush()` before
releasing the write lock or claiming success, and returns the failure stage when
an exception can be caught. The application removes inline HTML scripts/styles
from Google's error pages to display the readable error instead. Platform-level
authorization failures can still return HTML outside the script's error handler.
Formatting now targets one scanner column at a time: Google Sheets tables can
reject a number-format operation spanning several columns. Custom/blank columns
are not formatted, and formatting is flushed before card values are submitted.

After updating the Apps Script code, run `placeMetadataColumnsAtJToL` once from
the Apps Script editor. It moves the complete existing metadata columns, including
historical values, to `J:Department`, `K:Industry Source`, and
`L:Industry Sources`, then clears their old locations. It stops without moving
anything if J:L contain existing data, so those values cannot be overwritten.

Deploy the updated code to the existing Apps Script deployment, preserving its
secret and URL. Check **Execute as: Me** and the intended anonymous **Anyone**
access. Then run `node scripts/check-storage.mjs` to check the deployed owner's
spreadsheet/header access without adding rows or changing headers. It refuses
to POST to older revisions that do not support the read-only diagnostic action.
This confirms read access, not permission to edit protected cells or table formats.
If a save response fails, check the sheet before retrying: errors are not proof
that no row was written, and the application does not automatically retry writes.

### 2. Get a Gemini API key

Create one at [Google AI Studio](https://aistudio.google.com/apikey).

### 3. Local development

```bash
cp .env.local.example .env.local
```

Edit `.env.local` with your real `GEMINI_API_KEY`, `APPS_SCRIPT_URL`, and
`APPS_SCRIPT_SECRET`.

```bash
npm install
npm run dev
```

Open **http://localhost:3000**.

### 3a. Start the optional second OCR engine

RapidOCR is the second OCR stage after Tesseract. Install the sidecar
dependencies and start it in a separate terminal:

```bash
python -m pip install -r ocr-service/requirements.txt
start-ocr-service.bat
```

RapidOCR is opt-in. Set `OCR_SERVICE_URL=http://127.0.0.1:8000` for local use.
Leave it unset for a temporary Vercel deployment; the app skips the sidecar
without making a localhost request and continues directly to Gemini. A future
production sidecar must use a hosted HTTPS URL.

### 4. Deploy to Vercel

```bash
npm install -g vercel   # if you don't have it
vercel
```

Or connect the repo through the Vercel dashboard (Import Project). Either
way, **environment variables must be set in the Vercel dashboard**
(Project → Settings → Environment Variables) - `.env.local` is never
uploaded or used in production, it's local-dev only:

- `GEMINI_API_KEY`
- `GEMINI_MODEL` (optional, defaults to `gemini-2.5-flash`)
- `APPS_SCRIPT_URL`
- `APPS_SCRIPT_SECRET`
- `MAX_UPLOAD_MB` (optional, defaults to `15`)
- `OCR_SERVICE_URL` (optional; omit until a hosted RapidOCR service exists)

Redeploy after adding/changing env vars (Vercel doesn't hot-reload them
into already-running deployments).

## Security notes

- `GEMINI_API_KEY`, `APPS_SCRIPT_URL`, and `APPS_SCRIPT_SECRET` are
  server-only environment variables - Next.js never sends them to the
  browser (they're not prefixed `NEXT_PUBLIC_`, which is the only way
  Next.js exposes an env var client-side).
- All Gemini and Apps Script calls happen inside API routes
  (`app/api/scan/*`), which run server-side only.

## Project structure

```
aurascan-nextjs/
├── app/
│   ├── layout.tsx           # root layout, fonts, ambient background
│   ├── page.tsx              # mode switch + panel rendering
│   ├── globals.css           # ported design system (unchanged visually)
│   └── api/
│       └── scan/
│           ├── single/route.ts
│           └── bulk/route.ts
├── components/
│   ├── SingleScanPanel.tsx
│   ├── BulkScanPanel.tsx
│   ├── CameraCapture.tsx     # getUserMedia capture flow
│   ├── Dropzone.tsx           # drag-drop + click-to-browse
│   ├── StatsRow.tsx
│   ├── FieldList.tsx
│   ├── BulkResultsList.tsx
│   └── icons.tsx
├── lib/
│   ├── gemini.ts              # single-card extraction (port of ocr_extractor.py)
│   ├── industry.ts            # direct industry/domain classifier fallback
│   ├── sheetSafety.ts         # spreadsheet formula-injection protection
│   ├── detectCards.ts         # Gemini bounding boxes + jimp cropping (replaces OpenCV)
│   ├── storage.ts              # Apps Script webhook client (port of storage_client.py)
│   ├── concurrency.ts          # bounded-concurrency helper for bulk scan
│   └── types.ts
├── apps-script/
│   └── Code.gs                 # identical to the Python version - deploy as-is
├── package.json
├── next.config.js
├── tsconfig.json
└── .env.local.example
```
