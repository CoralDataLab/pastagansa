import { Decimal } from "@prisma/client/runtime/library";
import { installmentOpenAmount, planReceivableCredit } from "./receivable-credit";

const money = (value: number) => new Decimal(value);
const schedule = () => [
  { id: "first", dueDate: new Date("2026-10-01"), position: 1,
    amount: money(60), paidAmount: money(20), creditedAmount: money(0) },
  { id: "last", dueDate: new Date("2026-11-01"), position: 2,
    amount: money(60), paidAmount: money(0), creditedAmount: money(0) },
];

describe("receivable credit allocation", () => {
  it("reduces the latest unpaid installments while preserving payments", () => {
    const allocations = planReceivableCredit(schedule(), money(100), money(70));
    expect(allocations.map(({ id, amount }) => [id, amount.toFixed(2)])).toEqual([
      ["last", "60.00"], ["first", "10.00"],
    ]);
    const [first, last] = schedule();
    first.creditedAmount = money(10);
    last.creditedAmount = money(60);
    expect(installmentOpenAmount(first).toFixed(2)).toBe("30.00");
    expect(installmentOpenAmount(last).toFixed(2)).toBe("0.00");
  });

  it("rejects a refund sized credit and an inconsistent schedule", () => {
    expect(() => planReceivableCredit(schedule(), money(100), money(101)))
      .toThrow("refund handling requires review");
    expect(() => planReceivableCredit(schedule(), money(99), money(20)))
      .toThrow("Invoice balance and installment balances disagree");
  });
});
