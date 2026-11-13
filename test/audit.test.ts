import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { runAudit, type PsiRequest, type Sheet, type Progress } from "../src/audit.ts";

const fixture = JSON.stringify([
  { label: "Home", type: "home", url: "https://example.com/" },
  { label: "PDP – A", type: "pdp", url: "https://example.com/p" },
]);

// Canned response. Scores 0-1, field CLS percentile is x100 (12 => 0.12).
const resp = (over: any = {}) => ({
  lighthouseResult: {
    lighthouseVersion: "12.1.0",
    categories: {
      performance: { title: "Performance", score: 0.876, auditRefs: [{ id: "lcp" }, { id: "info" }, { id: "edge" }, { id: "ok" }] },
      accessibility: { title: "Accessibility", score: 1, auditRefs: [{ id: "alt" }, { id: "manual" }, { id: "na" }] },
      "best-practices": { title: "Best Practices", score: 0.5, auditRefs: [{ id: "https" }] },
      seo: { title: "SEO", score: 0.95, auditRefs: [{ id: "meta" }] },
    },
    audits: {
      lcp: { title: "LCP", score: 0.4, scoreDisplayMode: "numeric", displayValue: "4.1 s", numericValue: 4100.4 },
      info: { title: "Info", score: null, scoreDisplayMode: "informative" },
      edge: { title: "Edge 0.9", score: 0.9, scoreDisplayMode: "numeric" },
      ok: { title: "Just under", score: 0.89, scoreDisplayMode: "binary" },
      alt: { title: "Alt text", score: 0, scoreDisplayMode: "binary" },
      manual: { title: "Manual", score: null, scoreDisplayMode: "manual" },
      na: { title: "NA", score: null, scoreDisplayMode: "notApplicable" },
      https: { title: "HTTPS", score: 0.2, scoreDisplayMode: "binary" },
      meta: { title: "Meta", score: 1, scoreDisplayMode: "binary" },
      "largest-contentful-paint": { numericValue: 4100.4 },
      "cumulative-layout-shift": { numericValue: 0.1234 },
      "total-blocking-time": { numericValue: 250.2 },
    },
  },
  loadingExperience: {
    metrics: {
      LARGEST_CONTENTFUL_PAINT_MS: { percentile: 3000 },
      CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 12 },
      INTERACTION_TO_NEXT_PAINT: { percentile: 180 },
    },
  },
  ...over,
});

function setup(psi: PsiRequest, text = fixture) {
  const sheets: Sheet[] = [];
  const rawDir = mkdtempSync(join(tmpdir(), "raw-"));
  const run = () =>
    runAudit({ fixtureText: text, fixtureName: "urls.json", psi, writeSheets: async (s) => void sheets.push(...s), rawDir, renderReport: () => "<html></html>", sleep: async () => {}, now: new Date(2026, 10, 13, 9, 5, 7) });
  return { sheets, rawDir, run };
}

test("malformed fixtures are rejected with zero API calls", async () => {
  for (const bad of ["{nope", "[]", '[{"label":"a","type":"x"}]', '[{"label":"a","type":"x","url":"http://a.com"}]']) {
    let calls = 0;
    const { run } = setup(async () => (calls++, resp()), bad);
    await assert.rejects(run);
    assert.equal(calls, 0);
  }
});

test("mobile calls precede desktop calls, each asking for all four categories", async () => {
  const seen: string[] = [];
  const { run } = setup(async (p) => {
    seen.push(p.strategy);
    assert.deepEqual([...p.categories].sort(), ["accessibility", "best-practices", "performance", "seo"]);
    return resp();
  });
  await run();
  assert.deepEqual(seen, ["mobile", "mobile", "desktop", "desktop"]);
});

test("HTML reports are saved per call, named by label and strategy", async () => {
  const { run, rawDir } = setup(async () => resp());
  await run();
  const dir = join(rawDir, readdirSync(rawDir)[0]);
  assert.deepEqual(readdirSync(dir).sort(), ["01-Home-desktop.html", "01-Home-mobile.html", "02-PDP-A-desktop.html", "02-PDP-A-mobile.html"]);
});

