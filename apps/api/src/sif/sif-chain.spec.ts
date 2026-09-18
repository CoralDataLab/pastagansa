import { SifRecordType } from "@prisma/client";
import { hashSifCancellation, hashSifRegistration } from "./sif-hash-v1";
import { type SifChainRecord, verifySifChain } from "./sif-chain";

const input = {
  issuerTaxId: "B12345674",
  invoiceNumber: "F2027-0001",
  issueDate: "01-01-2027",
  invoiceType: "F1",
  taxTotal: "21.00",
  total: "121.00",
  previousHash: "",
  generatedAt: "2027-01-01T12:00:00+01:00",
};

function record(overrides: Partial<SifChainRecord> = {}): SifChainRecord {
  return {
    id: "record-1",
    invoiceId: "invoice-1",
    recordType: SifRecordType.REGISTRATION,
    chainPosition: 1n,
    issuerTaxId: input.issuerTaxId,
    invoiceNumber: input.invoiceNumber,
    invoiceIssueDate: new Date("2027-01-01T00:00:00Z"),
    invoiceType: input.invoiceType,
    taxTotal: { toFixed: () => input.taxTotal },
    total: { toFixed: () => input.total },
    generatedAt: new Date("2027-01-01T11:00:00Z"),
    previousRecordId: null,
    previousRecordHash: null,
    recordHash: hashSifRegistration(input),
    payload: { hashInput: input },
    ...overrides,
  };
}

describe("SIF chain verification", () => {
  it("accepts a valid chain", () => {
    const first = record();
    const secondInput = {
      ...input,
      invoiceNumber: "F2027-0002",
      previousHash: first.recordHash,
      generatedAt: "2027-01-01T12:01:00+01:00",
    };
    const second = record({
      id: "record-2",
      chainPosition: 2n,
      invoiceNumber: secondInput.invoiceNumber,
      previousRecordId: first.id,
      previousRecordHash: first.recordHash,
      recordHash: hashSifRegistration(secondInput),
      payload: { hashInput: secondInput },
    });
    expect(verifySifChain([first, second])).toEqual({
      valid: true,
      recordsChecked: 2,
      firstInvalid: null,
    });
  });

  it("detects a changed or unlinked record", () => {
    const result = verifySifChain([
      record({ recordHash: "A".repeat(64) }),
    ]);
    expect(result.valid).toBe(false);
    expect(result.firstInvalid?.reason).toMatch(/hash/i);
  });

  it("accepts an append-only subsanation linked to its earlier alta", () => {
    const original = record();
    const correctedInput = {
      ...input, previousHash: original.recordHash,
      generatedAt: "2027-01-01T12:01:00+01:00",
    };
    const correction = record({
      id: "record-2", recordType: SifRecordType.SUBSANATION,
      chainPosition: 2n, previousRecordId: original.id,
      previousRecordHash: original.recordHash,
      recordHash: hashSifRegistration(correctedInput),
      payload: {
        hashInput: correctedInput,
        subsanationOf: { recordId: original.id, recordHash: original.recordHash },
      },
    });
    expect(verifySifChain([original, correction]).valid).toBe(true);
    const tampered = record({
      ...correction,
      payload: { hashInput: correctedInput, subsanationOf: { recordId: original.id, recordHash: "A".repeat(64) } },
    });
    expect(verifySifChain([original, tampered]).firstInvalid?.reason)
      .toMatch(/source registration/i);
  });

  it("accepts a cancellation linked to an earlier registration", () => {
    const registration = record();
    const cancellationInput = {
      issuerTaxId: input.issuerTaxId,
      invoiceNumber: input.invoiceNumber,
      issueDate: input.issueDate,
      previousHash: registration.recordHash,
      generatedAt: "2027-01-01T12:01:00+01:00",
    };
    const cancellation = record({
      id: "record-2",
      recordType: SifRecordType.CANCELLATION,
      chainPosition: 2n,
      previousRecordId: registration.id,
      previousRecordHash: registration.recordHash,
      recordHash: hashSifCancellation(cancellationInput),
      payload: {
        hashInput: cancellationInput,
        cancellationOf: {
          registrationId: registration.id,
          registrationHash: registration.recordHash,
        },
      },
    });
    expect(verifySifChain([registration, cancellation])).toEqual({
      valid: true,
      recordsChecked: 2,
      firstInvalid: null,
    });
  });

  it("rejects a cancellation that does not identify its registration", () => {
    const registration = record();
    const cancellationInput = {
      issuerTaxId: input.issuerTaxId,
      invoiceNumber: input.invoiceNumber,
      issueDate: input.issueDate,
      previousHash: registration.recordHash,
      generatedAt: "2027-01-01T12:01:00+01:00",
    };
    const cancellation = record({
      id: "record-2",
      recordType: SifRecordType.CANCELLATION,
      chainPosition: 2n,
      previousRecordId: registration.id,
      previousRecordHash: registration.recordHash,
      recordHash: hashSifCancellation(cancellationInput),
      payload: {
        hashInput: cancellationInput,
        cancellationOf: {
          registrationId: "different-registration",
          registrationHash: registration.recordHash,
        },
      },
    });
    const result = verifySifChain([registration, cancellation]);
    expect(result.valid).toBe(false);
    expect(result.firstInvalid?.reason).toMatch(/does not identify/i);
  });
});
