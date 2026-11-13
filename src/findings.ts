import type { Cell, Column, Sheet, Strategy } from "./audit.ts";

export type Finding = {
  page: string;
  strategy: Strategy;
  category: string;
  id: string;
  title: string;
  savings: string;
  metrics: string;
  about: string;
  learnMore: string | null;
  offenders: string | null;
  key: number; // largest metric saving in ms, for ranking
};

export const FINDINGS_HEADERS = ["Page", "Strategy", "Category", "Insight", "Est. savings", "Metrics affected", "About", "Learn more", "Offenders"];
export const FINDINGS_COLUMNS: Column[] = [
  { width: 24 }, { width: 14, align: "center" }, { width: 18 }, { width: 34 }, { width: 22 }, { width: 24, align: "center" }, { width: 60 }, { width: 14, align: "center" }, { width: 70 },
];

export const SUMMARY_HEADERS = ["Category", "Runs affected", "Largest saving", "Insight", "Est. savings", "Metrics affected", "About", "Learn more"];
// Leading columns share widths with the detail table below it, since both stack on the same sheet columns.
export const SUMMARY_COLUMNS: Column[] = [
  { width: 24 }, { width: 14, align: "center" }, { width: 18, align: "center" }, { width: 34 }, { width: 22 }, { width: 24, align: "center" }, { width: 60 }, { width: 14, align: "center" },
];

const EXCLUDED_MODES = ["informative", "manual", "notApplicable", "error"];
const CATEGORY_ORDER = ["performance", "accessibility", "best-practices", "seo"];
const LINK = /\[([^\]]*)\]\(([^)]*)\)/;

