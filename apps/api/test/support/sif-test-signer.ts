import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SifNoSigningService } from "../../src/sif/sif-no-signing.service";
import { signSifRecordXml } from "../../src/sif/sif-xades";
import { createTestPkcs12Identity } from "./test-pkcs12";

/** Test-only signer for integration cases that exercise a real SIF chain. */
export function createSifTestSigner(issuerTaxId: string) {
  const identity = createTestPkcs12Identity(issuerTaxId);
  let companyId: string | null = null;
  const names = ["SIF_NO_SIGNING_ENABLED", "SIF_NO_COMPANY_ID", "SIF_NO_ISSUER_TAX_ID"] as const;
  let previousEnvironment: Array<string | undefined> | null = null;
  return {
    signer: {
      matches: (id: string, taxId: string) => id === companyId && taxId === issuerTaxId,
      sign: (xml: string) => signSifRecordXml(xml, identity),
    } satisfies Pick<SifNoSigningService, "matches" | "sign">,
    bind(app: INestApplication, id: string) {
      companyId = id;
      previousEnvironment = names.map((name) => process.env[name]);
      const config = app.get(ConfigService);
      config.set("SIF_NO_SIGNING_ENABLED", "true");
      config.set("SIF_NO_COMPANY_ID", id);
      config.set("SIF_NO_ISSUER_TAX_ID", issuerTaxId);
    },
    restore() {
      if (!previousEnvironment) return;
      names.forEach((name, index) => {
        const previous = previousEnvironment![index];
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      });
      previousEnvironment = null;
      companyId = null;
    },
  };
}