test("sheet has valid unique-ish name, details, Mobile/Desktop in fixture order", async () => {
  const { run, sheets } = setup(async () => resp());
  const { failed } = await run();
  const s = sheets[0];
  assert.equal(failed, 0);
  assert.equal(s.name, "2026-11-13 09.05.07");
  assert.ok(s.name.length <= 31 && !/[:\\/?*[\]]/.test(s.name));
  assert.deepEqual(s.details.map((d) => d[0]), ["Run time", "Lighthouse version", "Fixture file"]);
  assert.equal(s.details[1][1], "12.1.0");
  assert.equal(s.details[2][1], "urls.json");
  assert.deepEqual(s.tables.map((t) => t.title), ["Mobile", "Desktop"]);
  assert.deepEqual(s.tables[0].rows.map((r) => r[0]), ["Home", "PDP – A"]);
});

test("scores, lab and field metrics map to the right columns (CLS on one scale)", async () => {
  const { run, sheets } = setup(async () => resp());
  await run();
  assert.deepEqual(sheets[0].tables[0].rows[0], [
    "Home", "home", "https://example.com/", 88, 100, 50, 95, 4100, 0.123, 250, 3000, 0.12, 180, null,
  ]);
});

test("blank field cells when no page-level data, including origin fallback", async () => {
  for (const loadingExperience of [{}, { origin_fallback: true, metrics: resp().loadingExperience.metrics }]) {
    const { run, sheets } = setup(async () => resp({ loadingExperience }));
    await run();
    assert.deepEqual(sheets[0].tables[0].rows[0].slice(10, 13), [null, null, null]);
  }
});

test("429/5xx retried up to 3 times with backoff; other 4xx not retried", async () => {
  const delays: number[] = [];
  const n = { mobile: 0, desktop: 0 };
  const flaky: PsiRequest = async ({ strategy }) => {
    if (n[strategy]++ < 3) throw Object.assign(new Error("PSI 503"), { status: 503 });
    return resp();
  };
  const a = setup(flaky, JSON.stringify([{ label: "A", type: "x", url: "https://a.com" }]));
  const r = await runAudit({ fixtureText: JSON.stringify([{ label: "A", type: "x", url: "https://a.com" }]), fixtureName: "f", psi: flaky, writeSheets: async () => {}, rawDir: a.rawDir, renderReport: () => "<html></html>", sleep: async (ms) => void delays.push(ms) });
  assert.equal(r.failed, 0);
  assert.deepEqual(delays.sort((a, b) => a - b), [1000, 1000, 2000, 2000, 4000, 4000]);

  let calls = 0;
  const b = setup(async () => (calls++, Promise.reject(Object.assign(new Error("PSI 400"), { status: 400 }))), JSON.stringify([{ label: "A", type: "x", url: "https://a.com" }]));
  assert.equal((await b.run()).failed, 2);
  assert.equal(calls, 2); // one attempt each for mobile and desktop

  let rl = 0;
  const c = setup(async () => (rl++, Promise.reject(Object.assign(new Error("PSI 429"), { status: 429 }))), JSON.stringify([{ label: "A", type: "x", url: "https://a.com" }]));
  await c.run();
  assert.equal(rl, 2 * 4); // 1 try + 3 retries per strategy
});

test("a failing URL gets an error row, others finish, failed count reported", async () => {
  const { run, sheets } = setup(async ({ url }) => {
    if (url.endsWith("/p")) throw Object.assign(new Error("PSI 400: bad"), { status: 400 });
    return resp();
  });
  const { failed } = await run();
  assert.equal(failed, 2);
  const [home, pdp] = sheets[0].tables[0].rows;
  assert.equal(home[3], 88);
  assert.equal(pdp[13], "PSI 400: bad");
  assert.deepEqual(pdp.slice(3, 13), Array(10).fill(null));
});

