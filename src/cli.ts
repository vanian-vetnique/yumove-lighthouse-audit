import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { parseArgs } from "node:util";
import { ReportGenerator } from "lighthouse/report/generator/report-generator.js";
import { runAudit, type Progress } from "./audit.ts";
import { psiRequest } from "./psi.ts";
import { createWorkbookWriter, rawResultsPath, workbookPath } from "./workbook.ts";

try { process.loadEnvFile(".env"); } catch {}

const key = process.env.PSI_API_KEY;
if (!key) {
  console.error("PSI_API_KEY is not set (see .env.example)");
  process.exit(1);
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const onProgress = (e: Progress) => {
  const tag = `[${e.index}/${e.total}] ${e.strategy} ${e.label}`;
  if (e.type === "start") console.log(`${tag} ${e.url}`);
  else if (e.type === "retry") console.log(`${tag} retrying (attempt ${e.attempt})`);
  else if (e.type === "done") console.log(`${tag} done in ${secs(e.ms)}`);
  else console.log(`${tag} FAILED after ${secs(e.ms)}: ${e.message}`);
};

let runDir = "";
try {
  const { values } = parseArgs({ options: { fixture: { type: "string", default: "fixtures/urls.json" } } });
  const { failed, sheetName } = await runAudit({
    fixtureText: readFileSync(values.fixture!, "utf8"),
    fixtureName: basename(values.fixture!),
    psi: psiRequest(key),
    writeSheets: createWorkbookWriter(workbookPath(process.env)),
    rawDir: rawResultsPath(process.env),
    workbookDir: dirname(workbookPath(process.env)),
    onProgress,
    onRunDir: (d) => { runDir = d; },
    renderReport: (lhr) => ReportGenerator.generateReportHtml(lhr),
  });
  console.log(`Wrote tab "${sheetName}"${failed ? `; ${failed} call(s) failed` : ""}. Raw reports: ${runDir}`);
  process.exitCode = failed ? 1 : 0;
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
