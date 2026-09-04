# AuraScan Google Apps Script

`Code.gs` is the deployable storage and shared abuse-control webhook for the
application. It contains the nine-column card schema (including `Industry` and
`Extraction Engine`),
migration logic for older sheets, plain-text protection for OCR/model output,
and rate limits shared across every Next.js/Vercel instance.

On the first newly saved card after deployment, existing sheets gain
`Extraction Engine` after `Address`. Historical rows remain aligned and blank
in that new column. Phone values are written as text, so explicit country
codes, leading zeros, parentheses, spaces, and dashes remain visible.

To deploy it:

1. Create or open the existing Google Apps Script project.
2. Replace its `Code.gs` with this folder's `Code.gs`.
3. In the Apps Script editor, set `SHARED_SECRET` to the same value as the
   backend's `APPS_SCRIPT_SECRET`. Keep the committed copy as a placeholder so
   the real secret is never pushed to Git.
4. If using a manifest-enabled project, copy `appsscript.json` as well.
5. Deploy a new Web App version that executes as the owner and is reachable by
   the Next.js backend.

## Abuse controls

The configured organizational limits are:

- single/double scans: 10 requests per browser per minute and 30 per IP per
  minute;
- all scan traffic: hard stop at 120 requests per minute;
- bulk scans: 5 starts per browser per 10 minutes and no more than 3 bulk jobs
  running globally at once;
- bulk payload: up to 50 detected cards per request.

The bulk route requests a 300-second Vercel duration. Its shared concurrency
lease lasts 330 seconds so another bulk job cannot enter early while a valid
five-minute request is still running.

Excess traffic receives HTTP `429` with retry guidance. The rate counters live
in Apps Script, so they are shared by all serverless instances. If the control
call is briefly unavailable, the Next.js routes fail open so an ordinary scan
is not lost because the limiting service is unavailable.

There is currently no monitoring spreadsheet, email alert, scheduled summary,
or administrative kill switch. Apps Script stores only the final extracted
card fields in the owner-controlled `Business Card Scanner - DG` spreadsheet.
