import { describe, expect, it } from "vitest";
import { accountingDescription, journalMoneyCents, journalSourceLabel, manualEntrySchema } from "./accounting";

describe("accounting presentation", () => {
  it("parses Spanish and dot-decimal amounts without guessing thousands", () => {
    expect(journalMoneyCents("367,79")).toBe(36779);
    expect(journalMoneyCents("367.79")).toBe(36779);
    expect(journalMoneyCents("367,79 €")).toBe(36779);
    expect(journalMoneyCents("")).toBe(0);
    expect(journalMoneyCents("1.234,56")).toBeNull();
    expect(journalMoneyCents("367,799")).toBeNull();
    expect(journalMoneyCents("-367,79")).toBeNull();
  });

  it("accepts a balanced shareholder contribution and rejects an imbalanced entry", () => {
    const entry = {
      entryDate: "2026-09-14", description: "Aportación no reintegrable · extracto",
      lines: [
        { accountId: "98a6dca2-21c9-4e94-8b1a-5a078220ad36", debit: 250, credit: 0 },
        { accountId: "a69ac150-c0e7-4336-858c-3b56f6b914c6", debit: 0, credit: 250 },
      ],
    };
    expect(manualEntrySchema.safeParse(entry).success).toBe(true);
    expect(manualEntrySchema.safeParse({ ...entry, lines: [{ ...entry.lines[0], debit: 249.99 }, entry.lines[1]] }).success).toBe(false);
    expect(manualEntrySchema.safeParse({ ...entry, lines: [{ ...entry.lines[0], credit: 1 }, entry.lines[1]] }).success).toBe(false);
    expect(manualEntrySchema.safeParse({ ...entry, lines: [{ ...entry.lines[0], debit: 250.001 }, entry.lines[1]] }).success).toBe(false);
  });

  it("translates journal source types", () => {
    expect(journalSourceLabel("PAYMENT")).toBe("Cobro");
    expect(journalSourceLabel("PURCHASE_INVOICE")).toBe("Compra");
  });

  it("translates persisted descriptions without changing their reference", () => {
    expect(accountingDescription("Sales invoice F2026-0001")).toBe(
      "Factura de venta F2026-0001",
    );
    expect(accountingDescription("Purchase invoice 1")).toBe(
      "Factura de compra 1",
    );
    expect(accountingDescription("Customer receipt F2026-0001")).toBe(
      "Cobro de cliente F2026-0001",
    );
  });
});
