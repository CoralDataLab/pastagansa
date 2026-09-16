import { classifyBucket, daysBetween } from "./collections.service";
import { CollectionsService } from "./collections.service";
import { CollectionsQueryDto } from "./dto/collections-query.dto";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { Decimal } from "@prisma/client/runtime/library";

describe("collections aging", () => {
  const asOf = "2026-09-15";
  it.each([
    ["2026-09-22", "DUE_THIS_WEEK"],
    ["2026-09-23", null],
    ["2026-09-15", "DUE_THIS_WEEK"],
    ["2026-09-14", "OVERDUE_1_7"],
    ["2026-09-08", "OVERDUE_1_7"],
    ["2026-09-07", "OVERDUE_8_30"],
    ["2026-08-16", "OVERDUE_8_30"],
    ["2026-08-15", "OVERDUE_31_60"],
    ["2026-07-17", "OVERDUE_31_60"],
    ["2026-07-16", "OVERDUE_61_90"],
    ["2026-06-17", "OVERDUE_61_90"],
    ["2026-06-16", "OVERDUE_90_PLUS"],
  ])("classifies %s", (dueDate, expected) => {
    expect(classifyBucket(dueDate, asOf)).toBe(expected);
  });

  it("calculates calendar days across a daylight-saving boundary", () => {
    expect(daysBetween("2026-03-29", "2026-03-30")).toBe(1);
  });
});

describe("collections filtering", () => {
  const invoice = (id: string, dueDate: string, type?: string) => ({
    id, contactId: id, customerLegalName: id, fullNumber: id, draftCode: id,
    currency: "EUR", amountDue: new Decimal(10), dueDate: new Date(`${dueDate}T00:00:00Z`),
    installments: [], commercialEvents: type ? [{ type, source: "MANUAL", effectiveAt: new Date(), comment: null }] : [],
  });
  const records = [
    invoice("00000000-0000-4000-8000-000000000001", "2026-10-01"),
    invoice("00000000-0000-4000-8000-000000000002", "2026-09-14", "DISPUTED"),
    invoice("00000000-0000-4000-8000-000000000003", "2026-09-15", "DISPUTED"),
  ];
  const findMany = jest.fn(({ cursor, take }: { cursor?: { id: string }; take: number }) => {
    const start = cursor ? records.findIndex((item) => item.id === cursor.id) + 1 : 0;
    return records.slice(start, start + take);
  });
  const service = new CollectionsService({
    required: { organizationId: "11111111-1111-4111-8111-111111111111", companyId: "22222222-2222-4222-8222-222222222222" },
    db: { invoice: { findMany } },
  } as never, { record: jest.fn() } as never);

  it("scans beyond nonmatching rows before producing a filtered page", async () => {
    const query = { asOf: "2026-09-15", status: "DISPUTED" as const, limit: 1 };
    const first = await service.invoices(query);
    expect(first.data.map((row) => row.id)).toEqual([records[1].id]);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.invoices({ ...query, cursor: first.nextCursor! });
    expect(second.data.map((row) => row.id)).toEqual([records[2].id]);
    expect(second.nextCursor).toBeNull();
  });

  it("applies the operational filter to summary totals", async () => {
    const summary = await service.summary({ asOf: "2026-09-15", status: "DISPUTED" });
    expect(summary.count).toBe(2);
    expect(summary.total).toBe("20.00");
  });

  it("accepts a text filter up to 240 characters", async () => {
    expect(await validate(plainToInstance(CollectionsQueryDto, { text: "factura" }))).toHaveLength(0);
    expect(await validate(plainToInstance(CollectionsQueryDto, { text: "x".repeat(241) }))).not.toHaveLength(0);
  });
});
