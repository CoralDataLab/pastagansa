import { Decimal } from "@prisma/client/runtime/library";

/** Split each net supplier payment into its gross base and withheld IRPF. */
export function allocateProfessionalWithholding(input: {
  netPayment: Decimal;
  netDue: Decimal;
  netTotal: Decimal;
  grossBase: Decimal;
  totalWithholding: Decimal;
  baseAlreadyReported: Decimal;
  withholdingAlreadyReported: Decimal;
}) {
  const finalPayment = input.netPayment.equals(input.netDue);
  return {
    withholdingAmount: finalPayment
      ? input.totalWithholding.minus(input.withholdingAlreadyReported)
      : input.netPayment.mul(input.totalWithholding).div(input.netTotal).toDecimalPlaces(2),
    withholdingBase: finalPayment
      ? input.grossBase.minus(input.baseAlreadyReported)
      : input.netPayment.mul(input.grossBase).div(input.netTotal).toDecimalPlaces(2),
  };
}
