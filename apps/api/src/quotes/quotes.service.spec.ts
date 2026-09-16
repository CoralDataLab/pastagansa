import { calculateQuoteLine, QuotesService } from "./quotes.service";

describe("calculateQuoteLine", () => {
  it("persists only schema fields and rounds amounts deterministically", () => {
    const result = calculateQuoteLine(
      {
        description: "Service",
        quantity: 1.5,
        unitPrice: 100,
        discountPct: 10,
        taxRate: 21,
      },
      1,
    );
    expect(Object.keys(result.persisted)).not.toContain("gross");
    expect(result.persisted.netAmount.toFixed(2)).toBe("135.00");
    expect(result.persisted.taxAmount.toFixed(2)).toBe("28.35");
    expect(result.persisted.totalAmount.toFixed(2)).toBe("163.35");
  });
});

describe("quote delivery lock", () => {
  const findFirst = jest.fn().mockResolvedValue({ id: "delivery-1" });
  const updateMany = jest.fn();
  const service = new QuotesService({
    required: { organizationId: "11111111-1111-4111-8111-111111111111", companyId: "22222222-2222-4222-8222-222222222222" },
    db: { $queryRaw: jest.fn().mockResolvedValue([]), documentDelivery: { findFirst }, quote: { updateMany } },
  } as never, {} as never, {} as never, {} as never);

  it("does not edit a draft while its email is pending", async () => {
    Reflect.set(service, "build", jest.fn().mockResolvedValue({ document: {}, lines: [] }));
    await expect(service.update("33333333-3333-4333-8333-333333333333", {} as never)).rejects.toThrow(
      "Quote cannot be edited while an email delivery is pending",
    );
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("does not change status while its email is pending", async () => {
    await expect(service.changeStatus("33333333-3333-4333-8333-333333333333", "CANCELLED" as never, "DRAFT" as never)).rejects.toThrow(
      "Quote status cannot change while an email delivery is pending",
    );
    expect(updateMany).not.toHaveBeenCalled();
  });
});
