export const AEAT_SIF_LR_NAMESPACE =
  "https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroLR.xsd";
export const AEAT_SIF_INFO_NAMESPACE =
  "https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroInformacion.xsd";

export type SifXmlSoftware = {
  producerName: string;
  producerTaxId: string;
  softwareName: string;
  softwareId: string;
  softwareVersion: string;
  installationNumber: string;
};

export type SifXmlPreviousRecord = {
  issuerTaxId: string;
  invoiceNumber: string;
  issueDate: string;
  hash: string;
};

export type SifXmlHeader = {
  issuerLegalName: string;
  issuerTaxId: string;
};

type SifXmlBaseRecord = {
  previousRecord: SifXmlPreviousRecord | null;
  software: SifXmlSoftware;
  generatedAt: string;
  recordHash: string;
};

export type SifXmlRegistration = SifXmlBaseRecord & {
  kind: "REGISTRATION";
  issuerTaxId: string;
  invoiceNumber: string;
  issueDate: string;
  issuerLegalName: string;
  invoiceType: string;
  rectification?: {
    type: "I";
    original: { issuerTaxId: string; invoiceNumber: string; issueDate: string };
  };
  customer: { legalName: string; taxId: string };
  description: string;
  taxLines: Array<{
    taxableBase: string;
    taxRate: string;
    taxAmount: string;
    reverseCharge: false;
  }>;
  taxTotal: string;
  total: string;
};

export type SifXmlCancellation = SifXmlBaseRecord & {
  kind: "CANCELLATION";
  issuerTaxId: string;
  invoiceNumber: string;
  issueDate: string;
};

export type SifXmlRecord = SifXmlRegistration | SifXmlCancellation;

/**
 * Renders the exact AEAT SIF batch shape, but deliberately does not sign it or
 * contact AEAT. Signing/remission is a separate, later concern.
 */
