import { DOMParser, type Element as XmlElement } from "@xmldom/xmldom";
import { createHash } from "node:crypto";
import { hashSifEvent, type SifEventHashInput } from "./sif-event-hash";
import { AEAT_SIF_EVENT_NAMESPACE, verifySifRecordSignature } from "./sif-xades";

export type SifEventChainRecord = {
  id: string;
  eventType: string;
  chainPosition: bigint;
  generatedAt: Date;
  previousEventId: string | null;
  previousEventHash: string | null;
  eventHash: string;
  hashInput: unknown;
  signedXml: string;
  signedXmlSha256: string;
};

export type SifEventChainVerification = {
  valid: boolean;
  recordsChecked: number;
  firstInvalid: { id: string; chainPosition: string; reason: string } | null;
};

/** Verifies the separately chained NO VERI*FACTU events, including XML signatures. */
export async function verifySifEventChain(
  records: readonly SifEventChainRecord[],
): Promise<SifEventChainVerification> {
  return verifySegment(records);
}

/** Checks the newest event against its immediate predecessor before appending. */
export async function verifySifEventTail(
  record: SifEventChainRecord, previous: SifEventChainRecord | null,
): Promise<SifEventChainVerification> {
  return verifySegment([record], previous ?? undefined);
}

async function verifySegment(
  records: readonly SifEventChainRecord[], seed?: SifEventChainRecord,
): Promise<SifEventChainVerification> {
  let previous = seed;
  let previousInput = seed ? readEventHashInput(seed.hashInput) : null;
  if (seed && !previousInput) return {
    valid: false, recordsChecked: 0,
    firstInvalid: { id: seed.id, chainPosition: seed.chainPosition.toString(),
      reason: "Previous event hash input is invalid" },
  };
  for (const [index, record] of records.entries()) {
    const invalid = (reason: string): SifEventChainVerification => ({
      valid: false, recordsChecked: index + 1,
      firstInvalid: { id: record.id, chainPosition: record.chainPosition.toString(), reason },
    });
    if (record.chainPosition !== (seed?.chainPosition ?? 0n) + BigInt(index + 1))
      return invalid("Unexpected event chain position");
    if (record.previousEventId !== (previous?.id ?? null) ||
        record.previousEventHash !== (previous?.eventHash ?? null))
      return invalid("Previous event reference does not match");
    const input = readEventHashInput(record.hashInput);
    if (!input || input.eventType !== record.eventType ||
        (input.previousHash ?? "") !== (previous?.eventHash ?? "") ||
        hashSifEvent(input) !== record.eventHash)
      return invalid("Event hash input does not match the chain");
    const generatedAt = Date.parse(input.generatedAt);
    if (!Number.isFinite(generatedAt) ||
        Math.abs(generatedAt - record.generatedAt.getTime()) >= 1_000 ||
        (previous && record.generatedAt < previous.generatedAt))
      return invalid("Event generation time does not match");
    if (createHash("sha256").update(record.signedXml).digest("hex") !== record.signedXmlSha256)
      return invalid("Signed event XML bytes changed");
    if (!await verifySifRecordSignature(record.signedXml))
      return invalid("Event XML signature or policy is invalid");
    if (!eventXmlMatches(record.signedXml, record.eventHash, input, previousInput))
      return invalid("Signed event XML does not match its hash fields");
    previous = record;
    previousInput = input;
  }
  return { valid: true, recordsChecked: records.length, firstInvalid: null };
}

function readEventHashInput(value: unknown): SifEventHashInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const fields = ["producerTaxId", "softwareId", "softwareVersion", "installationNumber",
    "issuerTaxId", "eventType", "generatedAt"] as const;
  if (fields.some((field) => typeof input[field] !== "string") ||
      (input.previousHash != null && typeof input.previousHash !== "string")) return null;
  return input as SifEventHashInput;
}

function eventXmlMatches(
  xml: string, hash: string, input: SifEventHashInput, previous: SifEventHashInput | null,
): boolean {
  try {
    const document = new DOMParser().parseFromString(xml, "application/xml");
    const record = document.documentElement;
    if (!record || record.localName !== "RegistroEvento" ||
        record.namespaceURI !== AEAT_SIF_EVENT_NAMESPACE)
      return false;
    const direct = (parent: XmlElement, name: string): XmlElement | null => {
      const found = Array.from(parent.childNodes).find((node) => node.nodeType === 1 &&
        (node as XmlElement).localName === name &&
        (node as XmlElement).namespaceURI === AEAT_SIF_EVENT_NAMESPACE);
      return found as XmlElement | undefined ?? null;
    };
    const value = (parent: XmlElement, name: string) => direct(parent, name)?.textContent?.trim() ?? null;
    const event = direct(record, "Evento");
    if (!event) return false;
    const software = direct(event, "SistemaInformatico");
    const issuer = direct(event, "ObligadoEmision");
    const chain = direct(event, "Encadenamiento");
    if (!software || !issuer || !chain ||
        value(software, "NIF") !== input.producerTaxId ||
        value(software, "IdSistemaInformatico") !== input.softwareId ||
        value(software, "Version") !== input.softwareVersion ||
        value(software, "NumeroInstalacion") !== input.installationNumber ||
        value(issuer, "NIF") !== input.issuerTaxId ||
        value(event, "TipoEvento") !== input.eventType ||
        value(event, "FechaHoraHusoGenEvento") !== input.generatedAt ||
        value(event, "HuellaEvento") !== hash)
      return false;
    if (!previous) return value(chain, "PrimerEvento") === "S";
    const prior = direct(chain, "EventoAnterior");
    return !!prior && value(prior, "TipoEvento") === previous.eventType &&
      value(prior, "FechaHoraHusoGenEvento") === previous.generatedAt &&
      value(prior, "HuellaEvento") === (input.previousHash ?? null);
  } catch {
    return false;
  }
}
