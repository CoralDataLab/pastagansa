import { aeatTestQueryEnvelope, queryConfirmsDuplicate } from "./aeat-test-query";

const soap = "http://schemas.xmlsoap.org/soap/envelope/";
const response = "https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/RespuestaConsultaLR.xsd";
const info = "https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroInformacion.xsd";
const identity = {
  issuerName: "Test & Sons, S.L.", issuerTaxId: "B12345674",
  invoiceNumber: "F2026-0001", issueDate: "18-09-2026",
  operationDate: new Date("2026-08-31T00:00:00.000Z"),
};
const hash = "A".repeat(64);

function answer({ requestId = "123456", fingerprint = hash, invoiceNumber = identity.invoiceNumber,
  status = "Correcto", previousHash = "" } = {}) {
  return `<e:Envelope xmlns:e="${soap}" xmlns:r="${response}" xmlns:s="${info}"><e:Body>` +
    `<r:RespuestaConsultaFactuSistemaFacturacion><r:ResultadoConsulta>ConDatos</r:ResultadoConsulta>` +
    `<r:RegistroRespuestaConsultaFactuSistemaFacturacion>` +
    `<r:IDFactura><s:IDEmisorFactura>${identity.issuerTaxId}</s:IDEmisorFactura>` +
    `<s:NumSerieFactura>${invoiceNumber}</s:NumSerieFactura>` +
    `<s:FechaExpedicionFactura>${identity.issueDate}</s:FechaExpedicionFactura></r:IDFactura>` +
    `<r:DatosRegistroFacturacion>${previousHash ? `<r:Encadenamiento><r:RegistroAnterior><s:Huella>${previousHash}</s:Huella></r:RegistroAnterior></r:Encadenamiento>` : ""}` +
    `<r:Huella>${fingerprint}</r:Huella></r:DatosRegistroFacturacion>` +
    `<r:DatosPresentacion><s:IdPeticion>${requestId}</s:IdPeticion></r:DatosPresentacion>` +
    `<r:EstadoRegistro><r:EstadoRegistro>${status}</r:EstadoRegistro></r:EstadoRegistro>` +
    `</r:RegistroRespuestaConsultaFactuSistemaFacturacion></r:RespuestaConsultaFactuSistemaFacturacion>` +
    `</e:Body></e:Envelope>`;
}

describe("AEAT test duplicate consultation", () => {
  it("queries the operation month and escapes the issuer name", () => {
    const xml = aeatTestQueryEnvelope(identity);
    expect(xml).toContain("<s:NombreRazon>Test &amp; Sons, S.L.</s:NombreRazon>");
    expect(xml).toContain("<s:Periodo>08</s:Periodo>");
    expect(xml).toContain("<q:NumSerieFactura>F2026-0001</q:NumSerieFactura>");
  });

  it("confirms only the exact identity, hash, original request and recorded state", () => {
    expect(queryConfirmsDuplicate(answer(), identity, hash, "123456", "Correcta")).toBe(true);
    expect(queryConfirmsDuplicate(answer({ status: "Correcta" }), identity, hash, "123456", "Correcta")).toBe(true);
    expect(queryConfirmsDuplicate(answer({ previousHash: "B".repeat(64) }), identity, hash, "123456", "Correcta")).toBe(true);
    expect(queryConfirmsDuplicate(answer({ fingerprint: "B".repeat(64) }), identity, hash, "123456", "Correcta")).toBe(false);
    expect(queryConfirmsDuplicate(answer({ requestId: "other" }), identity, hash, "123456", "Correcta")).toBe(false);
    expect(queryConfirmsDuplicate(answer({ invoiceNumber: "other" }), identity, hash, "123456", "Correcta")).toBe(false);
    expect(queryConfirmsDuplicate(answer({ status: "Anulado" }), identity, hash, "123456", "Correcta")).toBe(false);
    expect(queryConfirmsDuplicate(answer({ status: "AceptadoConErrores" }), identity, hash, "123456", "Correcta")).toBe(false);
  });

  it("rejects malformed and DTD responses", () => {
    expect(() => queryConfirmsDuplicate("<foo/>", identity, hash, "123456", "Correcta")).toThrow("SOAP 1.1");
    expect(() => queryConfirmsDuplicate("<!DOCTYPE foo><foo/>", identity, hash, "123456", "Correcta")).toThrow("DTD");
  });
});
