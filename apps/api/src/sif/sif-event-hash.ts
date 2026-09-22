import { createHash } from "node:crypto";

/** Field order and names from the AEAT hash specification v0.1.2, section 3.c. */
export type SifEventHashInput = {
  producerTaxId: string;
  softwareId: string;
  softwareVersion: string;
  installationNumber: string;
  issuerTaxId: string;
  eventType: string;
  previousHash?: string | null;
  generatedAt: string;
};

export function canonicalSifEventHashInput(input: SifEventHashInput): string {
  return [
    ["NIF", input.producerTaxId],
    ["ID", ""],
    ["IdSistemaInformatico", input.softwareId],
    ["Version", input.softwareVersion],
    ["NumeroInstalacion", input.installationNumber],
    ["NIF", input.issuerTaxId],
    ["TipoEvento", input.eventType],
    ["HuellaEvento", input.previousHash ?? ""],
    ["FechaHoraHusoGenEvento", input.generatedAt],
  ].map(([name, value]) => `${name}=${value.trim()}`).join("&");
}

export function hashSifEvent(input: SifEventHashInput): string {
  return createHash("sha256")
    .update(canonicalSifEventHashInput(input), "utf8")
    .digest("hex").toUpperCase();
}
