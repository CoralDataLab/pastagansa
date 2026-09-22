import { hashSifEvent, type SifEventHashInput } from "./sif-event-hash";
import { AEAT_SIF_EVENT_NAMESPACE } from "./sif-xades";

export type SifEventReference = { eventType: string; generatedAt: string; hash: string };
export type SifInvoiceReference = {
  issuerTaxId: string; invoiceNumber: string; issueDate: string; hash: string;
};
export type SifEventDetail =
  | { kind: "03" | "05"; recordsChecked: number }
  | { kind: "04" | "06"; anomalyType: string; description: string }
  | { kind: "08"; from: string; to: string; first: SifInvoiceReference;
      last: SifInvoiceReference; registrations: number; taxTotal: string;
      invoiceTotal: string; cancellations: number }
  | { kind: "09"; from: string; to: string; first: SifEventReference;
      last: SifEventReference; count: number }
  | { kind: "10"; counts: { eventType: string; count: number }[];
      firstInvoice?: SifInvoiceReference; lastInvoice?: SifInvoiceReference;
      registrations: number; taxTotal: string; invoiceTotal: string;
      cancellations: number };

export type SifBasicEventInput = Omit<SifEventHashInput, "previousHash" | "eventType"> & {
  eventType: "01" | "02" | "03" | "04" | "05" | "06" | "07" | "08" | "09" | "10";
  producerName: string;
  softwareName: string;
  issuerName: string;
  previous?: SifEventReference | null;
  detail?: SifEventDetail;
};

/** Renders an AEAT event; caller must sign the complete RegistroEvento before storage. */
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
      el("TipoEvento", input.eventType) + renderDetails(input.eventType, input.detail, el) +
      `<ev:Encadenamiento>${chain}</ev:Encadenamiento>` +
      el("TipoHuella", "01") + el("HuellaEvento", hash) +
      `</ev:Evento></ev:RegistroEvento>`,
  };
}

