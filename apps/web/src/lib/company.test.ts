import { describe, expect, it } from "vitest";
import {
  companySettingsInput,
  normalizeCompanySettings,
  type CompanySettings,
} from "./company";

const company: CompanySettings = {
  id: "company-1",
  legalName: "Coral Data Lab, S.L.",
  soleShareholder: false,
  taxId: "B01876543",
  country: "ES",
  baseCurrency: "EUR",
  timezone: "Europe/Madrid",
  sifMode: "DISABLED",
  aeatEnvironment: "PRODUCTION",
  sifSoftwareProducerName: null,
  sifSoftwareProducerTaxId: null,
  sifSoftwareName: null,
  sifSoftwareId: null,
  sifSoftwareVersion: null,
  sifInstallationNumber: null,
  documentProfile: null,
  documentLogo: null,
};

describe("company settings helpers", () => {
  it("fills profile defaults for a company without a profile", () => {
    expect(companySettingsInput(company).documentProfile).toMatchObject({
      addressCountry: "ES",
      primaryColor: "#F71950",
    });
  });

  it("preserves the unipersonal declaration when saving", () => {
    const input = companySettingsInput({ ...company, soleShareholder: true });
    expect(normalizeCompanySettings(input).soleShareholder).toBe(true);
  });

  it("trims optional empty values before saving", () => {
    const input = companySettingsInput(company);
    input.legalName = "  Coral Data Lab, S.L.  ";
    input.documentProfile.phone = "   ";
    expect(normalizeCompanySettings(input)).toMatchObject({
      legalName: "Coral Data Lab, S.L.",
      documentProfile: { phone: null },
    });
  });

  it("does not send API-only document profile metadata back to the server", () => {
    const input = companySettingsInput({
      ...company,
      documentProfile: {
        ...companySettingsInput(company).documentProfile,
        id: "profile-1",
        organizationId: "organization-1",
        companyId: "company-1",
        createdAt: "2026-09-15T00:00:00.000Z",
        updatedAt: "2026-09-15T00:00:00.000Z",
      } as CompanySettings["documentProfile"],
    });
    const profile = normalizeCompanySettings(input).documentProfile;
    expect(profile).not.toHaveProperty("id");
    expect(profile).not.toHaveProperty("organizationId");
    expect(profile).not.toHaveProperty("companyId");
    expect(profile).not.toHaveProperty("createdAt");
    expect(profile).not.toHaveProperty("updatedAt");
  });
});
