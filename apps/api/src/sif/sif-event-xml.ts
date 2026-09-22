import { hashSifEvent, type SifEventHashInput } from "./sif-event-hash";
import { AEAT_SIF_EVENT_NAMESPACE } from "./sif-xades";

export type SifBasicEventInput = Omit<SifEventHashInput, "previousHash" | "eventType"> & {
  eventType: "01" | "02";
  producerName: string;
  softwareName: string;
  issuerName: string;
  previous?: { eventType: string; generatedAt: string; hash: string } | null;
};

/** Renders the AEAT start/stop event structure; caller must sign before storage. */
export function renderSifBasicEventXml(input: SifBasicEventInput): { xml: string; hash: string } {
  const hash = hashSifEvent({
    ...input, previousHash: input.previous?.hash,
  });
  const el = (name: string, value: string) => `<ev:${name}>${escapeXml(value)}</ev:${name}>`;
  const previous = input.previous;
  const chain = previous
    ? `<ev:EventoAnterior>${el("TipoEvento", previous.eventType)}` +
      `${el("FechaHoraHusoGenEvento", previous.generatedAt)}` +
      `${el("HuellaEvento", previous.hash)}</ev:EventoAnterior>`
    : el("PrimerEvento", "S");
  return {
    hash,
    xml: `<?xml version="1.0" encoding="UTF-8"?>` +
      `<ev:RegistroEvento xmlns:ev="${AEAT_SIF_EVENT_NAMESPACE}">` +
      el("IDVersion", "1.0") + `<ev:Evento><ev:SistemaInformatico>` +
      el("NombreRazon", input.producerName) + el("NIF", input.producerTaxId) +
      el("NombreSistemaInformatico", input.softwareName) +
      el("IdSistemaInformatico", input.softwareId) +
      el("Version", input.softwareVersion) +
      el("NumeroInstalacion", input.installationNumber) +
      `</ev:SistemaInformatico><ev:ObligadoEmision>` +
      el("NombreRazon", input.issuerName) + el("NIF", input.issuerTaxId) +
      `</ev:ObligadoEmision>` + el("FechaHoraHusoGenEvento", input.generatedAt) +
      el("TipoEvento", input.eventType) + `<ev:Encadenamiento>${chain}</ev:Encadenamiento>` +
      el("TipoHuella", "01") + el("HuellaEvento", hash) +
      `</ev:Evento></ev:RegistroEvento>`,
  };
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
