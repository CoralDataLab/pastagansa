import { BadRequestException } from "@nestjs/common";
import { validContactTaxId } from "./contact-tax-id";

export interface ImportedContactRow {
  row: number;
  legalName: string;
  tradeName: string | null;
  taxId: string | null;
  taxCountry: string;
  email: string | null;
  phone: string | null;
  isCustomer: boolean;
  isSupplier: boolean;
}

const EXPECTED_HEADERS = [
  "legal_name",
  "trade_name",
  "tax_id",
  "email",
  "phone",
  "is_customer",
  "is_supplier",
] as const;

export function parseContactCsv(csv: string): ImportedContactRow[] {
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
  const seenTaxIds = new Set<string>();

  return records
    .slice(1)
    .filter((record) => record.some((value) => value.trim()))
    .map((record, recordIndex) => {
      const row = recordIndex + 2;
      const value = (header: (typeof EXPECTED_HEADERS)[number]) =>
        record[index(header)]?.trim() ?? "";
      const legalName = value("legal_name");
      if (!legalName)
        throw new BadRequestException(`Row ${row}: legal_name is required`);
      const isCustomer = parseBoolean(value("is_customer"), row, "is_customer");
      const isSupplier = parseBoolean(value("is_supplier"), row, "is_supplier");
      if (!isCustomer && !isSupplier)
        throw new BadRequestException(
          `Row ${row}: a contact must be a customer, a supplier, or both`,
        );
      const taxId = nullable(value("tax_id"))?.toUpperCase() ?? null;
      const taxCountry = (headers.includes("tax_country") ? record[headers.indexOf("tax_country")]?.trim() : "ES")?.toUpperCase() || "ES";
      if (!/^[A-Z]{2}$/.test(taxCountry))
        throw new BadRequestException(`Row ${row}: tax_country must be a two-letter country code`);
      if (!validContactTaxId(taxId, taxCountry))
        throw new BadRequestException(`Row ${row}: tax_id is invalid for tax_country ${taxCountry}`);
      if (taxId && seenTaxIds.has(taxId))
        throw new BadRequestException(
          `Row ${row}: duplicate tax_id in this import`,
        );
      if (taxId) seenTaxIds.add(taxId);
      const email = nullable(value("email"))?.toLowerCase() ?? null;
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        throw new BadRequestException(`Row ${row}: email is invalid`);
      return {
        row,
        legalName,
        tradeName: nullable(value("trade_name")),
        taxId,
        taxCountry,
        email,
        phone: nullable(value("phone")),
        isCustomer,
        isSupplier,
      };
    });
}

function parseBoolean(value: string, row: number, field: string): boolean {
  const normalised = value.trim().toLowerCase();
  if (["true", "1", "yes", "si", "sí"].includes(normalised)) return true;
  if (["false", "0", "no"].includes(normalised)) return false;
  throw new BadRequestException(
    `Row ${row}: ${field} must be true/false, yes/no, or 1/0`,
  );
}

function nullable(value: string): string | null {
  return value || null;
}

function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < csv.length; i += 1) {
    const character = csv[i];
    if (quoted) {
      if (character === '"' && csv[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (character === '"') quoted = false;
      else field += character;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += character;
  }
  if (quoted) throw new BadRequestException("CSV has an unclosed quoted field");
  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}
