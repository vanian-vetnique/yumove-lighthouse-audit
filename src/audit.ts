import { access, constants, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findingsOf, findingsSheet, type Finding } from "./findings.ts";

export const CONCURRENCY = 3; // drop to 1 if runs prove unstable
export const MAX_RETRIES = 3;
export const CATEGORIES = ["performance", "accessibility", "best-practices", "seo"] as const;
export type Strategy = "mobile" | "desktop";
export type Entry = { label: string; type: string; url: string };
export type Cell = string | number | null | { text: string; hyperlink: string };
export type Column = { width?: number; align?: "left" | "center"; numFmt?: string };
export type Table = { title: string; headers: string[]; rows: Cell[][]; scoreColumns?: number[]; filter?: boolean; columns?: Column[] };
export type Sheet = { name: string; details: [string, string][]; tables: Table[] };
export type PsiRequest = (p: { url: string; strategy: Strategy; categories: readonly string[] }) => Promise<any>;
type Job = { index: number; total: number; strategy: Strategy; label: string; url: string };
export type Progress =
  | (Job & { type: "start" })
  | (Job & { type: "retry"; attempt: number })
  | (Job & { type: "done"; ms: number })
  | (Job & { type: "failed"; message: string; ms: number });
export type RunOptions = {
  fixtureText: string;
  fixtureName: string;
  psi: PsiRequest;
  writeSheets: (sheets: Sheet[]) => Promise<void>; // one call so the workbook is saved once
  rawDir: string;
  renderReport: (lhr: any) => string; // Lighthouse HTML report generator
  now?: Date;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (e: Progress) => void;
  onRunDir?: (dir: string) => void; // reports the run folder once it is ready
};

export function parseFixture(text: string): Entry[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Fixture is not valid JSON");
  }
  if (!Array.isArray(data) || data.length === 0) throw new Error("Fixture must be a non-empty JSON array");
  const labels = new Set<string>();
  data.forEach((e, i) => {
    for (const k of ["label", "type", "url"]) {
      if (typeof e?.[k] !== "string" || !e[k]) throw new Error(`Fixture entry ${i + 1}: missing "${k}"`);
    }
    let ok = false;
    try { ok = new URL(e.url).protocol === "https:"; } catch {}
    if (!ok) throw new Error(`Fixture entry ${i + 1}: url must be an https URL`);
    if (labels.has(e.label)) throw new Error(`Fixture entry ${i + 1}: duplicate label "${e.label}"`);
    labels.add(e.label);
  });
  return data as Entry[];
}

const pad = (n: number) => String(n).padStart(2, "0");
// Local time, no ":" (forbidden in sheet names); 19 chars, under Excel's 31 limit.
export const stamp = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;

const slug = (s: string) => s.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
const status = (e: any): number | undefined => e?.status;
// No status = network error or timeout, also transient.
const retryable = (e: unknown) => status(e) === undefined || status(e) === 429 || status(e)! >= 500;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, sleep: (ms: number) => Promise<void>, onRetry: (attempt: number) => void): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= MAX_RETRIES || !retryable(e)) throw e;
      onRetry(attempt + 2);
      await sleep(1000 * 2 ** attempt);
    }
  }
}

async function pool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (next < tasks.length) {
        const i = next++;
        out[i] = await tasks[i]();
      }
    }),
  );
  return out;
}

const round = (n: number | undefined, dp = 0) => (typeof n === "number" ? Number(n.toFixed(dp)) : null);

export const HEADERS = [
  "Label", "Type", "URL", "Performance", "Accessibility", "Best practices", "SEO",
  "Lab LCP (ms)", "Lab CLS", "Lab TBT (ms)", "Field LCP (ms)", "Field CLS", "Field INP (ms)", "Error",
];

const num = { width: 14, align: "center" as const };
const RESULT_COLUMNS: Column[] = [
  { width: 24 }, { width: 14 }, { width: 45 }, num, num, num, num,
  { ...num, numFmt: "#,##0" }, { ...num, numFmt: "0.000" }, { ...num, numFmt: "#,##0" },
  { ...num, numFmt: "#,##0" }, { ...num, numFmt: "0.000" }, { ...num, numFmt: "#,##0" }, { width: 45 },
];

