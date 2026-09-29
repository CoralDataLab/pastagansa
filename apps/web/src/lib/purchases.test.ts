import { describe, expect, it } from "vitest";
import { purchaseInputSchema, purchaseStatusLabel } from "./purchases";

describe("purchase helpers", () => {
  it("accepts a valid deductible purchase line", () => {
    expect(
      purchaseInputSchema.safeParse({
        supplierId: "98a6dca2-21c9-4e94-8b1a-5a078220ad36",
        supplierInvoiceNumber: "PROV-42",
        issueDate: "2026-09-09",
        receivedDate: "2026-09-09",
        currency: "EUR",
        lines: [
          {
            description: "Asesoría",
            quantity: 1,
            unitPrice: 100,
            discountPct: 0,
            taxRate: 21,
            deductiblePct: 100,
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects an invalid deduction percentage", () => {
    const result = purchaseInputSchema.safeParse({
      supplierId: "98a6dca2-21c9-4e94-8b1a-5a078220ad36",
      supplierInvoiceNumber: "PROV-42",
      issueDate: "2026-09-09",
      receivedDate: "2026-09-09",
      currency: "EUR",
      lines: [
        {
          description: "Asesoría",
          quantity: 1,
          unitPrice: 100,
          discountPct: 0,
          taxRate: 21,
          deductiblePct: 101,
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("accepts only explicitly marked non-subject disbursements", () => {
    const input = {
      supplierId: "98a6dca2-21c9-4e94-8b1a-5a078220ad36",
      supplierInvoiceNumber: "PROV-43",
      issueDate: "2026-09-09", receivedDate: "2026-09-09", currency: "EUR",
      lines: [{ description: "Suplido", quantity: 1, unitPrice: 7.8, discountPct: 0,
        taxRate: 0, deductiblePct: 0, isDisbursement: true }],
    };
    expect(purchaseInputSchema.safeParse(input).success).toBe(true);
    expect(purchaseInputSchema.safeParse({ ...input, lines: [{ ...input.lines[0], isDisbursement: false }] }).success).toBe(false);
    expect(purchaseInputSchema.safeParse({ ...input, lines: [{ ...input.lines[0], taxRate: 21 }] }).success).toBe(false);
  });

  it("accepts an EU service reverse-charge purchase with supplier total excluding VAT", () => {
    const input = {
      supplierId: "98a6dca2-21c9-4e94-8b1a-5a078220ad36", supplierInvoiceNumber: "AA/01851",
      issueDate: "2026-09-28", receivedDate: "2026-09-28", currency: "EUR",
      lines: [{ description: "Suscripción", quantity: 1, unitPrice: 90, discountPct: 0,
        taxRate: 21, deductiblePct: 100, isEuServiceReverseCharge: true, expenseAccountCode: "629000" }],
    };
    expect(purchaseInputSchema.safeParse(input).success).toBe(true);
    expect(purchaseInputSchema.safeParse({ ...input, lines: [{ ...input.lines[0], taxRate: 10 }] }).success).toBe(false);
  });

  it("labels the approval states", () => {
    expect(purchaseStatusLabel("PENDING_APPROVAL")).toBe(
      "Pendiente de aprobación",
    );
  });
});
