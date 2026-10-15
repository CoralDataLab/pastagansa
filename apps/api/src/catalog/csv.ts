import { BadRequestException } from "@nestjs/common";
import { CatalogItemType } from "@prisma/client";
import { parseCsv } from "../common/csv";

const CURRENCIES = new Set(Intl.supportedValuesOf("currency"));

export interface ImportedCatalogItemRow {
  row: number;
  type: CatalogItemType;
  sku: string | null;
  name: string;
  description: string | null;
  unit: string;
  salesPrice: string | null;
  currency: string;
  suggestedTaxCode: string | null;
  revenueAccountCode: string | null;
  expenseAccountCode: string | null;
  trackInventory: boolean;
}

const EXPECTED_HEADERS = [
  "type",
  "sku",
  "name",
  "description",
  "unit",
  "sales_price",
  "currency",
  "suggested_tax_code",
  "revenue_account_code",
  "expense_account_code",
  "track_inventory",
] as const;

export function parseCatalogCsv(csv: string): ImportedCatalogItemRow[] {
  const records = parseCsv(csv);
  if (records.length < 2)
    throw new BadRequestException(
      "CSV must include a header and at least one data row",
    );
  const headers = records[0].map((header) => header.trim().toLowerCase());
  const missing = EXPECTED_HEADERS.filter(
    (header) => !headers.includes(header),
  );
  if (missing.length)
    throw new BadRequestException(
      `CSV is missing required headers: ${missing.join(", ")}`,
    );
  const index = (header: (typeof EXPECTED_HEADERS)[number]) =>
    headers.indexOf(header);
  const seenSkus = new Set<string>();
  return records
    .slice(1)
    .filter((record) => record.some((value) => value.trim()))
    .map((record, recordIndex) => {
      const row = recordIndex + 2;
      const value = (header: (typeof EXPECTED_HEADERS)[number]) =>
        record[index(header)]?.trim() ?? "";
      const typeValue = value("type").toUpperCase();
      if (
        typeValue !== CatalogItemType.PRODUCT &&
        typeValue !== CatalogItemType.SERVICE
      )
        throw new BadRequestException(
          `Row ${row}: type must be PRODUCT or SERVICE`,
        );
      const name = value("name");
      if (!name) throw new BadRequestException(`Row ${row}: name is required`);
      const sku = nullable(value("sku"));
      if (sku && seenSkus.has(sku))
        throw new BadRequestException(
          `Row ${row}: duplicate sku in this import`,
        );
      if (sku) seenSkus.add(sku);
      const salesPrice = nullable(value("sales_price"));
      if (salesPrice && !/^\d+(?:\.\d{1,2})?$/.test(salesPrice))
        throw new BadRequestException(
          `Row ${row}: sales_price must be a non-negative amount with at most two decimals`,
        );
      const currency = value("currency").toUpperCase();
      if (!CURRENCIES.has(currency))
        throw new BadRequestException(
          `Row ${row}: currency must be an ISO 4217 code`,
        );
      const trackInventory = parseBoolean(value("track_inventory"), row);
      if (typeValue === CatalogItemType.SERVICE && trackInventory)
        throw new BadRequestException(
          `Row ${row}: services cannot track inventory`,
        );
      return {
        row,
        type: typeValue,
        sku,
        name,
        description: nullable(value("description")),
        unit: nullable(value("unit")) ?? "unit",
        salesPrice,
        currency,
        suggestedTaxCode: nullable(value("suggested_tax_code")),
        revenueAccountCode: nullable(value("revenue_account_code")),
        expenseAccountCode: nullable(value("expense_account_code")),
        trackInventory,
      };
    });
}

function parseBoolean(value: string, row: number): boolean {
  const normalised = value.toLowerCase();
  if (["true", "1", "yes", "si", "sí"].includes(normalised)) return true;
  if (["false", "0", "no"].includes(normalised)) return false;
  throw new BadRequestException(
    `Row ${row}: track_inventory must be true/false, yes/no, or 1/0`,
  );
}
function nullable(value: string): string | null {
  return value || null;
}
