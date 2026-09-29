import { BadRequestException } from "@nestjs/common";
import { parseContactCsv } from "./csv";

describe("parseContactCsv", () => {
  const header =
    "legal_name,trade_name,tax_id,email,phone,is_customer,is_supplier";

  it("parses quoted fields and accepted boolean forms", () => {
    const rows = parseContactCsv(
      `${header}\n"Acme, S.L.",Acme,B12345674,ADMIN@ACME.ES,+34 600 000 000,yes,0`,
    );
    expect(rows).toEqual([
      {
        row: 2,
        legalName: "Acme, S.L.",
        tradeName: "Acme",
        taxId: "B12345674",
        taxCountry: "ES",
        email: "admin@acme.es",
        phone: "+34 600 000 000",
        isCustomer: true,
        isSupplier: false,
      },
    ]);
  });

  it("accepts foreign IDs only with an explicit tax_country column", () => {
    const rows = parseContactCsv(`${header},tax_country\nAnthropic Ireland,,IE4276970QH,,,0,1,IE`);
    expect(rows[0]).toMatchObject({ taxId: "IE4276970QH", taxCountry: "IE" });
    expect(() => parseContactCsv(`${header}\nAnthropic Ireland,,IE4276970QH,,,0,1`)).toThrow(BadRequestException);
  });

  it("rejects duplicate fiscal IDs inside an import", () => {
    expect(() =>
      parseContactCsv(`${header}\nA,,B12345674,,,1,0\nB,,B12345674,,,0,1`),
    ).toThrow(BadRequestException);
  });
});
