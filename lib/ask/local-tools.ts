/**
 * Tools that exist only inside POST /api/ask — not in the MCP catalog.
 *
 * The MCP tool set (lib/mcp/tools.ts) is a data surface: every tool returns
 * JSON about the world, and the catalog's drift check counts them. The tools
 * here produce something for the PERSON at the other end of the chat (a file
 * to download), which has no meaning over MCP and would be a lie in the
 * catalog's tool count. So they live beside the Ask loop, take the same
 * `{name, description, inputSchema, handler}` shape, and write into a
 * per-request context the handler returns to the browser.
 */

import { buildXlsx, normaliseWorkbook, safeFilename, MAX_ROWS_TOTAL, MAX_SHEETS, MAX_COLS } from "./xlsx";

export interface Attachment {
  filename: string;
  mime: string;
  bytes: number;
  base64: string;
  summary: string;
}

export interface AskContext {
  attachments: Attachment[];
}

/** Keep the JSON response comfortably under Vercel's 4.5 MB body limit. */
const ATTACHMENT_BUDGET_BYTES = 3 * 1024 * 1024;

export interface LocalTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: any, ctx: AskContext) => Promise<unknown> | unknown;
}

export const EXPORT_EXCEL: LocalTool = {
  name: "export_excel",
  description:
    "Create an Excel workbook (.xlsx) from tabular data and hand it to the user as a download. " +
    "Use it when the user asks for a spreadsheet, Excel, xlsx, CSV or export, or when a result runs to more than about fifteen rows " +
    "that the user will want to sort and filter. Fill `rows` only with data you obtained from the other tools or the user — never invent rows. " +
    "Each sheet is a header row plus rows; give columns a `format` (number, integer, currency, percent, date, text) so Excel shows typed cells. " +
    `Limits: ${MAX_SHEETS} sheets, ${MAX_COLS} columns, ${MAX_ROWS_TOTAL} rows per workbook. ` +
    "After calling it, tell the user the file is attached beneath your answer and summarise what it contains; do not paste the whole table again.",
  inputSchema: {
    type: "object",
    properties: {
      filename: { type: "string", description: "File name without path, e.g. 'illinois-ria-prospects'. '.xlsx' is appended." },
      sheets: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Tab name (31 chars max)." },
            columns: {
              type: "array",
              description: "Header cells in order. A string, or {name, format}.",
              items: {
                anyOf: [
                  { type: "string" },
                  {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      format: { type: "string", enum: ["text", "number", "integer", "currency", "percent", "date"] },
                    },
                    required: ["name"],
                  },
                ],
              },
            },
            rows: {
              type: "array",
              description: "Data rows. Each row is an array of cell values in column order (string, number, boolean or null). Percent columns take fractions (0.125 = 12.5%).",
              items: { type: "array", items: {} },
            },
          },
          required: ["name", "columns", "rows"],
        },
      },
    },
    required: ["sheets"],
  },
  handler(args, ctx) {
    const spec = normaliseWorkbook(args);
    const buf = buildXlsx(spec);
    const used = ctx.attachments.reduce((n, a) => n + a.bytes, 0);
    if (used + buf.length > ATTACHMENT_BUDGET_BYTES) {
      throw new Error(
        `workbook is ${(buf.length / 1024).toFixed(0)} KB and the response already carries ${(used / 1024).toFixed(0)} KB of attachments; ` +
          `the limit is ${(ATTACHMENT_BUDGET_BYTES / 1024 / 1024).toFixed(0)} MB. Drop columns or rows.`
      );
    }
    const filename = safeFilename(args?.filename);
    const rows = spec.sheets.reduce((n, s) => n + s.rows.length, 0);
    const summary = `${spec.sheets.length} sheet${spec.sheets.length === 1 ? "" : "s"}, ${rows} row${rows === 1 ? "" : "s"}`;
    ctx.attachments.push({
      filename,
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      bytes: buf.length,
      base64: buf.toString("base64"),
      summary,
    });
    return {
      ok: true,
      attached: filename,
      bytes: buf.length,
      sheets: spec.sheets.map((s) => ({ name: s.name, columns: s.columns.length, rows: s.rows.length })),
      note: "The file is now attached to this answer as a download. Describe it; do not reproduce the table.",
    };
  },
};

export const LOCAL_TOOLS: LocalTool[] = [EXPORT_EXCEL];
export const LOCAL_TOOL_BY_NAME: Record<string, LocalTool> = Object.fromEntries(LOCAL_TOOLS.map((t) => [t.name, t]));
