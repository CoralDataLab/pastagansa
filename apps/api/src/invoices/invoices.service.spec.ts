import { SifInvoiceType } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import {
  buildVatOnlyRectificationLine,
  calculateInvoiceLine,
  formatInvoiceNumber,
} from "./invoices.service";

describe("calculateInvoiceLine", () => {
  it("calculates and rounds persisted invoice amounts deterministically", () => {
    const result = calculateInvoiceLine(
      {
        description: "Professional service",
        quantity: 1.5,
        unitPrice: 100,
        discountPct: 10,
        taxRate: 21,
      },
      1,
    );
    expect(result.persisted.netAmount.toFixed(2)).toBe("135.00");
    expect(result.persisted.taxAmount.toFixed(2)).toBe("28.35");
    expect(result.persisted.totalAmount.toFixed(2)).toBe("163.35");
  });
});

describe("formatInvoiceNumber", () => {
  it("pads short numbers without truncating larger values", () => {
    expect(formatInvoiceNumber("F2026", 42n, 5)).toBe("F2026-00042");
    expect(formatInvoiceNumber("F2026", 123456n, 5)).toBe("F2026-123456");
  });
});

describe("buildVatOnlyRectificationLine", () => {
  function original() {
    return {
      sifInvoiceType: SifInvoiceType.F1,
      currency: "EUR",
      customerTaxId: "B12345674",
      fullNumber: "F2026-00001",
      amountPaid: new Decimal(0),
      amountDue: new Decimal(1210),
      total: new Decimal(1210),
      taxTotal: new Decimal(210),
      lines: [{
        netAmount: new Decimal(1000),
        taxAmount: new Decimal(210),
        totalAmount: new Decimal(1210),
        taxRate: new Decimal(21),
        taxLines: [{
          taxRuleId: "rule-21",
          taxCode: "VAT_21",
          taxableBase: new Decimal(1000),
          taxRate: new Decimal(21),
          taxAmount: new Decimal(210),
          surchargeRate: null,
          surchargeAmount: new Decimal(0),
          subject: true,
          exempt: false,
          exemptionReason: null,
          reverseCharge: false,
        }],
      }],
    };
  }

  it("derives the VAT-only difference from the original fiscal line", () => {
    const result = buildVatOnlyRectificationLine(original(), SifInvoiceType.R2);
    expect(result.persisted.netAmount.toFixed(2)).toBe("0.00");
    expect(result.persisted.taxAmount.toFixed(2)).toBe("210.00");
    expect(result.persisted.totalAmount.toFixed(2)).toBe("210.00");
    expect(result.tax.taxableBase.toFixed(2)).toBe("0.00");
    expect(result.tax.taxRuleId).toBe("rule-21");
    expect(result.persisted.description).toBe("Ajuste de cuota IVA por concurso de acreedores de F2026-00001");
    expect(buildVatOnlyRectificationLine(original(), SifInvoiceType.R3).persisted.description)
      .toBe("Ajuste de cuota IVA por crédito incobrable de F2026-00001");
  });

  it("rejects a partial payment rather than overstating recoverable VAT", () => {
    const paid = original();
    paid.amountPaid = new Decimal(100);
    paid.amountDue = new Decimal(1110);
    expect(() => buildVatOnlyRectificationLine(paid, SifInvoiceType.R3)).toThrow(
      "does not yet support paid or partially paid invoices",
    );
  });

  it("rejects an inconsistent VAT breakdown", () => {
    const inconsistent = original();
    inconsistent.lines[0].taxLines[0].taxAmount = new Decimal(209);
    expect(() => buildVatOnlyRectificationLine(inconsistent, SifInvoiceType.R3)).toThrow(
      "requires a consistent ordinary VAT breakdown",
    );
  });
});
