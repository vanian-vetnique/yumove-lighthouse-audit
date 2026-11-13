import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    runAudit({ fixtureText: text, fixtureName: "urls.json", psi, writeSheet: async (s) => void sheets.push(s), rawDir, renderReport: () => "<html></html>", sleep: async () => {}, now: new Date(2026, 10, 13, 9, 5, 7) });
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
  assert.deepEqual(s.tables.map((t) => t.title), ["Mobile", "Desktop", "Findings"]);
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

test("findings: scored audits below 0.9 only, all categories, both strategies", async () => {
  const { run, sheets } = setup(async () => resp());
  await run();
  const f = sheets[0].tables[2].rows;
  assert.deepEqual(f.filter((r) => r[0] === "Home" && r[1] === "mobile").map((r) => [r[2], r[3], r[4], r[5]]), [
    ["Performance", "LCP", 0.4, "4.1 s"],
    ["Performance", "Just under", 0.89, null],
    ["Accessibility", "Alt text", 0, null],
    ["Best Practices", "HTTPS", 0.2, null],
  ]);
  assert.equal(f.filter((r) => r[1] === "desktop").length, 8);
  assert.equal(sheets[0].tables[2].filter, true);
});

test("score colour columns are declared on Mobile/Desktop only", async () => {
  const { run, sheets } = setup(async () => resp());
  await run();
  assert.deepEqual(sheets[0].tables.map((t) => t.scoreColumns), [[3, 4, 5, 6], [3, 4, 5, 6], undefined]);
});

test("429/5xx retried up to 3 times with backoff; other 4xx not retried", async () => {
  const delays: number[] = [];
  const n = { mobile: 0, desktop: 0 };
  const flaky: PsiRequest = async ({ strategy }) => {
    if (n[strategy]++ < 3) throw Object.assign(new Error("PSI 503"), { status: 503 });
    return resp();
  };
  const a = setup(flaky, JSON.stringify([{ label: "A", type: "x", url: "https://a.com" }]));
  const r = await runAudit({ fixtureText: JSON.stringify([{ label: "A", type: "x", url: "https://a.com" }]), fixtureName: "f", psi: flaky, writeSheet: async () => {}, rawDir: a.rawDir, renderReport: () => "<html></html>", sleep: async (ms) => void delays.push(ms) });
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

test("metricSavings audits below 0.9 are findings", async () => {
  const r = resp();
  r.lighthouseResult.audits.ok.scoreDisplayMode = "metricSavings";
  const { run, sheets } = setup(async () => r);
  await run();
  assert.ok(sheets[0].tables[2].rows.some((x) => x[3] === "Just under"));
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
  await runAudit({ fixtureText: fixture, fixtureName: "f", psi: async () => resp(), writeSheet: async () => {}, rawDir, renderReport: () => "<html></html>", sleep: async () => {}, onProgress: (e) => void events.push(e) });
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
  await runAudit({ fixtureText: one, fixtureName: "f", psi, writeSheet: async () => {}, rawDir, renderReport: () => "<html></html>", sleep: async () => {}, onProgress: (e) => void events.push(e) });
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
    runAudit({ fixtureText: one, fixtureName: "f", psi: async () => (calls++, resp()), writeSheet: async () => {}, rawDir, renderReport: () => "", sleep: async () => {} }),
    (e: Error) => e.message.includes(rawDir),
  );
  assert.equal(calls, 0);
});
