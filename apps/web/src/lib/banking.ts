import { z } from "zod";
import type { Account } from "./accounting";

export interface BankAccount {
  id: string;
  accountId: string;
  name: string;
  iban: string | null;
  currency: string;
  active: boolean;
  account: Account;
}

export interface BankTransaction {
  id: string;
  bankAccountId: string;
  externalId: string;
  bookingDate: string;
  valueDate: string | null;
  amount: string;
  currency: string;
  description: string;
  counterpartyName: string | null;
  reference: string | null;
  status: "UNMATCHED" | "RECONCILED";
  bankAccount: BankAccount;
  reconciliation: { id: string; journalLineId: string } | null;
}

export interface BankTransactionPage {
  data: BankTransaction[];
  nextCursor: string | null;
}

export interface ReconciliationSuggestion {
  journalLineId: string;
  score: number;
  account: { id: string; code: string };
  entry: {
    id: string;
    entryNumber: string;
    entryDate: string;
    description: string;
    sourceType: string;
    sourceId: string;
  };
  debit: string;
  credit: string;
}

export interface StatementMovement {
  externalId: string;
  bookingDate: string;
  valueDate: string | null;
  amount: string;
  description: string;
  reference: string | null;
  counterpartyName: string | null;
  status: "NEW" | "DUPLICATE" | "SKIPPED";
}

/** One account of a statement; CSV and Excel files carry neither dates range nor balances when empty. */
export interface StatementAccountPreview {
  iban: string | null;
  holderName: string;
  currency: string;
  startDate: string | null;
  endDate: string | null;
  openingBalance: string | null;
  closingBalance: string | null;
  bankAccount: { id: string; name: string; iban: string | null } | null;
  newCount: number;
  duplicateCount: number;
  skippedCount: number;
  movements: StatementMovement[];
}

export interface StatementPreview {
  fileSha256: string;
  accounts: StatementAccountPreview[];
  /** CSV and Excel only. */
  errors?: Array<{ row: number; message: string }>;
  errorCount?: number;
  ignoredCount?: number;
}

export interface TableMapping {
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
}

export interface TableInspection {
  fileSha256: string;
  format: "CSV" | "XLSX" | "XLS";
  delimiter: string | null;
  rows: string[][];
  mapping: TableMapping;
  savedMapping: boolean;
}

/** Header names as the API resolves them: blanks get a position and repeats a suffix. */
export function tableColumns(row: string[] = []) {
  const seen = new Map<string, number>();
  return row.map((cell, index) => {
    const name = cell.trim() || `Columna ${index + 1}`;
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    return count === 1 ? name : `${name} (${count})`;
  });
}

export function completeMapping(mapping: TableMapping) {
  return Boolean(
    mapping.dateColumn &&
      mapping.descriptionColumns[0] &&
      (mapping.amountMode === "SIGNED"
        ? mapping.amountColumn
        : mapping.debitColumn && mapping.creditColumn),
  );
}

/** Norma 43 files start with an account header: 11 + bank, branch and account digits. */
export function isNorma43(head: string) {
  return /^﻿?\s*11\d{18}/.test(head);
}

export interface StatementImportResult {
  fileSha256: string;
  imported: number;
  duplicates: number;
  skipped: number;
  accounts: Array<{
    bankAccountId: string;
    iban: string | null;
    imported: number;
    duplicates: number;
    skipped: number;
  }>;
}

export function statementImportNotice({ imported, duplicates, skipped }: StatementImportResult) {
  const count = (value: number, one: string, many: string) => `${value} ${value === 1 ? one : many}`;
  return [
    count(imported, "movimiento importado", "movimientos importados"),
    duplicates ? count(duplicates, "ya estaba importado", "ya estaban importados") : "",
    skipped ? count(skipped, "omitido por importe cero", "omitidos por importe cero") : "",
  ]
    .filter(Boolean)
    .join(" · ") + ".";
}

const statementFields: Record<string, string> = {
  "bank code": "código de entidad",
  "branch code": "código de oficina",
  "account number": "número de cuenta",
  "start date": "fecha inicial",
  "end date": "fecha final",
  "opening balance": "saldo inicial",
  "closing balance": "saldo final",
  "movement amount": "importe del movimiento",
  "operation date": "fecha de operación",
  "value date": "fecha valor",
  "record count": "número de registros",
  "debit count": "número de cargos",
  "debit total": "total de cargos",
  "credit count": "número de abonos",
  "credit total": "total de abonos",
};
const field = (name: string) => statementFields[name] ?? name;

