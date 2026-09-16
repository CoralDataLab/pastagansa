import { SifDeclarationPdfService } from "./sif-declaration-pdf.service";

describe("SifDeclarationPdfService", () => {
  it("renders a readable declaration draft PDF", async () => {
    const service = new SifDeclarationPdfService();
    const pdf = await service.render({
      company: {
        legalName: "Coral Data Lab, S.L.",
        taxId: "B12345674",
        sifSoftwareProducerName: "Coral Data Lab, S.L.",
        sifSoftwareProducerTaxId: "B12345674",
        sifSoftwareName: "Pastagansa",
        sifSoftwareId: "PG",
        sifSoftwareVersion: "0.1.0",
        sifInstallationNumber: "test-1",
        documentProfile: {
          addressLine1: "Calle Ejemplo, 1",
          addressLine2: null,
          postalCode: "28001",
          city: "Madrid",
          province: "Madrid",
          addressCountry: "ES",
          email: "hola@example.com",
          website: "https://example.com",
        },
      },
    });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(3_000);
    expect(pdf.toString("latin1").match(/\/Type \/Page\b/g)?.length).toBe(1);
  });
});
