import { spanishIbanFromParts } from "../common/iban";
import { movementIdentifier, StatementMovement } from "./statement";

/**
 * Parser for AEB "Cuaderno 43" (Norma 43) bank statements: fixed 80-character
 * records 11 (account header), 22 (movement), 23 (concept lines), 24 (currency
 * equivalence), 33 (account totals) and 88 (end of file).
 */

export const MAX_NORMA43_BYTES = 5 * 1024 * 1024;
export const MAX_NORMA43_MOVEMENTS = 10_000;

const RECORD_LENGTH = 80;
const CURRENCIES: Record<string, string> = {
  "978": "EUR",
  "840": "USD",
  "826": "GBP",
  "756": "CHF",
};
const COMMON_CONCEPTS: Record<string, string> = {
  "01": "Talones - reintegros",
  "02": "Abonarés - entregas - ingresos",
  "03": "Domiciliados - recibos - letras - pagos por su cuenta",
  "04": "Giros - transferencias - traspasos - cheques",
  "05": "Amortizaciones de préstamos y créditos",
  "06": "Remesas de efectos",
  "07": "Suscripciones - dividendos pasivos - canjes",
  "08": "Dividendos - cupones - primas de junta - amortizaciones",
  "09": "Operaciones de bolsa y compraventa de valores",
  "10": "Cheques gasolina",
  "11": "Cajero automático",
  "12": "Tarjetas de crédito - tarjetas de débito",
  "13": "Operaciones con el extranjero",
  "14": "Devoluciones e impagados",
  "15": "Nóminas - seguros sociales",
  "16": "Timbres - corretaje - póliza",
  "17": "Intereses - comisiones - custodia - gastos e impuestos",
  "98": "Anulaciones - correcciones de asiento",
  "99": "Varios",
};

export class Norma43FormatError extends Error {
  constructor(message: string, readonly line?: number) {
    super(line ? `Line ${line}: ${message}` : message);
  }
}

export type Norma43Movement = StatementMovement & { valueDate: string };

export type Norma43Account = {
  bankCode: string;
  branchCode: string;
  accountNumber: string;
  iban: string | null;
  holderName: string;
  currency: string;
  startDate: string;
  endDate: string;
  openingBalanceCents: number;
  closingBalanceCents: number;
  movements: Norma43Movement[];
};

type ParsedMovement = Omit<Norma43Movement, "externalId" | "description"> & {
  debit: boolean;
  key: string;
  commonConcept: string;
  concepts: string[];
};
type ParsedAccount = Omit<Norma43Account, "movements"> & {
  movements: ParsedMovement[];
};

export function parseNorma43(content: Buffer): Norma43Account[] {
  const accounts: Norma43Account[] = [];
  const identify = movementIdentifier("n43");
  let account: ParsedAccount | undefined;
  let movement: ParsedMovement | undefined;
  let movementCount = 0;
  let recordCount = 0;
  let ended = false;
  for (const { text, line } of records(decode(content))) {
    if (ended)
      throw new Norma43FormatError("Records found after the end-of-file record 88", line);
    const code = text.slice(0, 2);
    if (code === "11") {
      if (account)
        throw new Norma43FormatError("Account header 11 found before record 33 closed the previous account", line);
      account = parseHeader(text, line);
      movement = undefined;
    } else if (code === "22") {
      if (!account)
        throw new Norma43FormatError("Movement 22 found outside an account block", line);
      if (++movementCount > MAX_NORMA43_MOVEMENTS)
        throw new Norma43FormatError(`The file exceeds ${MAX_NORMA43_MOVEMENTS} movements`, line);
      movement = parseMovement(text, line, account);
      account.movements.push(movement);
    } else if (code === "23") {
      if (!movement)
        throw new Norma43FormatError("Concept record 23 found without a movement 22", line);
      if (movement.concepts.length === 5)
        throw new Norma43FormatError("A movement has more than five concept records 23", line);
      const concept = [text.slice(4, 42).trim(), text.slice(42, 80).trim()]
        .filter(Boolean)
        .join(" ");
      if (concept) movement.concepts.push(concept);
    } else if (code === "24") {
      // Currency equivalence is informative and has no accounting effect.
      if (!movement)
        throw new Norma43FormatError("Equivalence record 24 found without a movement 22", line);
    } else if (code === "33") {
      if (!account)
        throw new Norma43FormatError("Account totals 33 found outside an account block", line);
      accounts.push(closeAccount(account, text, line, identify));
      account = undefined;
      movement = undefined;
    } else if (code === "88") {
      if (account)
        throw new Norma43FormatError("End-of-file record 88 found before record 33 closed the account", line);
      const declared = numeric(text, 20, 26, "record count", line);
      // Banks disagree on whether the count includes record 88 itself.
      if (Math.abs(declared - recordCount) > 1)
        throw new Norma43FormatError(`Record 88 declares ${declared} records but the file has ${recordCount}`, line);
      ended = true;
      continue;
    } else {
      throw new Norma43FormatError(`Unknown record type "${code}"`, line);
    }
    recordCount += 1;
  }
  if (account)
    throw new Norma43FormatError("The file ends before record 33 closed the last account");
  if (!accounts.length)
    throw new Norma43FormatError("The file contains no account blocks");
  return accounts;
}

