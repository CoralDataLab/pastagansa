import { DOMParser, type Element as XmlElement } from "@xmldom/xmldom";

const SOAP = "http://schemas.xmlsoap.org/soap/envelope/";
const QUERY = "https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/ConsultaLR.xsd";
const RESPONSE = "https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/RespuestaConsultaLR.xsd";
const INFO = "https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroInformacion.xsd";

export type AeatTestQueryIdentity = {
  issuerName: string;
  issuerTaxId: string;
  invoiceNumber: string;
  issueDate: string;
  operationDate: Date;
};

// The consultation is only used to verify an AEAT duplicate. It never changes a
// frozen SIF record, and its response cannot substitute for the original CSV.
export function aeatTestQueryEnvelope(identity: AeatTestQueryIdentity): string {
  const year = identity.operationDate.getUTCFullYear();
  const month = String(identity.operationDate.getUTCMonth() + 1).padStart(2, "0");
  const escape = (value: string) => value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[char]!);
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<e:Envelope xmlns:e="${SOAP}" xmlns:q="${QUERY}" xmlns:s="${INFO}">` +
    `<e:Header/><e:Body><q:ConsultaFactuSistemaFacturacion>` +
    `<q:Cabecera><s:IDVersion>1.0</s:IDVersion><s:ObligadoEmision>` +
    `<s:NombreRazon>${escape(identity.issuerName)}</s:NombreRazon>` +
    `<s:NIF>${escape(identity.issuerTaxId)}</s:NIF>` +
    `</s:ObligadoEmision></q:Cabecera><q:FiltroConsulta>` +
    `<q:PeriodoImputacion><s:Ejercicio>${year}</s:Ejercicio><s:Periodo>${month}</s:Periodo></q:PeriodoImputacion>` +
    `<q:NumSerieFactura>${escape(identity.invoiceNumber)}</q:NumSerieFactura>` +
    `<q:FechaExpedicionFactura><s:FechaExpedicionFactura>${escape(identity.issueDate)}</s:FechaExpedicionFactura></q:FechaExpedicionFactura>` +
    `</q:FiltroConsulta></q:ConsultaFactuSistemaFacturacion></e:Body></e:Envelope>`;
}

export function queryConfirmsDuplicate(
  xml: string,
  expected: Pick<AeatTestQueryIdentity, "issuerTaxId" | "invoiceNumber" | "issueDate">,
  recordHash: string,
  duplicateRequestId: string,
  duplicateStatus: "Correcta" | "AceptadaConErrores",
): boolean {
  if (xml.length > 1_000_000 || /<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error("AEAT consultation response is too large or contains a DTD");
  const document = new DOMParser({
    onError: (level, message) => {
      if (level !== "warning") throw new Error(`Invalid AEAT consultation XML: ${message}`);
    },
  }).parseFromString(xml, "text/xml");
  const envelope = document.documentElement;
  if (!envelope || envelope.namespaceURI !== SOAP || envelope.localName !== "Envelope")
    throw new Error("AEAT consultation is not a SOAP 1.1 envelope");
  const body = envelope.getElementsByTagNameNS(SOAP, "Body").item(0);
  const response = body?.getElementsByTagNameNS(RESPONSE, "RespuestaConsultaFactuSistemaFacturacion").item(0);
  if (!response) throw new Error("AEAT consultation response is missing");
  if (value(response, RESPONSE, "ResultadoConsulta") !== "ConDatos") return false;
  const rows = response.getElementsByTagNameNS(RESPONSE, "RegistroRespuestaConsultaFactuSistemaFacturacion");
  for (let index = 0; index < rows.length; index++) {
    const row = rows.item(index)!;
    const invoice = row.getElementsByTagNameNS(RESPONSE, "IDFactura").item(0);
    const details = row.getElementsByTagNameNS(RESPONSE, "DatosRegistroFacturacion").item(0);
    const presentation = row.getElementsByTagNameNS(RESPONSE, "DatosPresentacion").item(0);
    const state = row.getElementsByTagNameNS(RESPONSE, "EstadoRegistro").item(0);
    if (invoice && details && presentation && state &&
        value(invoice, INFO, "IDEmisorFactura") === expected.issuerTaxId &&
        value(invoice, INFO, "NumSerieFactura") === expected.invoiceNumber &&
        value(invoice, INFO, "FechaExpedicionFactura") === expected.issueDate &&
        value(details, RESPONSE, "Huella").toUpperCase() === recordHash.toUpperCase() &&
        value(presentation, INFO, "IdPeticion") === duplicateRequestId &&
        (duplicateStatus === "Correcta"
          ? ["Correcto", "Correcta"]
          : ["AceptadoConErrores", "AceptadaConErrores"])
          .includes(value(state, RESPONSE, "EstadoRegistro")))
      return true;
  }
  return false;
}

function value(parent: XmlElement, namespace: string, name: string): string {
  return Array.from(parent.childNodes)
    .find((node) => node.nodeType === 1 &&
      (node as XmlElement).namespaceURI === namespace &&
      (node as XmlElement).localName === name)
    ?.textContent?.trim() ?? "";
}