test("a 200 response carrying a Lighthouse runtimeError counts as a failure", async () => {
  const { run, sheets } = setup(async () => ({ lighthouseResult: { categories: {}, runtimeError: { message: "page failed" } } }));
  assert.equal((await run()).failed, 4);
  assert.match(String(sheets[0].tables[0].rows[0][13]), /page failed/);
});

test("never more than 3 calls in flight", async () => {
  const many = JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ label: `L${i}`, type: "x", url: `https://a.com/${i}` })));
  let live = 0, peak = 0;
  const { run } = setup(async () => {
    peak = Math.max(peak, ++live);
    await new Promise((r) => setTimeout(r, 5));
    live--;
    return resp();
  }, many);
  await run();
  assert.equal(peak, 3);
});

const one = JSON.stringify([{ label: "A", type: "x", url: "https://a.com" }]);

test("progress: start then done per call, with position, strategy, label, url and duration", async () => {
  const events: Progress[] = [];
  const { rawDir } = setup(async () => resp());
  await runAudit({ fixtureText: fixture, fixtureName: "f", psi: async () => resp(), writeSheets: async () => {}, rawDir, renderReport: () => "<html></html>", sleep: async () => {}, onProgress: (e) => void events.push(e) });
  const mobileHome = events.filter((e) => e.strategy === "mobile" && e.label === "Home");
  assert.deepEqual(mobileHome.map((e) => e.type), ["start", "done"]);
  assert.equal(mobileHome[0].index, 1);
  assert.equal(mobileHome[0].total, 4);
  assert.equal(mobileHome[0].url, "https://example.com/");
  assert.equal(typeof (mobileHome[1] as any).ms, "number");
  assert.equal(events.filter((e) => e.type === "start").length, 4);
  assert.equal(events.filter((e) => e.type === "done").length, 4);
});

test("progress: failures report the message; retries report the attempt number", async () => {
  const events: Progress[] = [];
  const n = { mobile: 0 };
  const psi: PsiRequest = async ({ strategy }) => {
    if (strategy === "desktop") throw Object.assign(new Error("PSI 400: bad"), { status: 400 });
    if (n.mobile++ < 1) throw Object.assign(new Error("PSI 503"), { status: 503 });
    return resp();
  };
  const { rawDir } = setup(psi, one);
  await runAudit({ fixtureText: one, fixtureName: "f", psi, writeSheets: async () => {}, rawDir, renderReport: () => "<html></html>", sleep: async () => {}, onProgress: (e) => void events.push(e) });
  const m = events.filter((e) => e.strategy === "mobile");
  assert.deepEqual(m.map((e) => e.type), ["start", "retry", "done"]);
  assert.equal((m[1] as any).attempt, 2);
  const d = events.filter((e) => e.strategy === "desktop");
  assert.deepEqual(d.map((e) => e.type), ["start", "failed"]);
  assert.equal((d[1] as any).message, "PSI 400: bad");
});

test("unwritable raw folder fails before any PSI call, naming the path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "raw-"));
  const blocker = join(dir, "file");
  writeFileSync(blocker, "x");
  const rawDir = join(blocker, "sub"); // parent is a file, so it can't be created
  let calls = 0;
  await assert.rejects(
    runAudit({ fixtureText: one, fixtureName: "f", psi: async () => (calls++, resp()), writeSheets: async () => {}, rawDir, renderReport: () => "", sleep: async () => {} }),
    (e: Error) => e.message.includes(rawDir),
  );
  assert.equal(calls, 0);
});

// ---- Findings: failing insights on a second tab (real Lighthouse 13 data, trimmed) ----
const lhr = () => JSON.parse(readFileSync(new URL("./fixtures/lhr-insights.json", import.meta.url), "utf8"));
const homeOnly = JSON.stringify([{ label: "Home", type: "home", url: "https://yumove.co.uk/" }]);
const asObjects = (t: Sheet["tables"][number]) => t.rows.map((r) => Object.fromEntries(t.headers.map((h, i) => [h, r[i]])));
async function findingsFor(l: any, text = homeOnly) {
  const { run, sheets } = setup(async () => ({ lighthouseResult: l }), text);
  await run();
  return { sheets, findings: sheets[1].tables.find((t) => t.title === "Findings")! };
}