function decode(content: Buffer) {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    // Spanish banks usually export ISO-8859-1.
    text = content.toString("latin1");
  }
  // A DOS end-of-file marker (Ctrl-Z) ends the content.
  return text.replace(/^﻿/, "").split(String.fromCharCode(26))[0];
}

function* records(text: string) {
  const lines =
    !/[\r\n]/.test(text) && text.length > RECORD_LENGTH && text.length % RECORD_LENGTH === 0
      ? text.match(new RegExp(`.{${RECORD_LENGTH}}`, "g")) ?? []
      : text.split(/\r\n|\n|\r/);
  for (const [index, raw] of lines.entries()) {
    if (!raw.trim()) continue;
    if (raw.length > RECORD_LENGTH && raw.slice(RECORD_LENGTH).trim())
      throw new Norma43FormatError(`Record is longer than ${RECORD_LENGTH} characters`, index + 1);
    yield { text: raw.slice(0, RECORD_LENGTH).padEnd(RECORD_LENGTH), line: index + 1 };
  }
}

function parseHeader(text: string, line: number): ParsedAccount {
  const bankCode = digits(text, 2, 6, "bank code", line);
  const branchCode = digits(text, 6, 10, "branch code", line);
  const accountNumber = digits(text, 10, 20, "account number", line);
  const startDate = date(text, 20, 26, "start date", line);
  const endDate = date(text, 26, 32, "end date", line);
  if (endDate < startDate)
    throw new Norma43FormatError("The statement end date is before its start date", line);
  return {
    bankCode,
    branchCode,
    accountNumber,
    iban: spanishIbanFromParts(bankCode, branchCode, accountNumber),
    holderName: text.slice(51, 77).trim(),
    currency: currency(text.slice(47, 50), line),
    startDate,
    endDate,
    openingBalanceCents: sign(text, 32, "opening balance", line) * numeric(text, 33, 47, "opening balance", line),
    closingBalanceCents: 0,
    movements: [],
  };
}

function parseMovement(text: string, line: number, account: ParsedAccount): ParsedMovement {
  const debit = sign(text, 27, "movement amount", line) < 0;
  const amountCents = (debit ? -1 : 1) * numeric(text, 28, 42, "movement amount", line);
  const operationDate = date(text, 10, 16, "operation date", line);
  const valueDate = date(text, 16, 22, "value date", line);
  const commonConcept = text.slice(22, 24);
  const references = [text.slice(52, 64).trim(), text.slice(64, 80).trim()];
  const key = [
    account.bankCode,
    account.branchCode,
    account.accountNumber,
    operationDate,
    valueDate,
    amountCents,
    commonConcept,
    text.slice(24, 27),
    text.slice(6, 10),
    text.slice(42, 52).trim(),
    ...references,
  ].join("|");
  return {
    debit,
    key,
    commonConcept,
    concepts: [],
    operationDate,
    valueDate,
    amountCents,
    reference: references.filter((value) => value && !/^0+$/.test(value)).join(" · ") || null,
  };
}