const statementErrors: Array<[RegExp, (...groups: string[]) => string]> = [
  [/^Records found after the end-of-file record 88$/, () => "Hay registros después del registro final 88."],
  [/^Account header 11 found before record 33 closed the previous account$/, () => "Hay una cabecera de cuenta 11 antes de que el registro 33 cierre la cuenta anterior."],
  [/^Movement 22 found outside an account block$/, () => "Hay un movimiento 22 fuera de un bloque de cuenta."],
  [/^The file exceeds (\d+) movements$/, (limit) => `El fichero supera los ${limit} movimientos.`],
  [/^Concept record 23 found without a movement 22$/, () => "Hay un concepto 23 sin su movimiento 22."],
  [/^A movement has more than five concept records 23$/, () => "Un movimiento tiene más de cinco conceptos 23."],
  [/^Equivalence record 24 found without a movement 22$/, () => "Hay una equivalencia 24 sin su movimiento 22."],
  [/^Account totals 33 found outside an account block$/, () => "Hay unos totales 33 fuera de un bloque de cuenta."],
  [/^End-of-file record 88 found before record 33 closed the account$/, () => "El registro final 88 aparece antes de que el registro 33 cierre la cuenta."],
  [/^Record 88 declares (\d+) records but the file has (\d+)$/, (declared, actual) => `El registro 88 declara ${declared} registros, pero el fichero tiene ${actual}.`],
  [/^Unknown record type "(.*)"$/, (code) => `El tipo de registro «${code}» no existe en Norma 43.`],
  [/^The file ends before record 33 closed the last account$/, () => "El fichero termina sin el registro 33 que cierra la última cuenta."],
  [/^The file contains no account blocks$/, () => "El fichero no contiene ninguna cuenta."],
  [/^Record is longer than 80 characters$/, () => "El registro tiene más de 80 caracteres."],
  [/^The statement end date is before its start date$/, () => "La fecha final del extracto es anterior a la inicial."],
  [/^Account totals 33 do not match the account header 11$/, () => "Los totales 33 no corresponden a la cuenta de la cabecera 11."],
  [/^The number of (debits|credits) does not match record 33$/, (kind) => `El número de ${kind === "debits" ? "cargos" : "abonos"} no coincide con el registro 33.`],
  [/^The (debit|credit) total does not match record 33$/, (kind) => `El total de ${kind === "debit" ? "cargos" : "abonos"} no coincide con el registro 33.`],
  [/^Opening balance plus movements does not equal the closing balance$/, () => "El saldo inicial más los movimientos no coincide con el saldo final."],
  [/^The currency in record 33 does not match the account header 11$/, () => "La divisa del registro 33 no coincide con la de la cabecera 11."],
  [/^The (.+) must be numeric$/, (name) => `El campo ${field(name)} debe ser numérico.`],
  [/^The (.+) is not a valid YYMMDD date$/, (name) => `La ${field(name)} no es una fecha AAMMDD válida.`],
  [/^The debit\/credit key of the (.+) must be 1 or 2$/, (name) => `La clave de cargo o abono del ${field(name)} debe ser 1 o 2.`],
  [/^Unsupported currency code "(.*)"$/, (code) => `La divisa «${code}» no está admitida.`],
];

const tableErrors: Array<[RegExp, (...groups: string[]) => string]> = [
  [/^The CSV has an unclosed quoted field$/, () => "Hay un campo entre comillas sin cerrar."],
  [/^The spreadsheet cannot be read$/, () => "La hoja de cálculo no se puede abrir."],
  [/^The spreadsheet has no sheets$/, () => "La hoja de cálculo no tiene hojas."],
  [/^The file exceeds (\d+) (rows|movements)$/, (limit, kind) => `El fichero supera ${kind === "rows" ? `las ${limit} filas` : `los ${limit} movimientos`}.`],
  [/^Column "(.*)" is not in the header row$/, (name) => `La columna «${name}» no está en la fila de cabecera.`],
  [/^Row (\d+) has no columns to use as headers$/, (row) => `La fila ${row} no tiene columnas para usar como cabecera.`],
  [/^The mapping does not say which columns hold the amount$/, () => "Indica qué columnas contienen el importe."],
];

