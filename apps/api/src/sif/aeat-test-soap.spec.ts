import { aeatTestSoapEnvelope, parseAeatTestSoapResponse } from "./aeat-test-soap";

const identity = { issuerTaxId: "B12345674", invoiceNumber: "F2026-0001", issueDate: "17-09-2026" };
const soap = "http://schemas.xmlsoap.org/soap/envelope/";
const response = "https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/RespuestaSuministro.xsd";
const info = "https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroInformacion.xsd";

function answer(status: string, globalStatus = "Correcto") {
  return `<e:Envelope xmlns:e="${soap}" xmlns:r="${response}" xmlns:s="${info}"><e:Body>` +
    `<r:RespuestaRegFactuSistemaFacturacion>` +
    `<r:CSV>TEST-CSV</r:CSV><r:DatosPresentacion><s:NIFPresentador>B12345674</s:NIFPresentador>` +
    `<s:TimestampPresentacion>2026-09-17T12:00:00+02:00</s:TimestampPresentacion>` +
    `<s:IdPeticion>123456789</s:IdPeticion></r:DatosPresentacion>` +
    `<r:Cabecera><s:ObligadoEmision><s:NombreRazon>Test</s:NombreRazon><s:NIF>B12345674</s:NIF></s:ObligadoEmision></r:Cabecera>` +
    `<r:TiempoEsperaEnvio>60</r:TiempoEsperaEnvio><r:EstadoEnvio>${globalStatus}</r:EstadoEnvio>` +
    `<r:RespuestaLinea><r:IDFactura><s:IDEmisorFactura>${identity.issuerTaxId}</s:IDEmisorFactura>` +
    `<s:NumSerieFactura>${identity.invoiceNumber}</s:NumSerieFactura>` +
    `<s:FechaExpedicionFactura>${identity.issueDate}</s:FechaExpedicionFactura></r:IDFactura>` +
    `<r:Operacion>Alta</r:Operacion><r:EstadoRegistro>${status}</r:EstadoRegistro>` +
    `${status === "Correcto" ? "" : "<r:CodigoErrorRegistro>2000</r:CodigoErrorRegistro><r:DescripcionErrorRegistro>Detalle</r:DescripcionErrorRegistro>"}` +
    `</r:RespuestaLinea></r:RespuestaRegFactuSistemaFacturacion></e:Body></e:Envelope>`;
}

describe("AEAT test SOAP", () => {
  it("wraps the frozen batch as document-literal SOAP 1.1", () => {
    const xml = aeatTestSoapEnvelope('<?xml version="1.0"?><sfLR:RegFactuSistemaFacturacion xmlns:sfLR="urn:test"/>');
    expect(xml).toContain(`<soapenv:Envelope xmlns:soapenv="${soap}">`);
    expect(xml).toContain("<soapenv:Body><sfLR:RegFactuSistemaFacturacion");
  });

  it.each([
    ["Correcto", "Correcto"],
    ["AceptadoConErrores", "ParcialmenteCorrecto"],
    ["Incorrecto", "Incorrecto"],
  ])("reads %s per-record status and the AEAT wait interval", (status, globalStatus) => {
    expect(parseAeatTestSoapResponse(answer(status, globalStatus), identity)).toMatchObject({
      kind: "RESPONSE", recordStatus: status, globalStatus,
      waitSeconds: 60, csv: "TEST-CSV", requestId: "123456789",
    });
  });

  it("rejects a response for another invoice", () => {
    expect(() => parseAeatTestSoapResponse(answer("Correcto"), { ...identity, invoiceNumber: "other" }))
      .toThrow("does not match");
  });

  it("recognizes a rejected batch without a line response", () => {
    const xml = answer("Incorrecto", "Incorrecto")
      .replace(/<r:RespuestaLinea>.*<\/r:RespuestaLinea>/, "")
      .replace("<r:CSV>TEST-CSV</r:CSV>", "");
    expect(parseAeatTestSoapResponse(xml, identity)).toMatchObject({
      kind: "RESPONSE", globalStatus: "Incorrecto", recordStatus: null,
    });
  });

  it("reads the original request ID and state from a duplicate rejection", () => {
    const xml = answer("Incorrecto", "Incorrecto").replace(
      "</r:RespuestaLinea>",
      "<r:RegistroDuplicado><s:IdPeticionRegistroDuplicado>987654</s:IdPeticionRegistroDuplicado>" +
      "<s:EstadoRegistroDuplicado>AceptadaConErrores</s:EstadoRegistroDuplicado>" +
      "<s:CodigoErrorRegistro>2004</s:CodigoErrorRegistro>" +
      "<s:DescripcionErrorRegistro>Aviso original</s:DescripcionErrorRegistro>" +
      "</r:RegistroDuplicado></r:RespuestaLinea>",
    );
    expect(parseAeatTestSoapResponse(xml, identity)).toMatchObject({
      recordStatus: "Incorrecto", duplicate: {
        requestId: "987654", status: "AceptadaConErrores", errorCode: "2004",
        errorDescription: "Aviso original",
      },
    });
  });

  it("distinguishes a SOAP fault from a record rejection", () => {
    const xml = `<e:Envelope xmlns:e="${soap}"><e:Body><e:Fault>` +
      `<faultcode>e:Server</faultcode><faultstring>Busy</faultstring>` +
      `</e:Fault></e:Body></e:Envelope>`;
    expect(parseAeatTestSoapResponse(xml, identity)).toEqual({
      kind: "FAULT", faultCode: "e:Server", faultString: "Busy",
    });
  });

  it("rejects DTDs and malformed SOAP", () => {
    expect(() => parseAeatTestSoapResponse(`<!DOCTYPE foo><foo/>`, identity)).toThrow("DTD");
    expect(() => parseAeatTestSoapResponse("<foo/>", identity)).toThrow("SOAP 1.1");
  });
});
