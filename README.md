# AuraScan (Next.js) — Business Card Scanner, deployable on Vercel

This is a full rewrite of the Python/FastAPI AuraScan backend into
Next.js (App Router, TypeScript), specifically so the whole app —
frontend and backend — deploys natively on Vercel with zero extra
configuration. Storage is still the same Google Apps Script webhook as
before (zero login for scanning users, sheet owned by whoever deployed
the script); only the application code changed language.

## What changed from the Python version

- **Card detection no longer uses OpenCV.** Vercel serverless functions
  don't support Python + OpenCV cleanly (that's what caused the original
  404 deploy failure). Instead, **Gemini itself finds every card in the
  bulk photo** and returns a bounding box for each one (a documented
  Gemini vision capability), and each box is cropped out of the original
  full-resolution image using `jimp` (a pure-JavaScript image library
  with **zero native dependencies** - chosen specifically over `sharp`,
  whose native binaries are a common, well-documented cause of "works
  locally, fails on Vercel" deploys).
- **Single-card extraction is unchanged in substance** - same prompt,
  same rules (including the detailed multi-number/parentheses Phone
  rule), same Gemini model, just written in TypeScript instead of Python.
- **Storage is the same Apps Script webhook** - `apps-script/Code.gs` is
  identical to the Python version's; it doesn't care what language calls
  it. `lib/storage.ts` is a line-for-line concept port of
  `storage_client.py`.
- **The frontend is now real React** (this was also part of the ask) -
  same visual design, same dark "AuraScan" theme, same camera
  capture/drag-drop/stats behavior, rebuilt as components instead of
  vanilla DOM manipulation.

## Architecture

```
Browser (React)
   │
   ├─ POST /api/scan/single ──► Gemini (extract 7 fields) ──► Apps Script webhook
   │
   └─ POST /api/scan/bulk   ──► Gemini (find every card's bounding box)
                                   │
                                   ▼
                              jimp crops each box out of the original image
                                   │
                                   ▼
                    Gemini (extract 7 fields) per crop, several at once
                                   │
                                   ▼
                         Apps Script webhook, once per card
```

## Important limitation: bulk scan and serverless time limits

This is a real architectural trade-off worth understanding, not just a
footnote. A long-running Python server has no per-request time limit;
**Vercel serverless functions do**. Each card in a bulk scan costs two
Gemini calls (its crop's extraction, plus its share of the detection
call) and one webhook POST. To keep total time reasonable:

- Cards are processed **concurrently** (5 at a time by default, see
  `CARD_CONCURRENCY` in `app/api/scan/bulk/route.ts`), not one at a time.
- `maxDuration` is set to 60 seconds - the safe default that works on
  every Vercel plan (Hobby included) with no extra configuration.

For a genuinely large batch (20-30+ cards) this **may still not be
enough time** on the Hobby plan. If you hit timeouts:
- Upgrade to **Vercel Pro**, which allows raising `maxDuration`
  significantly (see [Vercel's function
  duration docs](https://vercel.com/docs/functions/configuring-functions/duration)
  for current limits - these change over time, check before relying on a
  specific number), and raise it in `app/api/scan/bulk/route.ts`.
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

### 1. Deploy the Apps Script (identical to the Python version)

1. Go to [script.google.com](https://script.google.com) → **New project**.
2. Delete the default code, paste in the entire contents of
   `apps-script/Code.gs`.
3. Change `SHARED_SECRET` near the top to a long random string.
4. **Deploy → New deployment** → type **Web app** → Execute as **Me**,
   Who has access **Anyone** → **Deploy**. Authorize when prompted (the
   one-time, owner-only consent step).
5. Copy the **Web app URL**.

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
