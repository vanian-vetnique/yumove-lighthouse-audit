import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const CONCURRENCY = 3; // drop to 1 if runs prove unstable
export const MAX_RETRIES = 3;
export const CATEGORIES = ["performance", "accessibility", "best-practices", "seo"] as const;
export type Strategy = "mobile" | "desktop";
export type Entry = { label: string; type: string; url: string };
export type Cell = string | number | null;
export type Table = { title: string; headers: string[]; rows: Cell[][]; scoreColumns?: number[]; filter?: boolean };
export type Sheet = { name: string; details: [string, string][]; tables: Table[] };
export type PsiRequest = (p: { url: string; strategy: Strategy; categories: readonly string[] }) => Promise<any>;
export type RunOptions = {
  fixtureText: string;
  fixtureName: string;
  psi: PsiRequest;
  writeSheet: (sheet: Sheet) => Promise<void>;
  rawDir: string;
  renderReport: (lhr: any) => string; // Lighthouse HTML report generator
  now?: Date;
  sleep?: (ms: number) => Promise<void>;
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

async function withRetry<T>(fn: () => Promise<T>, sleep: (ms: number) => Promise<void>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= MAX_RETRIES || !retryable(e)) throw e;
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

export function toFindings(e: Entry, strategy: Strategy, r: any): Cell[][] {
  const { categories, audits } = r.lighthouseResult;
  const rows: Cell[][] = [];
  for (const c of CATEGORIES) {
    for (const ref of categories[c]?.auditRefs ?? []) {
      const a = audits[ref.id];
      // Scored = everything except these modes (newer Lighthouse also uses "metricSavings").
      if (!a || ["informative", "manual", "notApplicable", "error"].includes(a.scoreDisplayMode)) continue;
      if (typeof a.score !== "number" || a.score >= 0.9) continue;
      rows.push([e.label, strategy, categories[c].title ?? c, a.title, a.score, a.displayValue ?? null]);
    }
  }
  return rows;
}

export async function runAudit(o: RunOptions): Promise<{ failed: number; sheetName: string }> {
  const entries = parseFixture(o.fixtureText); // throws before any request
  const now = o.now ?? new Date();
  const sleep = o.sleep ?? defaultSleep;
  const runDir = join(o.rawDir, stamp(now).replace(/ /g, "_"));
  await mkdir(runDir, { recursive: true });

  const jobs = (["mobile", "desktop"] as const).flatMap((strategy) => entries.map((entry, i) => ({ strategy, entry, i })));
  const results = await pool(
    jobs.map(({ strategy, entry, i }) => async () => {
      try {
        const resp = await withRetry(() => o.psi({ url: entry.url, strategy, categories: CATEGORIES }), sleep);
        await writeFile(join(runDir, `${pad(i + 1)}-${slug(entry.label)}-${strategy}.html`), o.renderReport(resp.lighthouseResult));
        const lh = resp?.lighthouseResult;
        if (!lh?.categories || lh.runtimeError) throw new Error(`Lighthouse failed: ${lh?.runtimeError?.message ?? "no result in response"}`);
        return { entry, strategy, resp, row: toRow(entry, resp), findings: toFindings(entry, strategy, resp), error: null };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const row: Cell[] = [entry.label, entry.type, entry.url, ...Array(10).fill(null), msg];
        return { entry, strategy, resp: null, row, findings: [] as Cell[][], error: msg };
      }
    }),
    CONCURRENCY,
  );

  const of = (s: Strategy) => results.filter((r) => r.strategy === s);
  const scoreColumns = [3, 4, 5, 6];
  const sheetName = stamp(now);
  const version = results.find((r) => r.resp)?.resp.lighthouseResult.lighthouseVersion ?? "unknown";
  await o.writeSheet({
    name: sheetName,
    details: [["Run time", now.toISOString()], ["Lighthouse version", version], ["Fixture file", o.fixtureName]],
    tables: [
      { title: "Mobile", headers: HEADERS, rows: of("mobile").map((r) => r.row), scoreColumns },
      { title: "Desktop", headers: HEADERS, rows: of("desktop").map((r) => r.row), scoreColumns },
      {
        title: "Findings",
        headers: ["Label", "Strategy", "Category", "Audit", "Score", "Display value"],
        rows: results.flatMap((r) => r.findings),
        filter: true,
      },
    ],
  });
  return { failed: results.filter((r) => r.error).length, sheetName };
}
