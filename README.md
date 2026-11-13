# YuMove Lighthouse audit

Runs a list of public URLs through the PageSpeed Insights (PSI) API (mobile, then desktop, all four Lighthouse categories) and adds one new tab per run to an Excel workbook. Lighthouse HTML reports (one per URL and strategy) are saved to `<RAW_RESULTS_PATH or raw-results>/<run>/`; open them in a browser.

## Setup

1. Needs Node 22.18+ (spec asks for 24+; 22.23 was used for development). `npm install`.
2. In Google Cloud, create a project, enable the **PageSpeed Insights API**, and create an API key restricted to that API.
3. `cp .env.example .env` and set:
   - `PSI_API_KEY` — the key (required).
   - `AUDIT_WORKBOOK_PATH` — optional; the full path of the **`.xlsx` file** (not a folder); default `reports/lighthouse-history.xlsx`. Point it into a OneDrive/SharePoint-synced folder, e.g. `~/OneDrive - Company/Reports/lighthouse-history.xlsx` (use the absolute path; `~` is not expanded).
   - `RAW_RESULTS_PATH` — optional; a **folder** (not a file) for the raw Lighthouse HTML reports, e.g. a OneDrive-synced folder (absolute path). Blank uses `raw-results/` in the repo. Each run adds a timestamped subfolder; old runs are never deleted. The run fails before any PSI call if the folder can't be written.
4. Edit `fixtures/urls.json`: an array of `{ "label", "type", "url" }`. URLs must be https and labels unique. Mark preview-theme URLs in the label, e.g. `"Home (preview)"`.

## Run

```
npm run audit                                  # default fixture
npm run audit -- --fixture fixtures/small.json # another fixture
npm test && npm run typecheck
```

Exit code is non-zero if any URL failed (error rows appear in the tables) or the workbook could not be saved. If the save fails because the file is open in Excel, close it and re-run; the HTML reports are already on disk.

While running, the CLI prints a line when each call starts (`[n/total] strategy label url`) and when it finishes or fails.

## Reading the report

Each tab has a run-details block, a **Mobile** table, a **Desktop** table (scores 0–100 colour-coded 90+ green, 50–89 orange, <50 red via conditional formatting; lab and field LCP/CLS/INP/TBT; blank field cells mean Chrome has no page-level data) and a **Findings** table (scored audits below 0.9; filter by Category/Strategy using the header dropdowns).

## Known limits

- Single run per URL: lab scores vary by a few points between runs.
- Low-traffic pages have no field data; there is no origin-level fallback.
- The workbook is locked while open in Excel on Windows.
- The workbook is script-owned: exceljs rewrites the whole file, so hand-added charts or objects are lost.
- Failed calls are retried (3 times, exponential backoff) on 429, 5xx and network errors (not other 4xx).
- Field CLS: PSI reports the percentile as CLS × 100; the script divides by 100. **Not yet verified against a live response** (see Smoke run).

## Planned, out of scope

Pass/fail thresholds, a generated summary/trend tab, GitHub Actions (needs a way to persist the workbook: Graph upload to SharePoint or an Actions artifact).

## Smoke run

Not yet done: the full-fixture real run (observed run time and call count) and the live CLS-scale check need a `PSI_API_KEY`. Record the results here after running `npm run audit`. Expected: 2 calls per URL.
