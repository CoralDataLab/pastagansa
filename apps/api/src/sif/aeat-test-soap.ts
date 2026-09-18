import { DOMParser, type Element as XmlElement } from "@xmldom/xmldom";
import { AEAT_SIF_LR_NAMESPACE } from "./sif-xml";

const SOAP_NAMESPACE = "http://schemas.xmlsoap.org/soap/envelope/";
const RESPONSE_NAMESPACE =
  "https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/RespuestaSuministro.xsd";
const INFO_NAMESPACE =
  "https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroInformacion.xsd";

export type AeatTestResult = {
  kind: "RESPONSE";
  globalStatus: "Correcto" | "ParcialmenteCorrecto" | "Incorrecto";
  recordStatus: "Correcto" | "AceptadoConErrores" | "Incorrecto" | null;
  waitSeconds: number;
  csv: string | null;
  requestId: string | null;
  errorCode: string | null;
  errorDescription: string | null;
  duplicate: { requestId: string; status: string; errorCode: string | null; errorDescription: string | null } | null;
} | {
  kind: "FAULT";
  faultCode: string;
  faultString: string;
};

export function aeatTestSoapEnvelope(batchXml: string): string {
  const body = batchXml.replace(/^<\?xml[^>]*\?>\s*/, "").trim();
  if (!body.startsWith("<sfLR:RegFactuSistemaFacturacion") || /<!DOCTYPE|<!ENTITY/i.test(body))
    throw new Error("AEAT test transport requires a generated SIF batch XML");
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<soapenv:Envelope xmlns:soapenv="${SOAP_NAMESPACE}">` +
    `<soapenv:Header/><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`;
}

export function parseAeatTestSoapResponse(xml: string, expected: {
  issuerTaxId: string;
  invoiceNumber: string;
  issueDate: string;
}): AeatTestResult {
  if (xml.length > 1_000_000 || /<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error("AEAT response is too large or contains a DTD");
  const document = new DOMParser({
    onError: (level, message) => {
      if (level !== "warning") throw new Error(`Invalid AEAT XML: ${message}`);
    },
  }).parseFromString(xml, "text/xml");
  const envelope = document.documentElement;
  if (!envelope || envelope.namespaceURI !== SOAP_NAMESPACE || envelope.localName !== "Envelope")
    throw new Error("AEAT response is not a SOAP 1.1 envelope");
  const body = first(envelope, SOAP_NAMESPACE, "Body");
  if (!body) throw new Error("AEAT SOAP body is missing");
  const fault = first(body, SOAP_NAMESPACE, "Fault");
  if (fault) {
    const faultCode = text(fault, null, "faultcode");
    const faultString = text(fault, null, "faultstring");
    if (!faultCode || !faultString) throw new Error("AEAT SOAP fault is incomplete");
    return { kind: "FAULT", faultCode, faultString };
  }
  const response = first(body, RESPONSE_NAMESPACE, "RespuestaRegFactuSistemaFacturacion");
  if (!response) throw new Error("AEAT SOAP response element is missing");
  const globalStatus = text(response, RESPONSE_NAMESPACE, "EstadoEnvio");
  if (!isGlobalStatus(globalStatus)) throw new Error("AEAT global status is invalid");
  const waitRaw = text(response, RESPONSE_NAMESPACE, "TiempoEsperaEnvio");
  const waitSeconds = Number(waitRaw);
  if (!waitRaw || !Number.isSafeInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 86_400)
    throw new Error("AEAT wait time is invalid");
  const lines = response.getElementsByTagNameNS(RESPONSE_NAMESPACE, "RespuestaLinea");
  if (lines.length === 0 && globalStatus === "Incorrecto")
    return {
      kind: "RESPONSE", globalStatus, recordStatus: null, waitSeconds,
      csv: null, requestId: null, errorCode: null, errorDescription: null, duplicate: null,
    };
  if (lines.length !== 1) throw new Error("AEAT response must contain exactly one line");
  const line = lines.item(0)!;
  const identity = first(line, RESPONSE_NAMESPACE, "IDFactura");
  if (!identity ||
      text(identity, INFO_NAMESPACE, "IDEmisorFactura") !== expected.issuerTaxId ||
      text(identity, INFO_NAMESPACE, "NumSerieFactura") !== expected.invoiceNumber ||
      text(identity, INFO_NAMESPACE, "FechaExpedicionFactura") !== expected.issueDate)
    throw new Error("AEAT response invoice identity does not match the submitted record");
  const recordStatus = text(line, RESPONSE_NAMESPACE, "EstadoRegistro");
  if (!isRecordStatus(recordStatus)) throw new Error("AEAT record status is invalid");
  const presentation = first(response, RESPONSE_NAMESPACE, "DatosPresentacion");
  const duplicate = first(line, RESPONSE_NAMESPACE, "RegistroDuplicado");
  const duplicateRequestId = duplicate ? text(duplicate, INFO_NAMESPACE, "IdPeticionRegistroDuplicado") : "";
  const duplicateStatus = duplicate ? text(duplicate, INFO_NAMESPACE, "EstadoRegistroDuplicado") : "";
  return {
    kind: "RESPONSE",
    globalStatus,
    recordStatus,
    waitSeconds,
    csv: text(response, RESPONSE_NAMESPACE, "CSV") || null,
    requestId: presentation ? text(presentation, INFO_NAMESPACE, "IdPeticion") || null : null,
    errorCode: text(line, RESPONSE_NAMESPACE, "CodigoErrorRegistro") || null,
    errorDescription: text(line, RESPONSE_NAMESPACE, "DescripcionErrorRegistro") || null,
    duplicate: duplicateRequestId && duplicateStatus
      ? {
        requestId: duplicateRequestId,
        status: duplicateStatus,
        errorCode: text(duplicate!, INFO_NAMESPACE, "CodigoErrorRegistro") || null,
        errorDescription: text(duplicate!, INFO_NAMESPACE, "DescripcionErrorRegistro") || null,
      }
      : null,
  };
}

function first(parent: XmlElement, namespace: string | null, localName: string): XmlElement | null {
  if (namespace) return parent.getElementsByTagNameNS(namespace, localName).item(0);
  return Array.from(parent.childNodes).find(
    (node): node is XmlElement => node.nodeType === 1 && (node as XmlElement).localName === localName,
  ) ?? null;
}

function text(parent: XmlElement, namespace: string | null, localName: string): string {
  return first(parent, namespace, localName)?.textContent?.trim() ?? "";
}

function isGlobalStatus(value: string): value is "Correcto" | "ParcialmenteCorrecto" | "Incorrecto" {
  return ["Correcto", "ParcialmenteCorrecto", "Incorrecto"].includes(value);
}

function isRecordStatus(value: string): value is "Correcto" | "AceptadoConErrores" | "Incorrecto" {
  return ["Correcto", "AceptadoConErrores", "Incorrecto"].includes(value);
}