test("each run writes the run tab plus '<run> findings'; the run tab has no findings table", async () => {
  const { sheets } = await findingsFor(lhr());
  assert.deepEqual(sheets.map((s) => s.name), ["2026-11-13 09.05.07", "2026-11-13 09.05.07 findings"]);
  assert.deepEqual(sheets[0].tables.map((t) => t.title), ["Mobile", "Desktop"]);
  assert.ok(sheets[1].name.length <= 31);
});

test("performance findings are failing insights only: no passing, informative or legacy audits", async () => {
  const l = lhr();
  l.audits["dom-size-insight"].score = 0.2;
  l.audits["dom-size-insight"].scoreDisplayMode = "informative";
  const { findings } = await findingsFor(l);
  const perf = asObjects(findings).filter((r) => r.Strategy === "mobile" && r.Category === "Performance");
  // render-blocking first (largest saving), then the rest in Lighthouse order
  assert.deepEqual(perf.map((r) => r.Insight), [
    "Render-blocking requests", "Use efficient cache lifetimes", "Forced reflow", "LCP request discovery", "Legacy JavaScript", "Network dependency tree",
  ]);
});

test("insight row: page, savings text, metrics affected, plain About and docs link", async () => {
  const { findings } = await findingsFor(lhr());
  assert.deepEqual(findings.headers.slice(0, 8), ["Page", "Strategy", "Category", "Insight", "Est. savings", "Metrics affected", "About", "Learn more"]);
  const rb = asObjects(findings).find((r) => r.Insight === "Render-blocking requests" && r.Strategy === "mobile")!;
  assert.equal(rb.Page, "Home");
  assert.equal(rb.Category, "Performance");
  assert.equal(rb["Est. savings"], "Est savings of 860 ms");
  assert.equal(rb["Metrics affected"], "FCP -850 ms");
  assert.equal(rb.About, "Requests are blocking the page’s initial render, which may delay LCP. Deferring or inlining can move these network requests out of the critical path.");
  assert.deepEqual(rb["Learn more"], { text: "Learn more", hyperlink: "https://developer.chrome.com/docs/performance/insights/render-blocking" });
  const fr = asObjects(findings).find((r) => r.Insight === "Forced reflow")!;
  assert.equal(fr["Est. savings"], "-");
  assert.equal(fr["Metrics affected"], "-");
});

test("insights are ranked by their largest metric saving; unsaved ones keep Lighthouse order", async () => {
  const l = lhr();
  l.audits["cache-insight"].metricSavings = { LCP: 1200, FCP: 0 };
  const { findings } = await findingsFor(l);
  const order = asObjects(findings).filter((r) => r.Strategy === "mobile").map((r) => r.Insight);
  assert.deepEqual(order.slice(0, 2), ["Use efficient cache lifetimes", "Render-blocking requests"]);
  assert.equal(asObjects(findings).find((r) => r.Insight === "Use efficient cache lifetimes")!["Metrics affected"], "LCP -1,200 ms");
});

test("findings are ordered by page, then strategy; a failed run contributes none and does not break the tab", async () => {
  const two = JSON.stringify([{ label: "B", type: "x", url: "https://yumove.co.uk/b" }, { label: "A", type: "x", url: "https://yumove.co.uk/a" }]);
  const { run, sheets } = setup(async ({ url, strategy }) => {
    if (url.endsWith("/a") && strategy === "desktop") throw Object.assign(new Error("PSI 400: bad"), { status: 400 });
    return { lighthouseResult: lhr() };
  }, two);
  const { failed } = await run();
  assert.equal(failed, 1);
  const rows = asObjects(sheets[1].tables.find((t) => t.title === "Findings")!);
  const seq = [...new Set(rows.map((r) => `${r.Page}/${r.Strategy}`))];
  assert.deepEqual(seq, ["B/mobile", "B/desktop", "A/mobile"]);
});

