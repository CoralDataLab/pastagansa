import { describe, expect, it } from "vitest";
import {
  formatInvoiceDate,
  invoiceEmailInputSchema,
  invoiceEmailKey,
  invoiceInputSchema,
  invoiceIssueKey,
  invoiceStatusLabel,
  paymentInputSchema,
  paymentKey,
  paymentMethodLabel,
  rectificationInputSchema,
  sifInvoiceTypeLabel,
  todayIso,
} from "./invoices";

const valid = {
  contactId: "0198f8c0-60d6-74a4-9247-bd28e31502ef",
  issueDate: "2026-09-09",
  dueDate: "",
  currency: "EUR" as const,
  notes: "Gracias",
  lines: [
    { description: "Consultoría", quantity: 2, unitPrice: 50, taxRate: 21 },
  ],
};

describe("invoice input", () => {
  it("accepts a usable draft", () => {
    expect(invoiceInputSchema.safeParse(valid).success).toBe(true);
  });

  it("requires at least one valid line", () => {
    expect(invoiceInputSchema.safeParse({ ...valid, lines: [] }).success).toBe(
      false,
    );
    expect(
      invoiceInputSchema.safeParse({
        ...valid,
        lines: [{ ...valid.lines[0], taxRate: 7 }],
      }).success,
    ).toBe(false);
  });
});

describe("invoice presentation", () => {
  it("uses local calendar dates for defaults", () => {
    expect(todayIso(new Date(2026, 8, 9, 23, 30))).toBe("2026-09-09");
  });

  it("translates statuses and formats API dates", () => {
    expect(invoiceStatusLabel("DRAFT")).toBe("Borrador");
    expect(formatInvoiceDate("2026-09-09T00:00:00.000Z")).toBe("9/9/2026");
  });

  it("preserves an issuance key across a retry", () => {
    expect(invoiceIssueKey("invoice-1", "saved-key")).toBe("saved-key");
  });

  it("validates email delivery and preserves its retry key", () => {
    expect(
      invoiceEmailInputSchema.safeParse({
        recipient: "billing@example.com",
        subject: "Factura F-001",
      }).success,
    ).toBe(true);
    expect(
      invoiceEmailInputSchema.safeParse({
        recipient: "not-an-email",
        subject: "Factura F-001",
      }).success,
    ).toBe(false);
    expect(invoiceEmailKey("invoice-1", "saved-email-key")).toBe(
      "saved-email-key",
    );
  });

  it("validates and presents payments", () => {
    expect(
      paymentInputSchema.safeParse({
        amount: 121,
        paidAt: "2026-09-09",
        method: "BANK_TRANSFER",
      }).success,
    ).toBe(true);
    expect(paymentMethodLabel("BANK_TRANSFER")).toBe("Transferencia");
    expect(paymentKey("invoice-1", "saved-payment-key")).toBe(
      "saved-payment-key",
    );
  });

  it("validates the supported AEAT rectification classes", () => {
    const input = {
      sifInvoiceType: "R1",
      reason: "Devolución de mercancía",
      issueDate: "2026-09-14",
    };
    expect(rectificationInputSchema.safeParse(input).success).toBe(true);
    expect(
      rectificationInputSchema.safeParse({ ...input, sifInvoiceType: "R5" })
        .success,
    ).toBe(false);
    expect(
      rectificationInputSchema.safeParse({ ...input, sifInvoiceType: "R3" })
        .success,
    ).toBe(false);
    expect(sifInvoiceTypeLabel("R3")).toBe("Crédito incobrable");
  });
});