export function toRow(e: Entry, r: any): Cell[] {
  const lh = r.lighthouseResult;
  const cats = lh.categories;
  const aud = lh.audits;
  const score = (c: string) => (typeof cats[c]?.score === "number" ? Math.round(cats[c].score * 100) : null);
  // origin_fallback means the metrics are origin-level, which we must not show.
  const field = r.loadingExperience?.origin_fallback ? {} : (r.loadingExperience?.metrics ?? {});
  const f = (k: string) => field[k]?.percentile as number | undefined;
  // Field CLS percentile is CLS x 100 in PSI v5; lab CLS is unitless. Normalised to lab scale.
  const fcls = f("CUMULATIVE_LAYOUT_SHIFT_SCORE");
  return [
    e.label, e.type, e.url,
    ...CATEGORIES.map(score),
    round(aud["largest-contentful-paint"]?.numericValue),
    round(aud["cumulative-layout-shift"]?.numericValue, 3),
    round(aud["total-blocking-time"]?.numericValue),
    round(f("LARGEST_CONTENTFUL_PAINT_MS")),
    typeof fcls === "number" ? fcls / 100 : null,
    round(f("INTERACTION_TO_NEXT_PAINT")),
    null,
  ];
}

export async function runAudit(o: RunOptions): Promise<{ failed: number; sheetName: string }> {
  const entries = parseFixture(o.fixtureText); // throws before any request
  const now = o.now ?? new Date();
  const sleep = o.sleep ?? defaultSleep;
  const runDir = join(o.rawDir, stamp(now).replace(/ /g, "_"));
  try {
    await mkdir(runDir, { recursive: true });
    await access(runDir, constants.W_OK);
  } catch (e) {
    throw new Error(`Cannot write raw results to ${runDir}: ${(e as Error).message}`);
  }
  o.onRunDir?.(runDir);
  const emit = o.onProgress ?? (() => {});

  const jobs = (["mobile", "desktop"] as const).flatMap((strategy) => entries.map((entry, i) => ({ strategy, entry, i })));
  const results = await pool(
    jobs.map(({ strategy, entry, i }, n) => async () => {
      const job = { index: n + 1, total: jobs.length, strategy, label: entry.label, url: entry.url };
      const t0 = performance.now();
      emit({ type: "start", ...job });
      try {
        const resp = await withRetry(() => o.psi({ url: entry.url, strategy, categories: CATEGORIES }), sleep, (attempt) => emit({ type: "retry", ...job, attempt }));
        await writeFile(join(runDir, `${pad(i + 1)}-${slug(entry.label)}-${strategy}.html`), o.renderReport(resp.lighthouseResult));
        const lh = resp?.lighthouseResult;
        if (!lh?.categories || lh.runtimeError) throw new Error(`Lighthouse failed: ${lh?.runtimeError?.message ?? "no result in response"}`);
        emit({ type: "done", ...job, ms: performance.now() - t0 });
        return { i, entry, strategy, resp, row: toRow(entry, resp), findings: findingsOf(entry.label, entry.url, strategy, lh), error: null };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        emit({ type: "failed", ...job, message: msg, ms: performance.now() - t0 });
        const row: Cell[] = [entry.label, entry.type, entry.url, ...Array(10).fill(null), msg];
        return { i, entry, strategy, resp: null, row, findings: [] as Finding[], error: msg };
      }
    }),
    CONCURRENCY,
  );

  const of = (s: Strategy) => results.filter((r) => r.strategy === s);
  const scoreColumns = [3, 4, 5, 6];
  const sheetName = stamp(now);
  const version = results.find((r) => r.resp)?.resp.lighthouseResult.lighthouseVersion ?? "unknown";
  const findings = [...results]
    .sort((a, b) => a.i - b.i || (a.strategy === b.strategy ? 0 : a.strategy === "mobile" ? -1 : 1))
    .flatMap((r) => r.findings);
  await o.writeSheets([
    {
      name: sheetName,
      details: [["Run time", now.toISOString()], ["Lighthouse version", version], ["Fixture file", o.fixtureName]],
      tables: [
        { title: "Mobile", headers: HEADERS, rows: of("mobile").map((r) => r.row), scoreColumns, columns: RESULT_COLUMNS },
        { title: "Desktop", headers: HEADERS, rows: of("desktop").map((r) => r.row), scoreColumns, columns: RESULT_COLUMNS },
      ],
    },
    findingsSheet(`${sheetName} findings`, findings, results.filter((r) => !r.error).length),
  ]);
  return { failed: results.filter((r) => r.error).length, sheetName };
}
