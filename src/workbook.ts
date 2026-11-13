import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import ExcelJS from "exceljs";
import type { Cell, Sheet } from "./audit.ts";

const DEFAULT_PATH = "reports/lighthouse-history.xlsx";
export const workbookPath = (env: Record<string, string | undefined>) => env.AUDIT_WORKBOOK_PATH || DEFAULT_PATH;

export const rawResultsPath = (env: Record<string, string | undefined>) => env.RAW_RESULTS_PATH || "raw-results";

const solid = (argb: string) => ({ type: "pattern" as const, pattern: "solid" as const, fgColor: { argb }, bgColor: { argb } });
const cf = (argb: string) => ({ type: "pattern" as const, pattern: "solid" as const, bgColor: { argb } });
// Lighthouse bands; scores are rounded integers so 89.5 splits 89 from 90.
const BANDS = [
  { operator: "greaterThan", formulae: [89.5], argb: "FFC6EFCE" },
  { operator: "between", formulae: [50, 89.5], argb: "FFFFEB9C" },
  { operator: "lessThan", formulae: [50], argb: "FFFFC7CE" },
] as const;

const GRID = { style: "thin" as const, color: { argb: "FFD0D5DD" } };
const BORDER = { top: GRID, left: GRID, bottom: GRID, right: GRID };
const HEADER_FILL = solid("FF334155");
const FIRST_COL = 2; // column A is a blank gutter
const DEFAULT_WIDTH = 14;

function addSheet(wb: ExcelJS.Workbook, sheet: Sheet, name: string) {
    const ws = wb.addWorksheet(name, { views: [{ showGridLines: false }] });

    const put = (cells: Cell[]) => ws.addRow([null, ...cells]); // shift right of the gutter
    const title = (t: string) => { const c = put([t]).getCell(FIRST_COL); c.font = { bold: true, size: 13 }; };

    ws.addRow([]); // blank first row
    if (sheet.details.length) title("Run details");
    for (const d of sheet.details) {
      const row = put(d);
      ws.mergeCells(row.number, FIRST_COL + 1, row.number, FIRST_COL + 2); // value spans two columns
      row.getCell(FIRST_COL).font = { bold: true };
      for (let c = FIRST_COL; c <= FIRST_COL + 2; c++) { row.getCell(c).border = BORDER; row.getCell(c).alignment = { vertical: "top" }; }
    }
    sheet.tables.forEach((t, ti) => {
      if (ti > 0 || sheet.details.length) ws.addRow([]);
      title(t.title);
      const cols = t.headers.map((_, i) => t.columns?.[i] ?? {});
      const header = put(t.headers);
      header.height = 30;
      t.headers.forEach((_, i) => {
        const c = header.getCell(FIRST_COL + i);
        c.font = { bold: true, color: { argb: "FFFFFFFF" } };
        c.fill = HEADER_FILL;
        c.border = BORDER;
        c.alignment = { vertical: "middle", horizontal: cols[i].align ?? "left", wrapText: true };
      });
      const first = ws.rowCount + 1;
      for (const r of t.rows) {
        const row = put(r);
        cols.forEach((col, i) => {
          const c = row.getCell(FIRST_COL + i);
          c.border = BORDER;
          c.alignment = { vertical: "top", horizontal: col.align ?? "left", wrapText: true };
          if (col.numFmt) c.numFmt = col.numFmt;
          if (typeof r[i] === "object" && r[i] !== null) c.font = { color: { argb: "FF1D4ED8" }, underline: true };
        });
      }
      const last = ws.rowCount;
      if (t.filter && last > header.number) ws.autoFilter = { from: { row: header.number, column: FIRST_COL }, to: { row: last, column: FIRST_COL + t.headers.length - 1 } };
      if (t.scoreColumns && last >= first) {
        for (const c of t.scoreColumns) {
          const col = ws.getColumn(c + FIRST_COL).letter;
          ws.addConditionalFormatting({
            ref: `${col}${first}:${col}${last}`,
            rules: BANDS.map((b, i) => ({
              type: "cellIs" as const, operator: b.operator, formulae: [...b.formulae], priority: i + 1,
              style: { fill: cf(b.argb) },
            })),
          });
        }
      }
    });
    // Tables stack on shared columns, so a column is as wide as the widest table asks.
    ws.getColumn(1).width = 3;
    const ncols = Math.max(...sheet.tables.map((t) => t.headers.length));
    for (let i = 0; i < ncols; i++) {
      ws.getColumn(FIRST_COL + i).width = Math.max(DEFAULT_WIDTH, ...sheet.tables.map((t) => t.columns?.[i]?.width ?? 0));
    }
}

export function createWorkbookWriter(path: string) {
  return async (sheets: Sheet[]) => {
    const wb = new ExcelJS.Workbook();
    if (existsSync(path)) await wb.xlsx.readFile(path);
    // One suffix for the whole run so its tabs stay paired: "X", "X findings" -> "X (2)", "X findings (2)".
    let suffix = "";
    for (let n = 2; sheets.some((s) => wb.getWorksheet(s.name + suffix)); n++) suffix = ` (${n})`;
    for (const sheet of sheets) addSheet(wb, sheet, sheet.name + suffix);

    try {
      await mkdir(dirname(path), { recursive: true });
      await wb.xlsx.writeFile(path);
    } catch (e) {
      throw new Error(`Could not save ${path}: close the workbook and re-run (raw results are kept). ${(e as Error).message}`);
    }
  };
}