function closeAccount(
  account: ParsedAccount,
  text: string,
  line: number,
  identify: (key: string) => string,
): Norma43Account {
  if (
    text.slice(2, 6) !== account.bankCode ||
    text.slice(6, 10) !== account.branchCode ||
    text.slice(10, 20) !== account.accountNumber
  )
    throw new Norma43FormatError("Account totals 33 do not match the account header 11", line);
  const debits = account.movements.filter(({ debit }) => debit);
  const credits = account.movements.filter(({ debit }) => !debit);
  const debitTotal = -debits.reduce((total, { amountCents }) => total + amountCents, 0);
  const creditTotal = credits.reduce((total, { amountCents }) => total + amountCents, 0);
  if (numeric(text, 20, 25, "debit count", line) !== debits.length)
    throw new Norma43FormatError("The number of debits does not match record 33", line);
  if (numeric(text, 25, 39, "debit total", line) !== debitTotal)
    throw new Norma43FormatError("The debit total does not match record 33", line);
  if (numeric(text, 39, 44, "credit count", line) !== credits.length)
    throw new Norma43FormatError("The number of credits does not match record 33", line);
  if (numeric(text, 44, 58, "credit total", line) !== creditTotal)
    throw new Norma43FormatError("The credit total does not match record 33", line);
  const closingBalanceCents =
    sign(text, 58, "closing balance", line) * numeric(text, 59, 73, "closing balance", line);
  // Some banks leave a balance empty; only compare when both are informed.
  if (
    account.openingBalanceCents !== 0 &&
    closingBalanceCents !== 0 &&
    account.openingBalanceCents + creditTotal - debitTotal !== closingBalanceCents
  )
    throw new Norma43FormatError("Opening balance plus movements does not equal the closing balance", line);
  if (text.slice(73, 76).trim() && currency(text.slice(73, 76), line) !== account.currency)
    throw new Norma43FormatError("The currency in record 33 does not match the account header 11", line);
  return {
    ...account,
    closingBalanceCents,
    movements: account.movements.map((movement) => ({
      externalId: identify(movement.key),
      operationDate: movement.operationDate,
      valueDate: movement.valueDate,
      amountCents: movement.amountCents,
      description: description(movement),
      reference: movement.reference,
    })),
  };
}

function description(movement: ParsedMovement) {
  const text =
    movement.concepts.join(" ") ||
    [COMMON_CONCEPTS[movement.commonConcept] ?? "Movimiento bancario", movement.reference]
      .filter(Boolean)
      .join(" · ");
  return text.replace(/\s+/g, " ").slice(0, 1000);
}

function digits(text: string, start: number, end: number, field: string, line: number) {
  const value = text.slice(start, end);
  if (!/^\d+$/.test(value))
    throw new Norma43FormatError(`The ${field} must be numeric`, line);
  return value;
}

function numeric(text: string, start: number, end: number, field: string, line: number) {
  return Number(digits(text, start, end, field, line));
}

function date(text: string, start: number, end: number, field: string, line: number) {
  const value = digits(text, start, end, field, line);
  const iso = `20${value.slice(0, 2)}-${value.slice(2, 4)}-${value.slice(4, 6)}`;
  const parsed = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso)
    throw new Norma43FormatError(`The ${field} is not a valid YYMMDD date`, line);
  return iso;
}

function sign(text: string, index: number, field: string, line: number) {
  const key = text[index];
  if (key === "1") return -1;
  if (key === "2") return 1;
  throw new Norma43FormatError(`The debit/credit key of the ${field} must be 1 or 2`, line);
}

function currency(code: string, line: number) {
  const value = CURRENCIES[code];
  if (!value) throw new Norma43FormatError(`Unsupported currency code "${code}"`, line);
  return value;
}
