import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { X509Certificate } from "node:crypto";
import * as forge from "node-forge";
import { SifNoSigningService } from "../../src/sif/sif-no-signing.service";
import { signSifRecordXml } from "../../src/sif/sif-xades";

/** Test-only signer for integration cases that exercise a real SIF chain. */
export function createSifTestSigner(issuerTaxId: string) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = "01";
  certificate.validity.notBefore = new Date(Date.now() - 86_400_000);
  certificate.validity.notAfter = new Date(Date.now() + 86_400_000);
  certificate.setSubject([
    { name: "commonName", value: "SIF integration test signer" },
    { type: "2.5.4.97", value: `VATES-${issuerTaxId}` },
  ]);
  certificate.setIssuer(certificate.subject.attributes);
  certificate.sign(keys.privateKey, forge.md.sha256.create());
  const der = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(certificate)).getBytes(), "binary");
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, certificate, "test-pass", { algorithm: "3des" });
  const identity = {
    p12: Buffer.from(forge.asn1.toDer(p12).getBytes(), "binary"),
    passphrase: "test-pass",
    expectedCertificateSha256: new X509Certificate(der).fingerprint256.replaceAll(":", "").toLowerCase(),
    expectedIssuerTaxId: issuerTaxId,
  };
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
