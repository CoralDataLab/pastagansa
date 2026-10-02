import { describe, expect, it } from "vitest";
import {
  createProposalSchema,
  executeProposalSchema,
  learningCandidateReviewSchema,
  payloadChanges,
  proposalPayloadSchema,
  rejectProposalSchema,
  setProposalPayloadPath,
  proposalStatusLabel,
} from "./purchase-proposals";
const payload = {
  supplierId: "11111111-1111-4111-8111-111111111111",
  supplierInvoiceNumber: "INV-42",
  issueDate: "2026-09-01",
  receivedDate: "2026-09-02",
  currency: "USD",
  operationDate: "2026-08-30",
  deductionDate: "2026-09-03",
  withholdingRate: 15,
  lines: [
    {
      description: "Consulting",
      quantity: 1,
      unitPrice: 100,
      taxRuleId: "22222222-2222-4222-8222-222222222222",
      catalogItemId: "33333333-3333-4333-8333-333333333333",
      exemptionReason: "Legal reference",
      deductiblePct: 50,
      expenseAccountCode: "623000" as const,
    },
  ],
};
describe("supervised purchase review", () => {
  it("validates proposal creation without accepting tenant or actor overrides", () => {
    const input = { commandId: "staging-test", payload, provenance: { channel: "FRONTEND" } };
    expect(createProposalSchema.parse(input).evidence).toEqual([]);
    for (const extra of [{ userId: "actor" }, { companyId: "company" }, { name: "arbitrary" }])
      expect(createProposalSchema.safeParse({ ...input, ...extra }).success).toBe(false);
  });
  it("preserves the complete API payload, including currencies and fiscal fields", () => {
    expect(proposalPayloadSchema.parse(payload)).toEqual(payload);
    const nullable = {
      ...payload,
      notes: null,
      operationDate: null,
      lines: [{ ...payload.lines[0], taxRuleId: null, discountPct: null }],
    };
    expect(proposalPayloadSchema.parse(nullable)).toEqual(nullable);
    expect(
      executeProposalSchema.parse({ reason: " Checked document ", payload }),
    ).toEqual({ reason: "Checked document", payload });
  });
  it("does not silently drop unknown fields or accept a selectable command/actor", () => {
    expect(
      proposalPayloadSchema.safeParse({ ...payload, newFiscalField: true })
        .success,
    ).toBe(false);
    expect(
      executeProposalSchema.safeParse({
        reason: "Reviewed",
        payload,
        userId: "someone",
      }).success,
    ).toBe(false);
    expect(
      executeProposalSchema.safeParse({
        reason: "Reviewed",
        payload: { ...payload, lines: [{ ...payload.lines[0], extra: true }] },
      }).success,
    ).toBe(false);
  });
  it("requires an explicit nonblank reason but permits rejecting an invalid edited payload", () => {
    for (const reason of ["", "   ", "x".repeat(1001)]) {
      expect(executeProposalSchema.safeParse({ reason, payload }).success).toBe(
        false,
      );
      expect(rejectProposalSchema.safeParse({ reason }).success).toBe(false);
    }
    expect(
      rejectProposalSchema.safeParse({ reason: "Duplicate" }).success,
    ).toBe(true);
  });
  it("rejects empty lines, invalid numbers, currencies and date strings", () => {
    for (const change of [
      { lines: [] },
      { currency: "ZZZ" },
      { issueDate: "tomorrow" },
      { lines: [{ ...payload.lines[0], quantity: NaN }] },
      { lines: [{ ...payload.lines[0], unitPrice: -1 }] },
      { lines: [{ ...payload.lines[0], deductiblePct: 101 }] },
    ])
      expect(
        proposalPayloadSchema.safeParse({ ...payload, ...change }).success,
      ).toBe(false);
  });
  it("diffs nested corrections, additions and deletions without modifying the original", () => {
    const before = structuredClone(payload);
    const after = {
      ...payload,
      notes: "Checked",
      operationDate: undefined,
      lines: [{ ...payload.lines[0], deductiblePct: 100 }],
    };
    expect(payloadChanges(before, after)).toEqual([
      { path: "lines.0.deductiblePct", before: 50, after: 100 },
      { path: "notes", before: undefined, after: "Checked" },
      { path: "operationDate", before: "2026-08-30", after: undefined },
    ]);
    expect(before).toEqual(payload);
    expect(payloadChanges(payload, structuredClone(payload))).toEqual([]);
  });
  it("copies governed learning hint values by path without mutating the original", () => {
    const updated = setProposalPayloadPath(payload, "lines.0.deductiblePct", 100);
    expect(updated.lines[0].deductiblePct).toBe(100);
    expect(payload.lines[0].deductiblePct).toBe(50);
    expect(setProposalPayloadPath(payload, "lines.9.description", "Nope")).toBe(payload);
  });
  it("requires explicit reasons for governed learning decisions", () => {
    expect(learningCandidateReviewSchema.parse({ reason: "  Useful supplier correction " })).toEqual({ reason: "Useful supplier correction" });
    for (const reason of ["", "   ", "x".repeat(1001)])
      expect(learningCandidateReviewSchema.safeParse({ reason }).success).toBe(false);
    expect(
      learningCandidateReviewSchema.safeParse({ reason: "Reviewed", applyAutomatically: true }).success,
    ).toBe(false);
  });
  it("does not describe execution as purchase approval", () => {
    expect(proposalStatusLabel("EXECUTED")).toBe("Borrador creado");
  });
});
