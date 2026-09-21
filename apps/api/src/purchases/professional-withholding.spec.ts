import { Decimal } from "@prisma/client/runtime/library";
import { allocateProfessionalWithholding } from "./professional-withholding";

describe("professional withholding across partial payments", () => {
  it("allocates 200 base and 30 IRPF exactly to two net payments", () => {
    const first = allocateProfessionalWithholding({
      netPayment: new Decimal(100), netDue: new Decimal(212), netTotal: new Decimal(212),
      grossBase: new Decimal(200), totalWithholding: new Decimal(30),
      baseAlreadyReported: new Decimal(0), withholdingAlreadyReported: new Decimal(0),
    });
    const last = allocateProfessionalWithholding({
      netPayment: new Decimal(112), netDue: new Decimal(112), netTotal: new Decimal(212),
      grossBase: new Decimal(200), totalWithholding: new Decimal(30),
      baseAlreadyReported: first.withholdingBase,
      withholdingAlreadyReported: first.withholdingAmount,
    });
    expect(first.withholdingAmount.plus(last.withholdingAmount).toFixed(2)).toBe("30.00");
    expect(first.withholdingBase.plus(last.withholdingBase).toFixed(2)).toBe("200.00");
    expect(new Decimal(100).plus(112).plus(first.withholdingAmount).plus(last.withholdingAmount).toFixed(2)).toBe("242.00");
  });
});
