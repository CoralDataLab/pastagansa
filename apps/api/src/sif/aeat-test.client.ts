import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { readFileSync } from "node:fs";
import { Agent, request } from "node:https";
import { createSecureContext } from "node:tls";
import { aeatTestSoapEnvelope } from "./aeat-test-soap";
import { aeatTestQueryEnvelope, type AeatTestQueryIdentity } from "./aeat-test-query";
import { validateSifSigningIdentity } from "./sif-xades";

// Fixed endpoints from the AEAT SistemaFacturacion.wsdl; never accept a URL
// from runtime configuration.
export const AEAT_TEST_ENDPOINT =
  "https://prewww1.aeat.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP";
export const AEAT_PRODUCTION_ENDPOINT =
  "https://www1.agenciatributaria.gob.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP";

export class AeatTestTransportError extends Error {
  constructor(message: string, readonly ambiguous: boolean) {
    super(message);
  }
}

export class AeatTransportClient implements OnModuleDestroy {
  readonly enabled: boolean;
  readonly companyId: string | null;
  readonly issuerTaxId: string | null;
  readonly environment: "TEST" | "PRODUCTION";
  private readonly endpoint: string;
  private readonly agent?: Agent;

  constructor(config: ConfigService, environment: "TEST" | "PRODUCTION") {
    this.environment = environment;
    const prefix = environment === "TEST" ? "AEAT_TEST" : "AEAT_PRODUCTION";
    this.endpoint = environment === "TEST" ? AEAT_TEST_ENDPOINT : AEAT_PRODUCTION_ENDPOINT;
    this.enabled = config.get<string>(`${prefix}_ENABLED`) === "true";
    this.companyId = this.enabled ? config.getOrThrow<string>(`${prefix}_COMPANY_ID`) : null;
    this.issuerTaxId = this.enabled ? config.getOrThrow<string>(`${prefix}_ISSUER_TAX_ID`) : null;
    if (this.enabled) {
      const pfx = readFileSync(config.getOrThrow<string>(`${prefix}_PFX_PATH`));
      const passphrase = readFileSync(
        config.getOrThrow<string>(`${prefix}_PFX_PASSPHRASE_FILE`), "utf8",
      ).replace(/\r?\n$/, "");
      if (!passphrase) throw new Error("AEAT certificate passphrase file is empty");
      if (environment === "PRODUCTION") validateSifSigningIdentity({
        p12: pfx, passphrase,
        expectedCertificateSha256: config.getOrThrow<string>("AEAT_PRODUCTION_CERT_SHA256"),
        expectedIssuerTaxId: this.issuerTaxId!,
      });
      createSecureContext({ pfx, passphrase, minVersion: "TLSv1.2" });
      this.agent = new Agent({
        pfx,
        passphrase,
        minVersion: "TLSv1.2",
        keepAlive: false,
      });
    }
  }

  onModuleDestroy() {
    this.agent?.destroy();
  }

  async send(batchXml: string): Promise<{ httpStatus: number; responseXml: string }> {
    return this.post(aeatTestSoapEnvelope(batchXml));
  }

  async query(identity: AeatTestQueryIdentity): Promise<{ httpStatus: number; responseXml: string }> {
    return this.post(aeatTestQueryEnvelope(identity));
  }

  private async post(soapXml: string): Promise<{ httpStatus: number; responseXml: string }> {
    if (!this.agent) throw new Error("AEAT test sender is not configured");
    const body = Buffer.from(soapXml, "utf8");
    return new Promise((resolve, reject) => {
      let sent = false;
      const req = request(this.endpoint, {
        method: "POST",
        agent: this.agent,
        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          SOAPAction: '""',
          "Content-Length": body.length,
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1_000_000) {
            req.destroy(new AeatTestTransportError("AEAT response exceeds 1 MB", true));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => resolve({
          httpStatus: response.statusCode ?? 0,
          responseXml: Buffer.concat(chunks).toString("utf8"),
        }));
        response.on("error", (error) => reject(new AeatTestTransportError(error.message, true)));
      });
      req.on("finish", () => { sent = true; });
      req.on("error", (error) => reject(error instanceof AeatTestTransportError
        ? error
        : new AeatTestTransportError(error.message, sent)));
      req.setTimeout(30_000, () => req.destroy(new AeatTestTransportError("AEAT request timed out", sent)));
      req.end(body);
    });
  }
}

@Injectable()
export class AeatTestClient extends AeatTransportClient {
  constructor(config: ConfigService) { super(config, "TEST"); }
}

@Injectable()
export class AeatProductionClient extends AeatTransportClient {
  constructor(config: ConfigService) { super(config, "PRODUCTION"); }
}
