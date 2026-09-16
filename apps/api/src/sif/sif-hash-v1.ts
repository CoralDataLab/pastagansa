import { createHash } from "node:crypto";

export const SIF_HASH_SPECIFICATION_VERSION = "AEAT-HASH-0.1.2";

export interface SifRegistrationHashInput {
  issuerTaxId: string;
  invoiceNumber: string;
  issueDate: string;
  invoiceType: string;
  taxTotal: string;
  total: string;
  previousHash?: string | null;
  generatedAt: string;
}

/** Fields prescribed by AEAT for a RegistroAnulacion hash. */
export interface SifCancellationHashInput {
  issuerTaxId: string;
  invoiceNumber: string;
  issueDate: string;
  previousHash?: string | null;
  generatedAt: string;
}

export function canonicalRegistrationHashInput(
  input: SifRegistrationHashInput,
) {
  return [
    ["IDEmisorFactura", input.issuerTaxId],
    ["NumSerieFactura", input.invoiceNumber],
    ["FechaExpedicionFactura", input.issueDate],
    ["TipoFactura", input.invoiceType],
    ["CuotaTotal", input.taxTotal],
    ["ImporteTotal", input.total],
    ["Huella", input.previousHash ?? ""],
    ["FechaHoraHusoGenRegistro", input.generatedAt],
  ]
    .map(([name, value]) => `${name}=${value.trim()}`)
    .join("&");
}

export function hashSifRegistration(input: SifRegistrationHashInput) {
  return createHash("sha256")
    .update(canonicalRegistrationHashInput(input), "utf8")
    .digest("hex")
    .toUpperCase();
}

export function canonicalCancellationHashInput(input: SifCancellationHashInput) {
  return [
    ["IDEmisorFacturaAnulada", input.issuerTaxId],
    ["NumSerieFacturaAnulada", input.invoiceNumber],
    ["FechaExpedicionFacturaAnulada", input.issueDate],
    ["Huella", input.previousHash ?? ""],
    ["FechaHoraHusoGenRegistro", input.generatedAt],
  ]
    .map(([name, value]) => `${name}=${value.trim()}`)
    .join("&");
}

export function hashSifCancellation(input: SifCancellationHashInput) {
  return createHash("sha256")
    .update(canonicalCancellationHashInput(input), "utf8")
    .digest("hex")
    .toUpperCase();
}

export function formatSifIssueDate(date: Date) {
  return `${String(date.getUTCDate()).padStart(2, "0")}-${String(
    date.getUTCMonth() + 1,
  ).padStart(2, "0")}-${date.getUTCFullYear()}`;
}

export function formatSifTimestamp(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  const offset = value("timeZoneName");
  if (!offset?.startsWith("GMT"))
    throw new Error(`Cannot resolve timezone offset for ${timeZone}`);
  return `${value("year")}-${value("month")}-${value("day")}T${value(
    "hour",
  )}:${value("minute")}:${value("second")}${
    offset === "GMT" ? "+00:00" : offset.slice(3)
  }`;
}
