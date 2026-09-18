import { spawnSync } from "node:child_process";
import { InvoicePdfService } from "./invoice-pdf.service";

describe("InvoicePdfService", () => {
  it("renders a valid multipage invoice", async () => {
    const service = new InvoicePdfService();
    const pdf = await service.render({
      fullNumber: "F2026-00001",
      status: "ISSUED",
      issuerLegalName: "Empresa Ejemplo, S.L.",
      issuerTaxId: "B12345674",
      issuerSnapshot: {
        version: 1,
        source: "company_profile",
        legalName: "Empresa Ejemplo, S.L.",
        taxId: "B12345674",
        addressLine1: "Calle Ejemplo, 1",
        city: "Madrid",
        paymentInstructions: "Transferencia bancaria",
      },
      issuerLogoMediaType: null,
      issuerLogoContent: null,
      sifQr: { mode: "VERIFACTU", environment: "TEST" },
      customerLegalName: "Cliente Ejemplo, S.A.",
      customerTaxId: "A58818501",
      billingAddress: {
        line1: "Calle de Alcalá, 1",
        postalCode: "28014",
        city: "Madrid",
        country: "ES",
      },
      issueDate: new Date("2026-09-08"),
      operationDate: new Date("2026-09-07"),
      dueDate: new Date("2026-10-08"),
      currency: "EUR",
      notes: "Pago mediante transferencia bancaria.",
      subtotal: value("9000"),
      discountTotal: value("900"),
      taxTotal: value("1701"),
      total: value("9801"),
      lines: Array.from({ length: 60 }, (_, index) => ({
        position: index + 1,
        description: `Servicio profesional ${index + 1} con descripción detallada`,
        quantity: value("1.5"),
        unitPrice: value("100"),
        discountPct: value("10"),
        taxRate: value("21"),
        totalAmount: value("163.35"),
      })),
    });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(5_000);
    expect(pdf.toString("latin1").match(/\/Type \/Page\b/g)?.length).toBe(4);
    const boxes = spawnSync("pdftotext", ["-bbox", "-", "-"], { input: pdf });
    expect(boxes.status).toBe(0);
    const html = boxes.stdout.toString();
    const dueDateBottom = Number(html.match(/<word[^>]*yMax="([^"]+)"[^>]*>08\/10\/2026<\/word>/)?.[1]);
    const qrLabelTop = Number(html.match(/<word[^>]*yMin="([^"]+)"[^>]*>QR<\/word>/)?.[1]);
    expect(Number.isFinite(dueDateBottom)).toBe(true);
    expect(qrLabelTop).toBeGreaterThan(dueDateBottom + 8);
  });

  it("renders rectification metadata in a valid PDF", async () => {
    const service = new InvoicePdfService();
    const pdf = await service.render({
      fullNumber: "R2026-00001",
      status: "ISSUED",
      documentType: "CREDIT_NOTE",
      sifInvoiceType: "R1",
      rectificationKind: "PARTIAL",
      rectificationImpact: "DECREASE",
      rectificationReason: "Correction of the billed quantity",
      originalInvoice: { id: "original", fullNumber: "F2026-00001" },
      issuerLegalName: "Example Company",
      issuerTaxId: "B12345674",
      issuerSnapshot: {
        version: 1,
        source: "company_profile",
        legalName: "Example Company",
        taxId: "B12345674",
      },
      issuerLogoMediaType: null,
      issuerLogoContent: null,
      sifQr: { mode: "NO_VERIFACTU", environment: "TEST" },
      customerLegalName: "Example Customer",
      customerTaxId: null,
      billingAddress: null,
      issueDate: new Date("2026-09-09"),
      operationDate: new Date("2026-09-08"),
      dueDate: null,
      currency: "EUR",
      notes: null,
      subtotal: value("100"),
      discountTotal: value("0"),
      taxTotal: value("21"),
      total: value("121"),
      lines: [
        {
          position: 1,
          description: "Correction",
          quantity: value("1"),
          unitPrice: value("100"),
          discountPct: value("0"),
          taxRate: value("21"),
          totalAmount: value("121"),
        },
      ],
    });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(2_500);
    expect(pdf.toString("latin1").match(/\/Type \/Page\b/g)?.length).toBe(1);
    const extracted = spawnSync("pdftotext", ["-layout", "-", "-"], { input: pdf });
    expect(extracted.status).toBe(0);
    expect(extracted.stdout.toString()).toContain("Fecha de operación");
    expect(extracted.stdout.toString()).toContain("08/09/2026");
  });
});

function value(input: string) {
  return { toString: () => input };
}
