import { SifRecordType } from "@prisma/client";
import {
  formatSifIssueDate,
  hashSifCancellation,
  hashSifRegistration,
} from "./sif-hash-v1";

export type SifChainRecord = {
  id: string;
  invoiceId: string;
  recordType: SifRecordType;
  chainPosition: bigint;
  issuerTaxId: string;
  invoiceNumber: string;
  invoiceIssueDate: Date;
  invoiceType: string;
  taxTotal: { toFixed(decimalPlaces: number): string };
  total: { toFixed(decimalPlaces: number): string };
  generatedAt: Date;
  previousRecordId: string | null;
  previousRecordHash: string | null;
  recordHash: string;
  payload: unknown;
};

export type SifChainVerification = {
  valid: boolean;
  recordsChecked: number;
  firstInvalid: { id: string; chainPosition: string; reason: string } | null;
};

export function verifySifChain(
  records: readonly SifChainRecord[],
): SifChainVerification {
  let previous: SifChainRecord | undefined;
  for (const [index, record] of records.entries()) {
    const invalid = (reason: string): SifChainVerification => ({
      valid: false,
      recordsChecked: index + 1,
      firstInvalid: {
        id: record.id,
        chainPosition: record.chainPosition.toString(),
        reason,
      },
    });
    if (record.chainPosition !== BigInt(index + 1))
      return invalid("Unexpected chain position");
    if (record.previousRecordId !== (previous?.id ?? null))
      return invalid("Previous record reference does not match");
    if (record.previousRecordHash !== (previous?.recordHash ?? null))
      return invalid("Previous record hash does not match");

    if (record.recordType === SifRecordType.REGISTRATION) {
      const input = readRegistrationHashInput(record.payload);
      if (!input) return invalid("Stored registration hash input is invalid");
      if (
        input.issuerTaxId !== record.issuerTaxId ||
        input.invoiceNumber !== record.invoiceNumber ||
        input.issueDate !== formatSifIssueDate(record.invoiceIssueDate) ||
        input.invoiceType !== record.invoiceType ||
        input.taxTotal !== record.taxTotal.toFixed(2) ||
        input.total !== record.total.toFixed(2) ||
        input.previousHash !== (previous?.recordHash ?? "")
      )
        return invalid("Stored registration hash input does not match the record");
      if (hashSifRegistration(input) !== record.recordHash)
        return invalid("Registration hash does not match the stored hash input");
    } else if (record.recordType === SifRecordType.CANCELLATION) {
      const input = readCancellationHashInput(record.payload);
      const cancellationOf = readCancellationOf(record.payload);
      if (!input || !cancellationOf)
        return invalid("Stored cancellation hash input is invalid");
      const registration = records.slice(0, index).find(
        (candidate) => candidate.id === cancellationOf.registrationId,
      );
      if (
        !registration ||
        registration.recordType !== SifRecordType.REGISTRATION ||
        registration.invoiceId !== record.invoiceId ||
        registration.recordHash !== cancellationOf.registrationHash ||
        registration.issuerTaxId !== record.issuerTaxId ||
        registration.invoiceNumber !== record.invoiceNumber ||
        formatSifIssueDate(registration.invoiceIssueDate) !==
          formatSifIssueDate(record.invoiceIssueDate) ||
        registration.invoiceType !== record.invoiceType ||
        registration.taxTotal.toFixed(2) !== record.taxTotal.toFixed(2) ||
        registration.total.toFixed(2) !== record.total.toFixed(2)
      )
        return invalid("Cancellation does not identify its registration");
      if (
        input.issuerTaxId !== record.issuerTaxId ||
        input.invoiceNumber !== record.invoiceNumber ||
        input.issueDate !== formatSifIssueDate(record.invoiceIssueDate) ||
        input.previousHash !== (previous?.recordHash ?? "")
      )
        return invalid("Stored cancellation hash input does not match the record");
      if (hashSifCancellation(input) !== record.recordHash)
        return invalid("Cancellation hash does not match the stored hash input");
    } else return invalid("Unsupported SIF record type");
    previous = record;
  }
  return { valid: true, recordsChecked: records.length, firstInvalid: null };
}

function readRegistrationHashInput(value: unknown) {
  if (!isRecord(value) || !isRecord(value.hashInput)) return null;
  const input = value.hashInput;
  const fields = [
    "issuerTaxId",
    "invoiceNumber",
    "issueDate",
    "invoiceType",
    "taxTotal",
    "total",
    "previousHash",
    "generatedAt",
  ] as const;
  if (fields.some((field) => typeof input[field] !== "string")) return null;
  return {
    issuerTaxId: input.issuerTaxId as string,
    invoiceNumber: input.invoiceNumber as string,
    issueDate: input.issueDate as string,
    invoiceType: input.invoiceType as string,
    taxTotal: input.taxTotal as string,
    total: input.total as string,
    previousHash: input.previousHash as string,
    generatedAt: input.generatedAt as string,
  };
}

function readCancellationHashInput(value: unknown) {
  if (!isRecord(value) || !isRecord(value.hashInput)) return null;
  const input = value.hashInput;
  const fields = ["issuerTaxId", "invoiceNumber", "issueDate", "previousHash", "generatedAt"] as const;
  if (fields.some((field) => typeof input[field] !== "string")) return null;
  return {
    issuerTaxId: input.issuerTaxId as string,
    invoiceNumber: input.invoiceNumber as string,
    issueDate: input.issueDate as string,
    previousHash: input.previousHash as string,
    generatedAt: input.generatedAt as string,
  };
}

function readCancellationOf(value: unknown) {
  if (!isRecord(value) || !isRecord(value.cancellationOf)) return null;
  const cancellationOf = value.cancellationOf;
  if (
    typeof cancellationOf.registrationId !== "string" ||
    typeof cancellationOf.registrationHash !== "string"
  )
    return null;
  return {
    registrationId: cancellationOf.registrationId,
    registrationHash: cancellationOf.registrationHash,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
