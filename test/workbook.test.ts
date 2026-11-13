import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { createWorkbookWriter, workbookPath, rawResultsPath } from "../src/workbook.ts";
import type { Sheet } from "../src/audit.ts";

const sheet = (name: string): Sheet => ({
  name,
  details: [["Run time", "now"]],
  tables: [
    { title: "Mobile", headers: ["Label", "Type", "URL", "P"], rows: [["Home", "home", "https://a.com", 95]], scoreColumns: [3] },
    { title: "Findings", headers: ["Label", "Score"], rows: [["Home", 0.5]], filter: true },
  ],
});

test("workbook path: default and env override", () => {
  assert.equal(workbookPath({}), "reports/lighthouse-history.xlsx");
  assert.equal(workbookPath({ AUDIT_WORKBOOK_PATH: "/x/y.xlsx" }), "/x/y.xlsx");
});

test("raw results path: default, blank and env override", () => {
  assert.equal(rawResultsPath({}), "raw-results");
  assert.equal(rawResultsPath({ RAW_RESULTS_PATH: "" }), "raw-results");
  assert.equal(rawResultsPath({ RAW_RESULTS_PATH: "/x/raw" }), "/x/raw");
});

test("creates workbook, then adds tabs without touching existing ones; names stay unique", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "wb-")), "sub", "h.xlsx");
  const write = createWorkbookWriter(path);
  await write(sheet("2026-11-13 09.05.07"));
  await write(sheet("2026-11-13 09.05.07"));
  const wb = await new ExcelJS.Workbook().xlsx.readFile(path);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ["2026-11-13 09.05.07", "2026-11-13 09.05.07 (2)"]);
  const ws = wb.worksheets[0];
  assert.equal(ws.getCell("A1").value, "Run details");
  assert.equal(ws.getCell("A1").font?.bold, true);
  assert.equal(ws.getCell("B2").value, "now");
  const header = ws.getRow(5);
  assert.equal(header.getCell(1).value, "Label");
  assert.equal(header.getCell(1).font?.bold, true);
  assert.ok(ws.getColumn(3).width! >= 15);
});

test("score cells carry three conditional-format bands; findings none", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "wb-")), "h.xlsx");
  await createWorkbookWriter(path)(sheet("a"));
  const ws = (await new ExcelJS.Workbook().xlsx.readFile(path)).worksheets[0];
  const cf = (ws as any).conditionalFormattings as { ref: string; rules: { operator: string }[] }[];
  assert.equal(cf.length, 1);
  assert.equal(cf[0].ref, "D6:D6");
  assert.deepEqual(cf[0].rules.map((r) => r.operator), ["greaterThan", "between", "lessThan"]);
});

test("unwritable workbook says to close it and re-run", { skip: process.getuid?.() === 0 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-"));
  mkdirSync(join(dir, "ro"));
  chmodSync(join(dir, "ro"), 0o500);
  await assert.rejects(createWorkbookWriter(join(dir, "ro", "h.xlsx"))(sheet("a")), /close the workbook and re-run/);
  chmodSync(join(dir, "ro"), 0o700);
});