const link = (url: string | null): Cell => (url ? { text: "Learn more", hyperlink: url } : null);
const plain = (md: string) => md.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/`/g, "");
const ms = (n: number) => `${Math.round(n).toLocaleString("en-US")} ms`;

// Metrics with a non-zero saving, e.g. "FCP -750 ms, LCP -300 ms". CLS is unitless.
function metricsText(savings: Record<string, number> | undefined): string {
  const parts = Object.entries(savings ?? {})
    .filter(([, v]) => typeof v === "number" && v > 0)
    .map(([k, v]) => `${k} -${k === "CLS" ? Number(v.toFixed(3)) : ms(v)}`);
  return parts.length ? parts.join(", ") : "-";
}

// shortcut: CLS savings (unitless) do not influence ranking, revisit if CLS-only insights need ordering.
const rankKey = (savings: Record<string, number> | undefined) =>
  Math.max(0, ...Object.entries(savings ?? {}).filter(([k]) => k !== "CLS").map(([, v]) => v));

/** Failing insights (Performance) and failing audits (other categories) for one run, in report order. */
export function findingsOf(page: string, pageUrl: string, strategy: Strategy, lhr: any): Finding[] {
  const out: Finding[] = [];
  for (const cat of CATEGORY_ORDER) {
    const category = lhr.categories?.[cat];
    const list: Finding[] = [];
    for (const ref of category?.auditRefs ?? []) {
      if (cat === "performance" && ref.group !== "insights") continue; // legacy audits repeat the insights
      const a = lhr.audits?.[ref.id];
      if (!a || EXCLUDED_MODES.includes(a.scoreDisplayMode)) continue;
      if (typeof a.score !== "number" || a.score >= 0.9) continue;
      list.push({
        page, strategy,
        category: category.title ?? cat,
        id: ref.id,
        title: a.title,
        savings: cat === "performance" ? (a.displayValue ?? "-").replace(/\u00a0/g, " ") : "-", // Lighthouse uses NBSP
        metrics: metricsText(a.metricSavings),
        about: plain(a.description ?? ""),
        learnMore: (a.description ?? "").match(LINK)?.[2] ?? null,
        offenders: offendersText(a.details, new URL(pageUrl).hostname),
        key: rankKey(a.metricSavings),
      });
    }
    if (cat === "performance") list.sort((a, b) => b.key - a.key); // stable: ties keep Lighthouse order
    out.push(...list);
  }
  return out;
}

export const findingRow = (f: Finding): Cell[] => [
  f.page, f.strategy, f.category, f.title, f.savings, f.metrics, f.about,
  link(f.learnMore),
  f.offenders,
];

// ---- Offenders: the things causing an insight, rendered from the insight's own details ----
const CAP = 10;
type Section = { group?: string; third?: boolean; lines: string[] };

const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

function shortUrl(u: string, withHost: boolean): string {
  let url: URL;
  try { url = new URL(u); } catch { return trunc(u, 80); }
  const segs = url.pathname.split("/").filter(Boolean);
  const path = segs.length > 2 ? `…/${segs.slice(-2).join("/")}` : `/${segs.join("/")}`;
  const query = trunc(url.search, 10);
  return `${withHost ? url.host : ""}${path}${query}`;
}

const duration = (n: number) =>
  n < 1000 ? ms(n) : n < 60_000 ? `${Math.round(n / 1000)} s` : n < 3_600_000 ? `${Math.round(n / 60_000)} min` : n < 86_400_000 ? `${Math.round(n / 3_600_000)} h` : `${Math.round(n / 86_400_000)} d`;

function formatValue(v: any, valueType: string | undefined, withHost: boolean, displayUnit?: string): string | null {
  if (v === null || v === undefined || v === "") return null;
  const type = v?.type ?? valueType; // detail objects carry their own type
  const raw = typeof v === "object" && "value" in v ? v.value : v;
  switch (type) {
    case "url": return typeof raw === "string" ? shortUrl(raw, withHost) : null;
    case "bytes": return typeof raw === "number" ? `${(raw / 1024).toFixed(1)} KiB` : null;
    case "ms": case "timespanMs": return typeof raw === "number" ? (displayUnit === "duration" ? duration(raw) : ms(raw)) : null;
    case "numeric": case "integer": return typeof raw === "number" ? String(Number(raw.toFixed(1))) : null;
    case "link": return v?.text ?? null;
    case "source-location":
      return v?.url ? `${shortUrl(v.url, withHost)}${typeof v.line === "number" ? `:${v.line + 1}:${v.column ?? 0}` : ""}` : null;
    case "node": {
      const full: string = v?.selector ?? v?.snippet ?? "";
      const sel = full.length > 100 ? `…${full.slice(-100)}` : full; // the end of a selector is the element itself
      const why = trunc(String(v?.explanation ?? "").replace(/^Fix (any|all) of the following:/, "").replace(/\s+/g, " ").trim(), 220);
      return sel ? (why ? `${sel} — ${why}` : sel) : null;
    }
    default: return typeof raw === "string" || typeof raw === "number" ? String(raw) : null;
  }
}

const party = (host: string, pageHost: string) => {
  const bare = (h: string) => h.replace(/^www\./, "");
  const [h, p] = [bare(host), bare(pageHost)];
  return h === p || h.endsWith(`.${p}`) || p.endsWith(`.${h}`) ? "1st party" : "3rd party";
};

function tableSections(d: any, pageHost: string): Section[] {
  const headings: any[] = d.headings ?? [];
  const grouped = headings[0]?.valueType === "url";
  const byHost = new Map<string, Section>();
  const flat: Section = { lines: [] };
  for (const item of d.items ?? []) {
    const parts = headings.map((h, i) => {
      const t = h.key == null ? null : formatValue(item[h.key], h.valueType, !grouped, h.displayUnit);
      return t && i > 0 && h.label ? `${h.label}: ${t}` : t;
    });
    const lines = [parts.filter(Boolean).join(" · ")];
    for (const sub of item.subItems?.items ?? []) {
      const vals = headings.flatMap((h) => {
        if (!h.subItemsHeading) return [];
        const sh = h.subItemsHeading;
        return [formatValue(sub[sh.key === undefined ? h.key : sh.key], sh.valueType ?? h.valueType, !grouped)];
      });
      lines.push(`  ${vals.filter(Boolean).join(" · ")}`);
    }
    if (!lines[0]) continue;
    let target = flat;
    if (grouped && typeof item[headings[0].key] === "string") {
      let host = "";
      try { host = new URL(item[headings[0].key]).hostname; } catch {}
      if (host) {
        if (!byHost.has(host)) byHost.set(host, { group: `${host} (${party(host, pageHost)})`, third: party(host, pageHost) === "3rd party", lines: [] });
        target = byHost.get(host)!;
      }
    }
    target.lines.push(...lines.map((l) => (target === flat ? l : `  ${l}`)));
  }
  const groups = [...byHost.values()].sort((a, b) => Number(a.third) - Number(b.third));
  return [...groups, flat].filter((s) => s.lines.length);
}

function detailSections(d: any, pageHost: string): Section[] {
  switch (d?.type) {
    case "table": case "opportunity": return tableSections(d, pageHost);
    case "list": return (d.items ?? []).flatMap((i: any) => detailSections(i, pageHost));
    case "checklist": {
      const failed = Object.values<any>(d.items ?? {}).filter((c) => c?.value === false).map((c) => `✗ ${c.label}`);
      return failed.length ? [{ lines: failed }] : [];
    }
    case "node": { const t = formatValue(d, "node", true); return t ? [{ lines: [t] }] : []; }
    default: return []; // debugdata, network-tree and other shapes carry nothing readable
  }
}

function offendersText(details: any, pageHost: string): string | null {
  const out: string[] = [];
  let shown = 0, more = 0;
  for (const sec of detailSections(details, pageHost)) {
    let headed = false;
    for (const line of sec.lines) {
      if (sec.group && !headed && shown < CAP) { out.push(sec.group); headed = true; shown++; }
      if (shown >= CAP) { more++; continue; }
      out.push(line);
      shown++;
    }
  }
  if (more) out.push(`+${more} more`);
  return out.length ? out.join("\n") : null;
}

/** One row per insight across the run: how widespread it is, and the biggest saving seen. */
export function summaryRows(findings: Finding[], totalRuns: number): Cell[][] {
  const groups = new Map<string, Finding[]>(); // insertion order = first appearance
  for (const f of findings) {
    const k = `${f.category}/${f.id}`;
    groups.set(k, [...(groups.get(k) ?? []), f]);
  }
  return [...groups.values()]
    .map((fs, i) => ({ fs, i, top: fs.reduce((a, b) => (b.key > a.key ? b : a)) }))
    .sort((a, b) => b.fs.length - a.fs.length || b.top.key - a.top.key || a.i - b.i)
    .map(({ fs, top }) => [
      top.category, `${fs.length} of ${totalRuns} runs`, top.key ? ms(top.key) : "-", top.title, top.savings, top.metrics, top.about,
      link(top.learnMore),
    ]);
}

/** The second tab of a run: summary above the per-page detail. */
export const findingsSheet = (name: string, findings: Finding[], runs: number): Sheet => ({
  name,
  details: [],
  tables: [
    { title: "Findings summary", headers: SUMMARY_HEADERS, rows: summaryRows(findings, runs), columns: SUMMARY_COLUMNS },
    { title: "Findings", headers: FINDINGS_HEADERS, rows: findings.map(findingRow), filter: true, columns: FINDINGS_COLUMNS },
  ],
});
