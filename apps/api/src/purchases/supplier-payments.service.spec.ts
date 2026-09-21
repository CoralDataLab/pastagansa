import { Decimal } from "@prisma/client/runtime/library";
import { SupplierPaymentsService } from "./supplier-payments.service";

describe("supplier withholding report", () => {
  it("groups paid retentions by payment quarter and recipient within the tenant", async () => {
    const organizationId = "11111111-1111-4111-8111-111111111111";
    const companyId = "22222222-2222-4222-8222-222222222222";
    const findMany = jest.fn().mockResolvedValue([
      { id: "p1", paidAt: new Date("2026-03-31T12:00:00Z"), withholdingBase: new Decimal(200), withholdingAmount: new Decimal(30), purchaseInvoice: { supplierTaxId: "12345678Z", supplierLegalName: "Profesional", supplierInvoiceNumber: "P-1", withholdingRate: new Decimal(15) } },
      { id: "p2", paidAt: new Date("2026-04-01T12:00:00Z"), withholdingBase: new Decimal(100), withholdingAmount: new Decimal(15), purchaseInvoice: { supplierTaxId: "12345678Z", supplierLegalName: "Profesional", supplierInvoiceNumber: "P-2", withholdingRate: new Decimal(15) } },
    ]);
    const service = new SupplierPaymentsService({
      required: { organizationId, companyId },
      db: { supplierPayment: { findMany } },
    } as never, {} as never, {} as never);
    const summary = await service.withholdingSummary(2026);
    expect(summary.quarters[0]).toMatchObject({ quarter: 1, payments: 1, base: "200.00", withheld: "30.00" });
    expect(summary.quarters[1]).toMatchObject({ quarter: 2, payments: 1, base: "100.00", withheld: "15.00" });
    expect(summary.annualBySupplier[0]).toMatchObject({ payments: 2, base: "300.00", withheld: "45.00" });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ organizationId, companyId, withholdingAmount: { gt: 0 } }) }));
  });
});