function renderDetails(
  eventType: SifBasicEventInput["eventType"], detail: SifEventDetail | undefined,
  el: (name: string, value: string) => string,
): string {
  if (!detail) {
    if (!["01", "02", "07"].includes(eventType))
      throw new Error(`NO VERI*FACTU event ${eventType} requires details`);
    return "";
  }
  if (detail.kind !== eventType) throw new Error("NO VERI*FACTU event detail type mismatch");
  const count = (value: number, max: number) => {
    if (!Number.isSafeInteger(value) || value < 0 || value > max)
      throw new Error("NO VERI*FACTU event count is out of range");
    return String(value);
  };
  const invoice = (name: string, record: SifInvoiceReference) =>
    `<ev:${name}>${el("IDEmisorFactura", record.issuerTaxId)}` +
    el("NumSerieFactura", record.invoiceNumber) + el("FechaExpedicionFactura", record.issueDate) +
    el("Huella", record.hash) + `</ev:${name}>`;
  const event = (name: string, record: SifEventReference) =>
    `<ev:${name}>${el("TipoEvento", record.eventType)}` +
    el("FechaHoraHusoEvento", record.generatedAt) + el("HuellaEvento", record.hash) +
    `</ev:${name}>`;
  const period = (from: string, to: string) => {
    if (!Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)) ||
        Date.parse(from) > Date.parse(to)) throw new Error("Invalid NO VERI*FACTU export period");
    return el("FechaHoraHusoInicioPeriodoExport", from) + el("FechaHoraHusoFinPeriodoExport", to);
  };
  let body: string;
  let name: string;
  switch (detail.kind) {
    case "03":
      name = "LanzamientoProcesoDeteccionAnomaliasRegFacturacion";
      body = el("RealizadoProcesoSobreIntegridadHuellasRegFacturacion", "S") +
        el("NumeroDeRegistrosFacturacionProcesadosSobreIntegridadHuellas", count(detail.recordsChecked, 9_999_999)) +
        el("RealizadoProcesoSobreIntegridadFirmasRegFacturacion", "S") +
        el("NumeroDeRegistrosFacturacionProcesadosSobreIntegridadFirmas", count(detail.recordsChecked, 9_999_999)) +
        el("RealizadoProcesoSobreTrazabilidadCadenaRegFacturacion", "S") +
        el("NumeroDeRegistrosFacturacionProcesadosSobreTrazabilidadCadena", count(detail.recordsChecked, 9_999_999)) +
        el("RealizadoProcesoSobreTrazabilidadFechasRegFacturacion", "S") +
        el("NumeroDeRegistrosFacturacionProcesadosSobreTrazabilidadFechas", count(detail.recordsChecked, 9_999_999));
      break;
    case "05":
      name = "LanzamientoProcesoDeteccionAnomaliasRegEvento";
      body = el("RealizadoProcesoSobreIntegridadHuellasRegEvento", "S") +
        el("NumeroDeRegistrosEventoProcesadosSobreIntegridadHuellas", count(detail.recordsChecked, 99_999)) +
        el("RealizadoProcesoSobreIntegridadFirmasRegEvento", "S") +
        el("NumeroDeRegistrosEventoProcesadosSobreIntegridadFirmas", count(detail.recordsChecked, 99_999)) +
        el("RealizadoProcesoSobreTrazabilidadCadenaRegEvento", "S") +
        el("NumeroDeRegistrosEventoProcesadosSobreTrazabilidadCadena", count(detail.recordsChecked, 99_999)) +
        el("RealizadoProcesoSobreTrazabilidadFechasRegEvento", "S") +
        el("NumeroDeRegistrosEventoProcesadosSobreTrazabilidadFechas", count(detail.recordsChecked, 99_999));
      break;
    case "04": case "06":
      if (!/^(0[1-9]|1[0-5]|90)$/.test(detail.anomalyType) || detail.description.length > 100)
        throw new Error("Invalid NO VERI*FACTU anomaly detail");
      name = detail.kind === "04" ? "DeteccionAnomaliasRegFacturacion" : "DeteccionAnomaliasRegEvento";
      body = el("TipoAnomalia", detail.anomalyType) + el("OtrosDatosAnomalia", detail.description);
      break;
    case "08":
      name = "ExportacionRegFacturacionPeriodo";
      body = period(detail.from, detail.to) +
        invoice("RegistroFacturacionInicialPeriodo", detail.first) +
        invoice("RegistroFacturacionFinalPeriodo", detail.last) +
        el("NumeroDeRegistrosFacturacionAltaExportados", count(detail.registrations, 999_999_999)) +
        el("SumaCuotaTotalAlta", detail.taxTotal) + el("SumaImporteTotalAlta", detail.invoiceTotal) +
        el("NumeroDeRegistrosFacturacionAnulacionExportados", count(detail.cancellations, 999_999_999)) +
        el("RegistrosFacturacionExportadosDejanDeConservarse", "N");
      break;
    case "09":
      name = "ExportacionRegEventoPeriodo";
      body = period(detail.from, detail.to) + event("RegistroEventoInicialPeriodo", detail.first) +
        event("RegistroEventoFinalPeriodo", detail.last) +
        el("NumeroDeRegEventoExportados", count(detail.count, 9_999_999)) +
        el("RegEventoExportadosDejanDeConservarse", "N");
      break;
    case "10":
      if (!detail.counts.length || detail.counts.length > 20)
        throw new Error("NO VERI*FACTU summary requires one to twenty event types");
      name = "ResumenEventos";
      body = detail.counts.map((entry) => `<ev:TipoEvento>` +
        el("TipoEvento", entry.eventType) + el("NumeroDeEventos", count(entry.count, 9_999)) +
        `</ev:TipoEvento>`).join("") +
        (detail.firstInvoice ? invoice("RegistroFacturacionInicialPeriodo", detail.firstInvoice) : "") +
        (detail.lastInvoice ? invoice("RegistroFacturacionFinalPeriodo", detail.lastInvoice) : "") +
        el("NumeroDeRegistrosFacturacionAltaGenerados", count(detail.registrations, 999_999)) +
        el("SumaCuotaTotalAlta", detail.taxTotal) + el("SumaImporteTotalAlta", detail.invoiceTotal) +
        el("NumeroDeRegistrosFacturacionAnulacionGenerados", count(detail.cancellations, 999_999));
      break;
  }
  return `<ev:DatosPropiosEvento><ev:${name}>${body}</ev:${name}></ev:DatosPropiosEvento>`;
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