const rowErrors: Array<[RegExp, (...groups: string[]) => string]> = [
  [/^The date "(.*)" is not a valid DD\/MM\/YYYY or YYYY-MM-DD date$/, (value) => `La fecha «${value}» no es válida (DD/MM/AAAA o AAAA-MM-DD).`],
  [/^The value date "(.*)" is not a valid DD\/MM\/YYYY or YYYY-MM-DD date$/, (value) => `La fecha valor «${value}» no es válida (DD/MM/AAAA o AAAA-MM-DD).`],
  [/^The (value date|date) "(.*)" is not valid$/, (kind, value) => `La ${kind === "date" ? "fecha" : "fecha valor"} «${value}» no es válida.`],
  [/^The amount is empty$/, () => "Falta el importe."],
  [/^The amount is not a number$/, () => "El importe no es un número."],
  [/^The amount "(.*)" is not valid$/, (value) => `El importe «${value}» no es válido. Revisa el separador decimal.`],
  [/^Both the debit and the credit are empty$/, () => "Faltan el cargo y el abono."],
];

function translateWith(table: Array<[RegExp, (...groups: string[]) => string]>, message: string) {
  const match = table.find(([pattern]) => pattern.test(message));
  return match ? match[1](...match[0].exec(message)!.slice(1)) : message;
}

/** Spanish wording for a CSV or Excel row error. */
export function translateRowError(message: string) {
  return translateWith(rowErrors, message);
}

/** Spanish wording for the API's statement errors; unknown messages pass through. */
export function translateStatementError(message: string) {
  const invalid = /^Invalid Norma 43 file\. (?:Line (\d+): )?(.*)$/.exec(message);
  if (invalid) {
    const [, line, reason] = invalid;
    return `El fichero no es un Norma 43 válido${line ? ` (línea ${line})` : ""}. ${translateWith(statementErrors, reason)}`;
  }
  const unreadable = /^Invalid statement file\. (.*)$/.exec(message);
  if (unreadable) return `No podemos leer el extracto. ${translateWith(tableErrors, unreadable[1])}`;
  const rows = /^The statement has (\d+) rows with errors$/.exec(message);
  if (rows) return `El extracto tiene ${rows[1]} ${rows[1] === "1" ? "fila" : "filas"} con errores. Corrígelas antes de importar.`;
  const unlinked = /^Statement account (.+) is not linked to an active bank account$/.exec(message);
  if (unlinked)
    return `La cuenta ${unlinked[1] === "without IBAN" ? "sin IBAN" : unlinked[1]} del extracto no está vinculada a ninguna cuenta bancaria activa. Créala con ese IBAN antes de importar.`;
  const currency = /^Statement currency (\S+) does not match bank account (.+)$/.exec(message);
  if (currency) return `La divisa ${currency[1]} del extracto no coincide con la de la cuenta ${currency[2]}.`;
  const translations: Record<string, string> = {
    "A statement file is required": "Selecciona un fichero de extracto.",
    "The statement upload is incomplete": "El fichero no se ha subido completo. Vuelve a intentarlo.",
    "The statement file differs from the previewed one": "El fichero ha cambiado desde la vista previa. Revísalo de nuevo.",
    "Bank transactions were imported concurrently; preview the statement again": "Se han importado movimientos a la vez desde otra sesión. Revisa de nuevo el extracto.",
    "A target bank account can only be chosen for a single-account statement": "Solo puedes elegir la cuenta de destino si el extracto tiene una única cuenta.",
    "The chosen bank account has a different IBAN than the statement": "La cuenta elegida tiene un IBAN distinto al del extracto.",
    "Active bank account not found": "No encontramos esa cuenta bancaria activa.",
    "File too large": "El fichero supera los 5 MB.",
  };
  return translations[message] ?? message;
}

export const bankAccountInputSchema = z.object({
  accountId: z.string().uuid(),
  name: z.string().trim().min(1).max(240),
  iban: z.string().trim().max(34).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/),
});

export const bankImportInputSchema = z.object({
  bankAccountId: z.string().uuid(),
  transactions: z
    .array(
      z.object({
        externalId: z.string().trim().min(1).max(240),
        bookingDate: z.string().date(),
        amount: z
          .number()
          .finite()
          .refine((amount) => amount !== 0),
        description: z.string().trim().min(1).max(1000),
        counterpartyName: z.string().trim().max(240).optional(),
        reference: z.string().trim().max(240).optional(),
      }),
    )
    .min(1)
    .max(500),
});

export const reconcileInputSchema = z.object({
  journalLineId: z.string().uuid(),
});

export function maskedIban(iban: string | null) {
  if (!iban) return "Sin IBAN";
  return `${iban.slice(0, 4)} ···· ${iban.slice(-4)}`;
}
