import { BadRequestException } from "@nestjs/common";
import * as XLSX from "xlsx";
import { parseCsv } from "../common/csv";
import { movementIdentifier, StatementMovement } from "./statement";

/**
 * Bank statements exported as CSV or Excel (.xlsx, legacy .xls or the HTML
 * tables some banks save as .xls), read with a column mapping chosen by the user.
 */

export const MAX_TABLE_BYTES = 5 * 1024 * 1024;
export const MAX_TABLE_ROWS = 10_000;
/** Rows returned to the user to choose the header row and columns. */
export const INSPECT_ROWS = 20;
const MAX_REPORTED_ERRORS = 50;
const DELIMITERS = [";", ",", "\t", "|"];

export class TableFormatError extends Error {}

export type TableFormat = "CSV" | "XLSX" | "XLS";
/** Text, a number from a spreadsheet, or an ISO date from a date-formatted spreadsheet cell. */
export type Cell = string | number;
export type Table = { format: TableFormat; delimiter: string | null; rows: Cell[][] };

export type TableMapping = {
  headerRow: number;
  delimiter?: string;
  dateColumn: string;
  valueDateColumn?: string;
  amountMode: "SIGNED" | "SPLIT";
  amountColumn?: string;
  debitColumn?: string;
  creditColumn?: string;
  decimalSeparator: "," | ".";
  descriptionColumns: string[];
  referenceColumn?: string;
  counterpartyColumn?: string;
};

export type TableRowError = { row: number; message: string };

export function readTable(content: Buffer, delimiter?: string): Table {
  if (startsWith(content, [0x50, 0x4b, 0x03, 0x04])) return readWorkbook(content, "XLSX");
  if (startsWith(content, [0xd0, 0xcf, 0x11, 0xe0])) return readWorkbook(content, "XLS");
  const text = decode(content);
  if (/^\s*</.test(text)) return readWorkbook(content, "XLS");
  const chosen = delimiter ?? detectDelimiter(text);
  let rows: string[][];
  try {
    rows = parseCsv(text, chosen);
  } catch (error) {
    if (error instanceof BadRequestException)
      throw new TableFormatError("The CSV has an unclosed quoted field");
    throw error;
  }
  return { format: "CSV", delimiter: chosen, rows: limitRows(rows) };
}

/** Header names as shown to the user: blanks get a position and repeats a suffix. */
export function columnNames(row: Cell[] = []) {
  const seen = new Map<string, number>();
  return row.map((cell, index) => {
    const name = String(cell).trim() || `Columna ${index + 1}`;
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    return count === 1 ? name : `${name} (${count})`;
  });
}

/** A best guess from common Spanish bank headers; unknown columns stay empty. */
export function suggestMapping(table: Table): TableMapping {
  const sample = table.rows.slice(0, INSPECT_ROWS);
  let headerRow = sample.findIndex((row) => row.some((cell) => /fecha/i.test(String(cell))));
  if (headerRow < 0)
    headerRow = Math.max(0, sample.findIndex((row) => row.filter((cell) => String(cell).trim()).length >= 3));
  const columns = columnNames(table.rows[headerRow]).map((name) => ({ name, key: normalize(name) }));
  const find = (pattern: RegExp, exclude?: RegExp) =>
    columns.find(({ key }) => pattern.test(key) && !exclude?.test(key))?.name;
  const dateColumn =
    find(/fecha.*(operacion|contable|movimiento)/) ?? find(/fecha/, /valor/) ?? "";
  const amountColumn = find(/importe|cantidad|amount/, /saldo/);
  const debitColumn = find(/cargo|debe|debito|salida/);
  const creditColumn = find(/abono|haber|credito|ingreso|entrada/);
  const split = !amountColumn && Boolean(debitColumn && creditColumn);
  const amountColumns = split ? [debitColumn, creditColumn] : [amountColumn];
  const amountIndexes = amountColumns.map((name) => columns.findIndex((column) => column.name === name));
  const amountSamples = table.rows
    .slice(headerRow + 1, headerRow + 1 + INSPECT_ROWS)
    .flatMap((row) => amountIndexes.map((index) => (index >= 0 ? row[index] : "")))
    .filter((cell): cell is string => typeof cell === "string" && /\d/.test(cell));
  const description = find(/concepto|descripcion|detalle|movimiento/, /fecha/);
  return {
    headerRow,
    ...(table.delimiter ? { delimiter: table.delimiter } : {}),
    dateColumn,
    ...optional("valueDateColumn", find(/fecha.*valor/)),
    amountMode: split ? "SPLIT" : "SIGNED",
    ...(split
      ? { debitColumn, creditColumn }
      : optional("amountColumn", amountColumn)),
    decimalSeparator: amountSamples.some((cell) => /\d\.\d{1,2}$/.test(cell.trim())) &&
      !amountSamples.some((cell) => /\d,\d{1,2}$/.test(cell.trim()))
      ? "."
      : ",",
    descriptionColumns: description ? [description] : [],
    ...optional("referenceColumn", find(/referencia|^ref\b/)),
    ...optional("counterpartyColumn", find(/beneficiario|ordenante|contraparte|remitente/)),
  };
}

