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
    { title: "Mobile", headers: ["Label", "Type", "URL", "P"], rows: [["Home", "home", "https://a.com", 95]], scoreColumns: [3],
      columns: [{ width: 24 }, { width: 14 }, { width: 45 }, { width: 14, align: "center", numFmt: "0.000" }] },
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
  assert.equal(ws.getCell("B2").value, "Run details");
  assert.equal(ws.getCell("B2").font?.bold, true);
  assert.equal(ws.getCell("B3").value, "Run time");
  assert.equal(ws.getCell("C3").value, "now");
});

test("layout: blank gutter and top row, no gridlines, styled bordered headers", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "wb-")), "h.xlsx");
  await createWorkbookWriter(path)(sheet("a"));
  const ws = (await new ExcelJS.Workbook().xlsx.readFile(path)).worksheets[0];
  assert.equal(ws.views[0].showGridLines, false);
  assert.ok(ws.getColumn(1).width! < 5);
  for (let r = 1; r <= ws.rowCount; r++) assert.equal(ws.getCell(r, 1).value, null);
  assert.equal(ws.getRow(1).hasValues, false);
  assert.equal(ws.getColumn(4).width, 45); // explicit, not sized from the longest cell
  const h = ws.getCell("B6"); // Mobile header row
  assert.equal(h.value, "Label");
  assert.equal(h.font?.bold, true);
  assert.equal(h.font?.color?.argb, "FFFFFFFF");
  assert.equal((h.fill as any).fgColor.argb, "FF334155");
  assert.equal(h.border?.top?.style, "thin");
  assert.equal(ws.getCell("B7").border?.bottom?.style, "thin"); // body cells bordered too
  assert.equal(ws.getCell("B7").alignment?.vertical, "top");
  assert.equal(ws.getCell("E6").alignment?.horizontal, "center"); // numeric column header centred
  assert.equal(ws.getCell("E7").numFmt, "0.000");
});

test("score cells carry three conditional-format bands; findings none", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "wb-")), "h.xlsx");
  await createWorkbookWriter(path)(sheet("a"));
  const ws = (await new ExcelJS.Workbook().xlsx.readFile(path)).worksheets[0];
  const cf = (ws as any).conditionalFormattings as { ref: string; rules: { operator: string }[] }[];
  assert.equal(cf.length, 1);
  assert.equal(cf[0].ref, "E7:E7");
  assert.deepEqual(cf[0].rules.map((r) => r.operator), ["greaterThan", "between", "lessThan"]);
});

test("unwritable workbook says to close it and re-run", { skip: process.getuid?.() === 0 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-"));
  mkdirSync(join(dir, "ro"));
  chmodSync(join(dir, "ro"), 0o500);
  await assert.rejects(createWorkbookWriter(join(dir, "ro", "h.xlsx"))(sheet("a")), /close the workbook and re-run/);
  chmodSync(join(dir, "ro"), 0o700);
});
