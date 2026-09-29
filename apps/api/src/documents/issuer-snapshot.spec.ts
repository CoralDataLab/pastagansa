import {
  captureIssuerSnapshot,
  issuerAddressLines,
  issuerUnipersonalMention,
  readIssuerSnapshot,
} from "./issuer-snapshot";

describe("issuer snapshots", () => {
  it("captures commercial data and the exact logo metadata", () => {
    const captured = captureIssuerSnapshot({
      legalName: "Coral Data Lab, S.L.",
      soleShareholder: true,
      taxId: "B12345674",
      documentProfile: {
        tradeName: "Coral",
        addressLine1: "Calle Ejemplo 1",
        addressLine2: null,
        postalCode: "28001",
        city: "Madrid",
        province: null,
        addressCountry: "ES",
        email: "hola@example.test",
        phone: null,
        website: null,
        bankIban: "ES9121000418450200051332",
        paymentInstructions: null,
        paymentTerms: null,
        defaultNotes: null,
        documentFooter: null,
        primaryColor: "#F71950",
      },
      documentLogo: {
        mediaType: "image/png",
        sha256: "a".repeat(64),
        width: 120,
        height: 80,
        content: Uint8Array.from([1, 2, 3]),
      },
    });
    const snapshot = readIssuerSnapshot(captured.issuerSnapshot);
    expect(snapshot).toMatchObject({
      source: "company_profile",
      legalName: "Coral Data Lab, S.L.",
      soleShareholder: true,
      bankIban: "ES9121000418450200051332",
      logo: { mediaType: "image/png", width: 120, height: 80 },
    });
    expect(issuerUnipersonalMention(snapshot)).toBe("Sociedad Unipersonal");
    expect(issuerUnipersonalMention({ ...snapshot, soleShareholder: false })).toBeNull();
    expect(issuerUnipersonalMention({ ...snapshot, legalName: "Coral Sociedad Unipersonal" })).toBeNull();
    expect(issuerAddressLines(snapshot)).toEqual([
      "Calle Ejemplo 1",
      "28001 Madrid",
      "ES",
    ]);
  });

  it("keeps legacy snapshots deliberately incomplete", () => {
    expect(readIssuerSnapshot({ version: 1, source: "legacy_backfill" })).toEqual({
      version: 1,
      source: "legacy_backfill",
    });
  });
});