export function readMovements(table: Table, mapping: TableMapping) {
  const columns = columnNames(table.rows[mapping.headerRow]);
  if (!columns.length)
    throw new TableFormatError(`Row ${mapping.headerRow + 1} has no columns to use as headers`);
  const index = (name: string | undefined) => {
    if (name === undefined) return undefined;
    const position = columns.indexOf(name);
    if (position < 0) throw new TableFormatError(`Column "${name}" is not in the header row`);
    return position;
  };
  const date = index(mapping.dateColumn)!;
  const valueDate = index(mapping.valueDateColumn);
  const amount = index(mapping.amountMode === "SIGNED" ? mapping.amountColumn : undefined);
  const debit = index(mapping.amountMode === "SPLIT" ? mapping.debitColumn : undefined);
  const credit = index(mapping.amountMode === "SPLIT" ? mapping.creditColumn : undefined);
  if (mapping.amountMode === "SIGNED" ? amount === undefined : debit === undefined || credit === undefined)
    throw new TableFormatError("The mapping does not say which columns hold the amount");
  const descriptions = mapping.descriptionColumns.map((name) => index(name)!);
  const reference = index(mapping.referenceColumn);
  const counterparty = index(mapping.counterpartyColumn);
  const identify = movementIdentifier("tab");
  const movements: StatementMovement[] = [];
  const errors: TableRowError[] = [];
  let errorCount = 0;
  let ignored = 0;
  for (const [offset, row] of table.rows.slice(mapping.headerRow + 1).entries()) {
    const rowNumber = mapping.headerRow + offset + 2;
    if (row.every((cell) => text(cell) === "")) continue;
    // Lines without a date are titles, subtotals or balances, not movements.
    if (text(row[date]) === "") {
      ignored += 1;
      continue;
    }
    try {
      const operationDate = parseDate(row[date], "date");
      const valueDateText = valueDate === undefined ? "" : text(row[valueDate]);
      const amountCents =
        amount !== undefined
          ? required(parseAmount(row[amount], mapping.decimalSeparator), "The amount is empty")
          : splitAmount(row[debit!], row[credit!], mapping.decimalSeparator);
      const referenceText = cut(reference === undefined ? "" : text(row[reference]), 240);
      const counterpartyText = cut(counterparty === undefined ? "" : text(row[counterparty]), 240);
      const description = cut(
        descriptions.map((position) => text(row[position])).filter(Boolean).join(" · ") ||
          counterpartyText ||
          referenceText ||
          "Movimiento bancario",
        1000,
      );
      const movement = {
        operationDate,
        valueDate: valueDateText ? parseDate(valueDateText, "value date") : null,
        amountCents,
        description,
        reference: referenceText || null,
        counterpartyName: counterpartyText || null,
      };
      movements.push({
        externalId: identify(
          [movement.operationDate, movement.valueDate ?? "", amountCents, description, referenceText, counterpartyText].join("|"),
        ),
        ...movement,
      });
      if (movements.length > MAX_TABLE_ROWS)
        throw new TableFormatError(`The file exceeds ${MAX_TABLE_ROWS} movements`);
    } catch (error) {
      if (!(error instanceof RowError)) throw error;
      errorCount += 1;
      if (errors.length < MAX_REPORTED_ERRORS) errors.push({ row: rowNumber, message: error.message });
    }
  }
  return { movements, errors, errorCount, ignored };
}

class RowError extends Error {}

function readWorkbook(content: Buffer, format: TableFormat): Table {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(content, {
      type: "buffer",
      dense: true,
      cellNF: true,
      cellFormula: false,
      cellHTML: false,
      cellStyles: false,
      raw: true,
      sheetRows: MAX_TABLE_ROWS + INSPECT_ROWS + 1,
    });
  } catch {
    throw new TableFormatError("The spreadsheet cannot be read");
  }
  const sheet = workbook.Sheets[workbook.SheetNames[0]] as XLSX.DenseSheet | undefined;
  if (!sheet) throw new TableFormatError("The spreadsheet has no sheets");
  const date1904 = Boolean(workbook.Workbook?.WBProps?.date1904);
  // Dense sheets leave holes for empty rows and cells.
  const rows = Array.from(sheet["!data"] ?? [], (row) =>
    Array.from(row ?? [], (cell) => spreadsheetCell(cell, date1904)),
  );
  return { format, delimiter: null, rows: limitRows(rows) };
}

