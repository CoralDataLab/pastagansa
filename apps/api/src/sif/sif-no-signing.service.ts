import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { readFileSync } from "node:fs";
import { signSifRecordXml, validateSifSigningIdentity, type SifSigningIdentity } from "./sif-xades";

@Injectable()
export class SifNoSigningService {
  private readonly identity: SifSigningIdentity | null;
  private readonly companyId: string | null;
  private readonly issuerTaxId: string | null;

  constructor(config: ConfigService) {
    const enabled = config.get<string>("SIF_NO_SIGNING_ENABLED") === "true";
    this.companyId = enabled ? config.getOrThrow<string>("SIF_NO_COMPANY_ID") : null;
    this.issuerTaxId = enabled ? config.getOrThrow<string>("SIF_NO_ISSUER_TAX_ID") : null;
    this.identity = enabled ? {
      p12: readFileSync(config.getOrThrow<string>("SIF_NO_PFX_PATH")),
      passphrase: readFileSync(config.getOrThrow<string>("SIF_NO_PFX_PASSPHRASE_FILE"), "utf8")
        .replace(/\r?\n$/, ""),
      expectedCertificateSha256: config.getOrThrow<string>("SIF_NO_CERT_SHA256"),
      expectedIssuerTaxId: this.issuerTaxId!,
    } : null;
    if (this.identity) validateSifSigningIdentity(this.identity);
  }

  matches(companyId: string, issuerTaxId: string): boolean {
    return this.identity !== null && this.companyId === companyId &&
      this.issuerTaxId === issuerTaxId;
  }

  async sign(xml: string): Promise<string> {
    if (!this.identity) throw new Error("NO VERI*FACTU signing is not configured");
    return signSifRecordXml(xml, this.identity);
  }
}