// ---- Offenders: what is causing each insight ----
const offenders = (rows: ReturnType<typeof asObjects>, insight: string) => rows.find((r) => r.Insight === insight && r.Strategy === "mobile")!.Offenders;

test("offenders: grouped by 1st/3rd party host, URLs shortened, values labelled and formatted", async () => {
  const { findings } = await findingsFor(lhr());
  assert.equal(findings.headers.at(-1), "Offenders");
  assert.equal(offenders(asObjects(findings), "Render-blocking requests"), [
    "yumove.co.uk (1st party)",
    "  …/assets/ym.main.css?v=9202544… · Transfer Size: 63.6 KiB · Duration: 946 ms",
    "  …/latest/accelerated-checkout-backwards-compat.css · Transfer Size: 2.8 KiB · Duration: 474 ms",
    "cdn.intelligems.io (3rd party)",
    "  …/c4291048ec8a/bundle.js · Transfer Size: 0.0 KiB · Duration: 780 ms",
  ].join("\n"));
});

test("offenders: nested sub-items are indented under their parent", async () => {
  const { findings } = await findingsFor(lhr());
  assert.equal(offenders(asObjects(findings), "Legacy JavaScript"), [
    "searchanise-ef84.kxcdn.com (3rd party)",
    "  /widgets.39510.min.js · Wasted bytes: 10.0 KiB",
    "    /widgets.39510.min.js:1:217196 · @babel/plugin-transform-spread",
    "    /widgets.39510.min.js:1:273433 · Math.log10",
  ].join("\n"));
});

test("offenders: capped at 10 lines then '+N more'", async () => {
  const l = lhr();
  const items = Array.from({ length: 13 }, (_, i) => ({ url: `https://yumove.co.uk/a${i}.css`, totalBytes: 1024, wastedMs: 100 + i }));
  l.audits["render-blocking-insight"].details.items = items;
  const { findings } = await findingsFor(l);
  const lines = String(offenders(asObjects(findings), "Render-blocking requests")).split("\n");
  assert.equal(lines.length, 10 + 1); // 10 lines (host header + 9 items), then "+4 more"
  assert.equal(lines.at(-1), "+4 more");
});

test("offenders: checklists list only failed checks, followed by the element", async () => {
  const { findings } = await findingsFor(lhr());
  const lines = String(offenders(asObjects(findings), "LCP request discovery")).split("\n");
  assert.equal(lines[0], "✗ fetchpriority=high should be applied to the image preload request");
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^….*img\.aspect-auto$/); // long selectors keep their tail: the element itself
});

test("offenders: insights without a useful table keep their row with an empty cell", async () => {
  const { findings } = await findingsFor(lhr());
  assert.equal(offenders(asObjects(findings), "Network dependency tree"), null);
});

