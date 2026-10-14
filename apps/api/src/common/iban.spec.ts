import { isValidIban, normalizeIban, spanishIbanFromParts } from "./iban";

describe("IBAN helpers", () => {
  it("normalizes whitespace and validates the checksum", () => {
    const iban = normalizeIban("ES91 2100 0418 4502 0005 1332");
    expect(iban).toBe("ES9121000418450200051332");
    expect(isValidIban(iban!)).toBe(true);
  });

  it("rejects invalid formats and checksums", () => {
    expect(isValidIban("ES9121000418450200051333")).toBe(false);
    expect(isValidIban("not-an-iban")).toBe(false);
  });

  it("rebuilds a Spanish IBAN from a CCC without control digits", () => {
    expect(spanishIbanFromParts("2100", "0418", "0200051332")).toBe(
      "ES9121000418450200051332",
    );
    // The control digits hit the 11 -> 0 and 10 -> 1 substitutions here.
    const iban = spanishIbanFromParts("0049", "1500", "0000000002");
    expect(iban).toMatch(/^ES\d{2}00491500010000000002$/);
    expect(isValidIban(iban!)).toBe(true);
    expect(spanishIbanFromParts("2100", "418", "0200051332")).toBeNull();
  });
});
