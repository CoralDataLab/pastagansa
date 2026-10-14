import { norma43Statement } from "../../test/support/norma43-statement";
import { Norma43FormatError, parseNorma43 } from "./norma43";

const parse = (text: string, encoding: BufferEncoding = "latin1") =>
  parseNorma43(Buffer.from(text, encoding));

describe("Norma 43 parser", () => {
  it("parses account blocks, balances and movements", () => {
    const [operating, savings] = parse(
      norma43Statement([
        {
          holder: "MUÑOZ Y ASOCIADOS SL",
          openingCents: 100_000,
          movements: [
            {
              cents: 12_100,
              date: "260903",
              valueDate: "260904",
              reference1: "000000000000",
              reference2: "F2026-00001",
              concepts: ["TRANSFERENCIA DE CLIENTE A", "FACTURA F2026-00001"],
            },
            { cents: -4_550, commonConcept: "17", reference1: "COMISION" },
          ],
        },
        { account: "0200051333", openingCents: -2_500, movements: [] },
      ]),
    );
    expect(operating).toMatchObject({
      bankCode: "2100",
      branchCode: "0418",
      accountNumber: "0200051332",
      iban: "ES9121000418450200051332",
      holderName: "MUÑOZ Y ASOCIADOS SL",
      currency: "EUR",
      startDate: "2026-09-01",
      endDate: "2026-09-30",
      openingBalanceCents: 100_000,
      closingBalanceCents: 107_550,
    });
    expect(operating.movements).toEqual([
      expect.objectContaining({
        operationDate: "2026-09-03",
        valueDate: "2026-09-04",
        amountCents: 12_100,
        description: "TRANSFERENCIA DE CLIENTE A FACTURA F2026-00001",
        reference: "F2026-00001",
      }),
      expect.objectContaining({
        amountCents: -4_550,
        description: "Intereses - comisiones - custodia - gastos e impuestos · COMISION",
        reference: "COMISION",
      }),
    ]);
    expect(operating.movements[0].externalId).toMatch(/^n43:[0-9a-f]{64}$/);
    expect(savings).toMatchObject({ openingBalanceCents: -2_500, closingBalanceCents: -2_500, movements: [] });
  });

  it("keeps movement IDs stable across overlapping files and distinct for identical movements", () => {
    const repeated = { cents: -1_000, date: "260905", reference1: "CAFE" };
    const september = parse(norma43Statement([{ movements: [repeated, repeated] }]))[0];
    const extended = parse(
      norma43Statement([
        {
          end: "261005",
          movements: [repeated, repeated, { cents: 5_000, date: "261002" }],
        },
      ]),
    )[0];
    const [first, second] = september.movements.map(({ externalId }) => externalId);
    expect(first).not.toBe(second);
    expect(extended.movements.slice(0, 2).map(({ externalId }) => externalId)).toEqual([first, second]);
  });

  it("accepts UTF-8, LF, unpadded and unseparated records and a DOS end-of-file marker", () => {
    const text = norma43Statement([{ holder: "MUÑOZ", movements: [{ cents: 500 }] }], { newline: "\n" });
    expect(parse(text, "utf8")[0].holderName).toBe("MUÑOZ");
    expect(parse(text.replace(/ +\n/g, "\n"))[0].movements).toHaveLength(1);
    expect(parse(text.replace(/\n/g, ""))[0].movements).toHaveLength(1);
    expect(parse(`${text}\u001a`)[0].movements).toHaveLength(1);
  });

  it("tolerates a record 88 count that includes itself", () => {
    expect(parse(norma43Statement([{ movements: [] }], { recordCount: 3 }))).toHaveLength(1);
    expect(() => parse(norma43Statement([{ movements: [] }], { recordCount: 4 }))).toThrow(
      "Record 88 declares 4 records but the file has 2",
    );
  });

  it("keeps zero-amount movements for the caller to skip", () => {
    const [account] = parse(norma43Statement([{ movements: [{ cents: 0 }] }]));
    expect(account.movements[0].amountCents).toBe(0);
  });

  it.each([
    ["mismatched totals", norma43Statement([{ debitCount: 2, movements: [{ cents: -100 }] }]), "Line 3: The number of debits does not match record 33"],
    ["a wrong closing balance", norma43Statement([{ closingCents: 1, movements: [{ cents: 100 }] }]), "Opening balance plus movements does not equal the closing balance"],
    ["an unknown record", "99".padEnd(80), 'Line 1: Unknown record type "99"'],
    ["a movement outside an account", `22${"0".repeat(78)}`, "Movement 22 found outside an account block"],
    ["an unclosed account", norma43Statement([{ movements: [] }]).split("\r\n")[0], "The file ends before record 33 closed the last account"],
    ["records after 88", `${norma43Statement([{ movements: [] }])}${"11".padEnd(80)}`, "Records found after the end-of-file record 88"],
    ["a record over 80 characters", `${"11".padEnd(80)}X`, "Line 1: Record is longer than 80 characters"],
    ["an invalid date", norma43Statement([{ start: "260230", movements: [] }]), "The start date is not a valid YYMMDD date"],
    ["an empty file", "\r\n", "The file contains no account blocks"],
  ])("rejects %s", (_, text, message) => {
    expect(() => parse(text)).toThrow(Norma43FormatError);
    expect(() => parse(text)).toThrow(message);
  });

  it("rejects a totals record for a different account", () => {
    const text = norma43Statement([{ movements: [] }]).replace(/^33(\d{8})0200051332/m, "33$10200059999");
    expect(() => parse(text)).toThrow("Account totals 33 do not match the account header 11");
  });
});