// ---- Other categories: failing audits in the same layout ----
test("accessibility, best-practices and SEO failures follow the Performance rows, with element offenders", async () => {
  const { findings } = await findingsFor(lhr());
  const mobile = asObjects(findings).filter((r) => r.Strategy === "mobile");
  const cats = [...new Set(mobile.map((r) => r.Category))];
  assert.deepEqual(cats, ["Performance", "Accessibility", "Best Practices"]);
  const titles = mobile.map((r) => r.Insight);
  assert.ok(!titles.includes(lhr().audits["image-alt"].title), "passing audit excluded");
  assert.ok(!titles.includes(lhr().audits["document-title"].title), "passing SEO audit excluded");
  const cc = mobile.find((r) => r.Category === "Accessibility")!;
  assert.equal(cc["Est. savings"], "-");
  assert.equal(cc["Metrics affected"], "-");
  assert.deepEqual(cc["Learn more"], { text: "Learn more", hyperlink: "https://dequeuniversity.com/rules/axe/4.14/color-contrast" });
  const lines = String(cc.Offenders).split("\n");
  assert.match(lines[0], /^….*a#CybotCookiebotDialogBodyContentTextShowIABVendors — Element has insufficient color contrast of 2\.67/);
  assert.match(lines[1], /^ {2}.*div#CybotCookiebotDialog$/); // related node, indented
});

test("failing console errors list source and message", async () => {
  const { findings } = await findingsFor(lhr());
  const e = asObjects(findings).find((r) => r.Category === "Best Practices")!;
  assert.equal(String(e.Offenders).split("\n")[0], "yumove.co.uk/products/yumove-joint-care-plus-max-strength-for-dogs:1035:16 · Description: [Bloomreach Unified Tracking] Shopify.analytics object is not available");
});

// ---- Findings summary: one row per insight across the run ----
const twoPages = JSON.stringify([{ label: "A", type: "x", url: "https://yumove.co.uk/a" }, { label: "B", type: "x", url: "https://yumove.co.uk/b" }]);
const summaryOf = (sheets: Sheet[]) => asObjects(sheets[1].tables.find((t) => t.title === "Findings summary")!);

test("summary sits above the detail on the findings tab, ranked by runs affected then largest saving", async () => {
  const { run, sheets } = setup(async ({ url, strategy }) => {
    const l = lhr();
    if (url.endsWith("/b") && strategy === "desktop") l.audits["render-blocking-insight"].score = 1; // fixed on this run
    return { lighthouseResult: l };
  }, twoPages);
  await run();
  assert.deepEqual(sheets[1].tables.map((t) => t.title), ["Findings summary", "Findings"]);
  assert.equal(sheets[1].tables[1].filter, true);
  const rows = summaryOf(sheets);
  assert.deepEqual(rows.map((r) => r.Insight), [
    "Use efficient cache lifetimes", "Forced reflow", "LCP request discovery", "Legacy JavaScript", "Network dependency tree",
    lhr().audits["color-contrast"].title, lhr().audits["errors-in-console"].title,
    "Render-blocking requests", // 3 of 4 runs, so after everything that hits all four
  ]);
  const rb = rows.at(-1)!;
  assert.deepEqual([rb["Runs affected"], rb["Largest saving"], rb["Est. savings"], rb["Metrics affected"], rb.Category], ["3 of 4 runs", "850 ms", "Est savings of 860 ms", "FCP -850 ms", "Performance"]);
  assert.deepEqual(rb["Learn more"], { text: "Learn more", hyperlink: "https://developer.chrome.com/docs/performance/insights/render-blocking" });
  assert.equal(rows[0]["Largest saving"], "-");
});

test("summary counts only runs that produced a result", async () => {
  const { run, sheets } = setup(async ({ url, strategy }) => {
    if (url.endsWith("/a") && strategy === "desktop") throw Object.assign(new Error("PSI 400: bad"), { status: 400 });
    return { lighthouseResult: lhr() };
  }, twoPages);
  await run();
  assert.equal(summaryOf(sheets)[0]["Runs affected"], "3 of 3 runs");
});

test("an insight can rank first by larger saving among equally widespread ones", async () => {
  const l = lhr();
  l.audits["cache-insight"].metricSavings = { LCP: 1200, FCP: 0 };
  const { run, sheets } = setup(async () => ({ lighthouseResult: l }), twoPages);
  await run();
  assert.deepEqual(summaryOf(sheets).slice(0, 2).map((r) => [r.Insight, r["Largest saving"]]), [["Use efficient cache lifetimes", "1,200 ms"], ["Render-blocking requests", "850 ms"]]);
});

test("offenders: long durations such as cache lifetimes read as minutes or hours, not thousands of ms", async () => {
  const { findings } = await findingsFor(lhr());
  const text = String(offenders(asObjects(findings), "Use efficient cache lifetimes"));
  assert.match(text, /consent-sdk-2\.3\.js · Cache TTL: 13 min · Transfer Size: 88\.0 KiB/);
});