export function renderSifAeatXml(input: {
  header: SifXmlHeader;
  record: SifXmlRecord;
}) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<sfLR:RegFactuSistemaFacturacion xmlns:sfLR="${AEAT_SIF_LR_NAMESPACE}" xmlns:sf="${AEAT_SIF_INFO_NAMESPACE}">`,
    "  <sfLR:Cabecera>",
    "    <sf:ObligadoEmision>",
    element("sf:NombreRazon", input.header.issuerLegalName, 6),
    element("sf:NIF", input.header.issuerTaxId, 6),
    "    </sf:ObligadoEmision>",
    "  </sfLR:Cabecera>",
    "  <sfLR:RegistroFactura>",
    input.record.kind === "REGISTRATION"
      ? registration(input.record)
      : cancellation(input.record),
    "  </sfLR:RegistroFactura>",
    "</sfLR:RegFactuSistemaFacturacion>",
    "",
  ].join("\n");
}

function registration(record: SifXmlRegistration) {
  return [
    "    <sf:RegistroAlta>",
    element("sf:IDVersion", "1.0", 6),
    "      <sf:IDFactura>",
    element("sf:IDEmisorFactura", record.issuerTaxId, 8),
    element("sf:NumSerieFactura", record.invoiceNumber, 8),
    element("sf:FechaExpedicionFactura", record.issueDate, 8),
    "      </sf:IDFactura>",
    element("sf:NombreRazonEmisor", record.issuerLegalName, 6),
    element("sf:TipoFactura", record.invoiceType, 6),
    ...(record.rectification
      ? [
          element("sf:TipoRectificativa", record.rectification.type, 6),
          "      <sf:FacturasRectificadas>",
          "        <sf:IDFacturaRectificada>",
          element("sf:IDEmisorFactura", record.rectification.original.issuerTaxId, 10),
          element("sf:NumSerieFactura", record.rectification.original.invoiceNumber, 10),
          element("sf:FechaExpedicionFactura", record.rectification.original.issueDate, 10),
          "        </sf:IDFacturaRectificada>",
          "      </sf:FacturasRectificadas>",
        ]
      : []),
    element("sf:DescripcionOperacion", record.description, 6),
    "      <sf:Destinatarios>",
    "        <sf:IDDestinatario>",
    element("sf:NombreRazon", record.customer.legalName, 10),
    element("sf:NIF", record.customer.taxId, 10),
    "        </sf:IDDestinatario>",
    "      </sf:Destinatarios>",
    "      <sf:Desglose>",
    ...record.taxLines.flatMap((line) => [
      "        <sf:DetalleDesglose>",
      element("sf:Impuesto", "01", 10),
      element("sf:ClaveRegimen", "01", 10),
      element("sf:CalificacionOperacion", "S1", 10),
      element("sf:TipoImpositivo", line.taxRate, 10),
      element("sf:BaseImponibleOimporteNoSujeto", line.taxableBase, 10),
      element("sf:CuotaRepercutida", line.taxAmount, 10),
      "        </sf:DetalleDesglose>",
    ]),
    "      </sf:Desglose>",
    element("sf:CuotaTotal", record.taxTotal, 6),
    element("sf:ImporteTotal", record.total, 6),
    chain(record, 6),
    software(record.software, 6),
    element("sf:FechaHoraHusoGenRegistro", record.generatedAt, 6),
    element("sf:TipoHuella", "01", 6),
    element("sf:Huella", record.recordHash, 6),
    "    </sf:RegistroAlta>",
  ].join("\n");
}

function cancellation(record: SifXmlCancellation) {
  return [
    "    <sf:RegistroAnulacion>",
    element("sf:IDVersion", "1.0", 6),
    "      <sf:IDFactura>",
    element("sf:IDEmisorFacturaAnulada", record.issuerTaxId, 8),
    element("sf:NumSerieFacturaAnulada", record.invoiceNumber, 8),
    element("sf:FechaExpedicionFacturaAnulada", record.issueDate, 8),
    "      </sf:IDFactura>",
    chain(record, 6),
    software(record.software, 6),
    element("sf:FechaHoraHusoGenRegistro", record.generatedAt, 6),
    element("sf:TipoHuella", "01", 6),
    element("sf:Huella", record.recordHash, 6),
    "    </sf:RegistroAnulacion>",
  ].join("\n");
}

function chain(record: SifXmlBaseRecord, spaces: number) {
  const indent = " ".repeat(spaces);
  if (!record.previousRecord)
    return `${indent}<sf:Encadenamiento>\n${element("sf:PrimerRegistro", "S", spaces + 2)}\n${indent}</sf:Encadenamiento>`;
  return [
    `${indent}<sf:Encadenamiento>`,
    `${indent}  <sf:RegistroAnterior>`,
    element("sf:IDEmisorFactura", record.previousRecord.issuerTaxId, spaces + 4),
    element("sf:NumSerieFactura", record.previousRecord.invoiceNumber, spaces + 4),
    element("sf:FechaExpedicionFactura", record.previousRecord.issueDate, spaces + 4),
    element("sf:Huella", record.previousRecord.hash, spaces + 4),
    `${indent}  </sf:RegistroAnterior>`,
    `${indent}</sf:Encadenamiento>`,
  ].join("\n");
}

function software(value: SifXmlSoftware, spaces: number) {
  const indent = " ".repeat(spaces);
  return [
    `${indent}<sf:SistemaInformatico>`,
    element("sf:NombreRazon", value.producerName, spaces + 2),
    element("sf:NIF", value.producerTaxId, spaces + 2),
    element("sf:NombreSistemaInformatico", value.softwareName, spaces + 2),
    element("sf:IdSistemaInformatico", value.softwareId, spaces + 2),
    element("sf:Version", value.softwareVersion, spaces + 2),
    element("sf:NumeroInstalacion", value.installationNumber, spaces + 2),
    element("sf:TipoUsoPosibleSoloVerifactu", "N", spaces + 2),
    element("sf:TipoUsoPosibleMultiOT", "S", spaces + 2),
    element("sf:IndicadorMultiplesOT", "S", spaces + 2),
    `${indent}</sf:SistemaInformatico>`,
  ].join("\n");
}

function element(name: string, value: string, spaces: number) {
  return `${" ".repeat(spaces)}<${name}>${escapeXml(value)}</${name}>`;
}

export function escapeXml(value: string) {
  return value.replace(/[<>&'\"]/g, (character) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[
      character
    ]!,
  );
}
