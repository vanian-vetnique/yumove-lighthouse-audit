# YuMove Lighthouse audit

Runs a list of public URLs through the PageSpeed Insights (PSI) API (mobile, then desktop, all four Lighthouse categories) and adds two new tabs per run to an Excel workbook (scores, and findings). Lighthouse HTML reports (one per URL and strategy) are saved to `<RAW_RESULTS_PATH or raw-results>/<run>/`; open them in a browser.

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

Each run adds two tabs.

- `<run>`: a run-details block, a **Mobile** table and a **Desktop** table (scores 0–100 colour-coded 90+ green, 50–89 orange, <50 red via conditional formatting; lab and field LCP/CLS/INP/TBT; blank field cells mean Chrome has no page-level data).
- `<run> findings`: a **Findings summary** (one row per issue across the run: how many runs it affects, the largest saving, ranked so site-wide problems come first) above a **Findings** table (one row per failing Lighthouse insight or audit, per page and strategy). Each row shows the estimated saving, which metrics it affects, Lighthouse's explanation and docs link, and **Offenders**: the files or elements causing it, grouped by 1st/3rd-party host and capped at 10 lines. Performance rows are Lighthouse insights only; Accessibility, Best practices and SEO list their failing audits. **Raw result** links to that run's saved Lighthouse report; the link is relative to the workbook, so keep the workbook and the raw-results folder together (share the whole folder). Filter the detail table with the header dropdowns.

## Known limits

- Single run per URL: lab scores vary by a few points between runs.
- Low-traffic pages have no field data; there is no origin-level fallback.
- The workbook is locked while open in Excel on Windows.
- `npm audit` reports 2 moderate issues via `uuid` inside exceljs (4.4.0, its latest). The tool never calls uuid with a caller-supplied buffer, so it is not exploitable here; re-check when exceljs releases.
- The workbook is script-owned: exceljs rewrites the whole file, so hand-added charts or objects are lost.
- Failed calls are retried (3 times, exponential backoff) on 429, 5xx and network errors (not other 4xx).
- Field CLS: PSI reports the percentile as CLS × 100; the script divides by 100. Checked against a live run (see Smoke run).

## Planned, out of scope

Pass/fail thresholds, a generated summary/trend tab, GitHub Actions (needs a way to persist the workbook: Graph upload to SharePoint or an Actions artifact).

## Smoke run

2026-11-13, default fixture (7 URLs): 14 calls, no retries or failures, 41–90 s per call (about 5 minutes in total at 3 at a time, estimated from the per-call times). Field CLS values came out as 0.010 and 0.000, which fits PSI's CLS × 100 percentile (an integer such as 1) divided by 100. They are coarse, so a page with a larger CLS is the stronger check next time. "Open report" links open the saved HTML.
