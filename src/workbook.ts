import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import ExcelJS from "exceljs";
import type { Sheet } from "./audit.ts";

const DEFAULT_PATH = "reports/lighthouse-history.xlsx";
export const workbookPath = (env: Record<string, string | undefined>) => env.AUDIT_WORKBOOK_PATH || DEFAULT_PATH;

const fill = (argb: string) => ({ type: "pattern" as const, pattern: "solid" as const, bgColor: { argb } });
// Lighthouse bands; scores are rounded integers so 89.5 splits 89 from 90.
const BANDS = [
  { operator: "greaterThan", formulae: [89.5], argb: "FFC6EFCE" },
  { operator: "between", formulae: [50, 89.5], argb: "FFFFEB9C" },
  { operator: "lessThan", formulae: [50], argb: "FFFFC7CE" },
] as const;

export function createWorkbookWriter(path: string) {
  return async (sheet: Sheet) => {
    const wb = new ExcelJS.Workbook();
    if (existsSync(path)) await wb.xlsx.readFile(path);
    let name = sheet.name;
    for (let n = 2; wb.getWorksheet(name); n++) name = `${sheet.name} (${n})`;
    const ws = wb.addWorksheet(name);

    ws.addRow(["Run details"]).font = { bold: true };
    for (const d of sheet.details) ws.addRow(d);
    for (const t of sheet.tables) {
      ws.addRow([]);
      ws.addRow([t.title]).font = { bold: true };
      const header = ws.addRow(t.headers);
      header.font = { bold: true };
      const first = ws.rowCount + 1;
      for (const r of t.rows) ws.addRow(r);
      const last = ws.rowCount;
      if (t.filter) ws.autoFilter = { from: { row: header.number, column: 1 }, to: { row: last, column: t.headers.length } };
      if (t.scoreColumns && last >= first) {
        for (const c of t.scoreColumns) {
          const col = ws.getColumn(c + 1).letter;
          ws.addConditionalFormatting({
            ref: `${col}${first}:${col}${last}`,
            rules: BANDS.map((b, i) => ({
              type: "cellIs" as const, operator: b.operator, formulae: [...b.formulae], priority: i + 1,
              style: { fill: fill(b.argb) },
            })),
          });
        }
      }
    }
    ws.columns.forEach((col) => {
      let w = 12;
      col.eachCell?.({ includeEmpty: false }, (c) => { w = Math.max(w, String(c.value ?? "").length + 2); });
      col.width = Math.min(w, 60);
    });

    try {
      await mkdir(dirname(path), { recursive: true });
      await wb.xlsx.writeFile(path);
    } catch (e) {
      throw new Error(`Could not save ${path}: close the workbook and re-run (raw results are kept). ${(e as Error).message}`);
    }
  };
}
