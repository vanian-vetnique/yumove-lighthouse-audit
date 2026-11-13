import type { Cell, Column, Strategy } from "./audit.ts";

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
  key: number; // largest metric saving in ms, for ranking
};

export const FINDINGS_HEADERS = ["Page", "Strategy", "Category", "Insight", "Est. savings", "Metrics affected", "About", "Learn more"];
export const FINDINGS_COLUMNS: Column[] = [
  { width: 24 }, { width: 14, align: "center" }, { width: 18 }, { width: 34 }, { width: 22 }, { width: 24 }, { width: 60 }, { width: 14, align: "center" },
];

const EXCLUDED_MODES = ["informative", "manual", "notApplicable", "error"];
const CATEGORY_ORDER = ["performance", "accessibility", "best-practices", "seo"];
const LINK = /\[([^\]]*)\]\(([^)]*)\)/;

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
export function findingsOf(page: string, strategy: Strategy, lhr: any): Finding[] {
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
  f.learnMore ? { text: "Learn more", hyperlink: f.learnMore } : null,
];
