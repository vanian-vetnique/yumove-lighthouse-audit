import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { ReportGenerator } from "lighthouse/report/generator/report-generator.js";
import { runAudit, type PsiRequest } from "./audit.ts";
import { createWorkbookWriter, workbookPath } from "./workbook.ts";

try { process.loadEnvFile(".env"); } catch {}

const key = process.env.PSI_API_KEY;
if (!key) {
  console.error("PSI_API_KEY is not set (see .env.example)");
  process.exit(1);
}

const psi: PsiRequest = async ({ url, strategy, categories }) => {
  const q = new URLSearchParams({ url, strategy, key });
  for (const c of categories) q.append("category", c);
  const res = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${q}`, { signal: AbortSignal.timeout(180_000) });
  if (!res.ok) {
    const body: any = await res.json().catch(() => ({}));
    // Never include the request URL here: it carries the API key.
    throw Object.assign(new Error(`PSI ${res.status}: ${body?.error?.message ?? res.statusText}`), { status: res.status });
  }
  return res.json();
};

try {
  const { values } = parseArgs({ options: { fixture: { type: "string", default: "fixtures/urls.json" } } });
  const { failed, sheetName } = await runAudit({
    fixtureText: readFileSync(values.fixture!, "utf8"),
    fixtureName: basename(values.fixture!),
    psi,
    writeSheet: createWorkbookWriter(workbookPath(process.env)),
    rawDir: "raw-results",
    renderReport: (lhr) => ReportGenerator.generateReportHtml(lhr),
  });
  console.log(`Wrote tab "${sheetName}"${failed ? `; ${failed} call(s) failed` : ""}`);
  process.exitCode = failed ? 1 : 0;
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