function spreadsheetCell(cell: XLSX.CellObject | undefined, date1904: boolean): Cell {
  if (!cell || cell.t === "e" || cell.v === undefined || cell.v === null) return "";
  if (cell.t === "n" && typeof cell.v === "number") {
    if (cell.z && XLSX.SSF.is_date(cell.z)) return serialDate(cell.v + (date1904 ? 1462 : 0));
    return cell.v;
  }
  if (cell.v instanceof Date) return cell.v.toISOString().slice(0, 10);
  return String(cell.v);
}

function limitRows<T>(rows: T[]) {
  if (rows.length > MAX_TABLE_ROWS + INSPECT_ROWS)
    throw new TableFormatError(`The file exceeds ${MAX_TABLE_ROWS} rows`);
  return rows;
}

function detectDelimiter(text: string) {
  const sample = text.split(/\r?\n/).filter((line) => line.trim()).slice(0, 30).join("\n");
  let best = { delimiter: DELIMITERS[0], score: 0 };
  for (const delimiter of DELIMITERS) {
    let rows: string[][];
    try {
      rows = parseCsv(sample, delimiter);
    } catch {
      continue;
    }
    const counts = new Map<number, number>();
    for (const row of rows) if (row.length > 1) counts.set(row.length, (counts.get(row.length) ?? 0) + 1);
    // The delimiter giving the most rows with the same number of columns wins.
    const score = Math.max(0, ...counts.values());
    if (score > best.score) best = { delimiter, score };
  }
  return best.delimiter;
}

function decode(content: Buffer) {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    text = new TextDecoder("windows-1252").decode(content);
  }
  return text.replace(/^﻿/, "");
}

function startsWith(content: Buffer, bytes: number[]) {
  return bytes.every((byte, index) => content[index] === byte);
}

function text(cell: Cell | undefined) {
  return cell === undefined ? "" : String(cell).replace(/\s+/g, " ").trim();
}

function cut(value: string, length: number) {
  return value.slice(0, length);
}

function required(value: number | null, message: string) {
  if (value === null) throw new RowError(message);
  return value;
}

function splitAmount(debit: Cell | undefined, credit: Cell | undefined, separator: "," | ".") {
  const out = parseAmount(debit, separator);
  const into = parseAmount(credit, separator);
  if (out === null && into === null) throw new RowError("Both the debit and the credit are empty");
  return Math.abs(into ?? 0) - Math.abs(out ?? 0);
}

function parseAmount(cell: Cell | undefined, separator: "," | "."): number | null {
  if (typeof cell === "number") {
    if (!Number.isFinite(cell)) throw new RowError("The amount is not a number");
    return Math.round(cell * 100);
  }
  const value = text(cell);
  if (!value) return null;
  const negative = /^-|-$|^\(.*\)$/.test(value);
  const thousands = separator === "," ? "." : ",";
  const digits = value
    .replace(/[()+\-\s €$£]|EUR/gi, "")
    .split(thousands)
    .join("")
    .replace(separator, ".");
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(digits);
  if (!match) throw new RowError(`The amount "${value}" is not valid`);
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return negative ? -cents : cents;
}

function parseDate(cell: Cell | undefined, field: string) {
  if (typeof cell === "number") {
    // A date typed as a plain number in a spreadsheet: an Excel serial day.
    if (cell >= 1 && cell < 2_958_466) return serialDate(cell);
    throw new RowError(`The ${field} "${cell}" is not valid`);
  }
  const value = text(cell);
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/.exec(value);
  const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})(?: .*)?$/.exec(value);
  const parts = iso
    ? { year: iso[1], month: iso[2], day: iso[3] }
    : dmy
      ? { year: dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3], month: dmy[2], day: dmy[1] }
      : undefined;
  const result =
    parts && `${parts.year}-${parts.month.padStart(2, "0")}-${parts.day.padStart(2, "0")}`;
  const parsed = result ? new Date(`${result}T00:00:00.000Z`) : undefined;
  if (!result || !parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result)
    throw new RowError(`The ${field} "${value}" is not a valid DD/MM/YYYY or YYYY-MM-DD date`);
  return result;
}

function serialDate(serial: number) {
  // Excel's day zero is 1899-12-30 once its fictitious 29 February 1900 is skipped.
  return new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function normalize(value: string) {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
}

function optional<K extends string>(key: K, value: string | undefined) {
  return (value ? { [key]: value } : {}) as Partial<Record<K, string>>;
}
