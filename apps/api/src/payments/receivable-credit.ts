import { ConflictException } from "@nestjs/common";
import { Decimal } from "@prisma/client/runtime/library";

export interface CreditInstallment {
  id: string;
  dueDate: Date;
  position: number;
  amount: Decimal;
  paidAmount: Decimal;
  creditedAmount: Decimal;
}

export function installmentOpenAmount(
  installment: Pick<CreditInstallment, "amount" | "paidAmount" | "creditedAmount">,
) {
  return installment.amount
    .minus(installment.paidAmount)
    .minus(installment.creditedAmount);
}

export function planReceivableCredit(
  installments: CreditInstallment[],
  amountDue: Decimal,
  credit: Decimal,
): Array<{ id: string; amount: Decimal }> {
  const open = installments.reduce(
    (sum, item) => sum.plus(installmentOpenAmount(item)),
    new Decimal(0),
  );
  if (installments.some((item) => installmentOpenAmount(item).lessThan(0)) ||
    !open.equals(amountDue))
    throw new ConflictException(
      "Invoice balance and installment balances disagree; review before applying credit",
    );
  if (!credit.greaterThan(0) || credit.greaterThan(amountDue))
    throw new ConflictException(
      "Credit exceeds the unpaid receivable; refund handling requires review",
    );
  let remaining = credit;
  const allocations: Array<{ id: string; amount: Decimal }> = [];
  for (const item of [...installments].sort((a, b) =>
    b.dueDate.getTime() - a.dueDate.getTime() || b.position - a.position)) {
    if (remaining.isZero()) break;
    const applied = Decimal.min(installmentOpenAmount(item), remaining);
    if (applied.greaterThan(0)) {
      allocations.push({ id: item.id, amount: applied });
      remaining = remaining.minus(applied);
    }
  }
  if (!remaining.isZero())
    throw new ConflictException("Installments cannot absorb the receivable credit");
  return allocations;
}
