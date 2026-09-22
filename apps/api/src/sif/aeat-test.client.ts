import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { readFileSync } from "node:fs";
import { Agent, request } from "node:https";
import { createSecureContext } from "node:tls";
import { aeatTestSoapEnvelope } from "./aeat-test-soap";
import { aeatTestQueryEnvelope, type AeatTestQueryIdentity } from "./aeat-test-query";

// SistemaVerifactuPruebas in the AEAT SistemaFacturacion.wsdl. Never accept a
// configurable production URL while this integration is limited to testing.
export const AEAT_TEST_ENDPOINT =
  "https://prewww1.aeat.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP";

export class AeatTestTransportError extends Error {
  constructor(message: string, readonly ambiguous: boolean) {
    super(message);
  }
}

@Injectable()
export class AeatTestClient implements OnModuleDestroy {
  readonly enabled: boolean;
  readonly companyId: string | null;
  readonly issuerTaxId: string | null;
  private readonly agent?: Agent;

  constructor(config: ConfigService) {
    this.enabled = config.get<string>("AEAT_TEST_ENABLED") === "true";
    this.companyId = this.enabled ? config.getOrThrow<string>("AEAT_TEST_COMPANY_ID") : null;
    this.issuerTaxId = this.enabled ? config.getOrThrow<string>("AEAT_TEST_ISSUER_TAX_ID") : null;
    if (this.enabled) {
      const pfx = readFileSync(config.getOrThrow<string>("AEAT_TEST_PFX_PATH"));
      const passphrase = readFileSync(
        config.getOrThrow<string>("AEAT_TEST_PFX_PASSPHRASE_FILE"), "utf8",
      ).replace(/\r?\n$/, "");
      if (!passphrase) throw new Error("AEAT test certificate passphrase file is empty");
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
      const req = request(AEAT_TEST_ENDPOINT, {
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
