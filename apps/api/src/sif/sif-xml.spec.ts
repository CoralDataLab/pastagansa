import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { renderSifAeatXml } from "./sif-xml";

const schema = join(__dirname, "xsd", "SuministroLR.xsd");
function expectValidAeatXml(xml: string) {
  const result = spawnSync("xmllint", ["--noout", "--schema", schema, "-"], { input: xml, encoding: "utf8" });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toContain("validates");
}

const software = {
  producerName: "Coral Data Lab, S.L.",
  producerTaxId: "B12345674",
  softwareName: "PastaGansa",
  softwareId: "PG",
  softwareVersion: "0.1.0",
  installationNumber: "staging-1",
};

describe("AEAT SIF XML", () => {
  const header = { issuerLegalName: "Acme & Sons", issuerTaxId: "B12345674" };

  it("renders an escaped registration in the official batch namespaces", () => {
    const xml = renderSifAeatXml({
      header,
      record: {
        kind: "REGISTRATION",
        issuerTaxId: "B12345674",
        invoiceNumber: "F2026-0001",
        issueDate: "16-09-2026",
        issuerLegalName: header.issuerLegalName,
        invoiceType: "F1",
        customer: { legalName: "Client <one>", taxId: "B76543210" },
        description: "Services & support",
        taxLines: [{ taxableBase: "100.00", taxRate: "21.00", taxAmount: "21.00", reverseCharge: false }],
        taxTotal: "21.00",
        total: "121.00",
        previousRecord: null,
        software,
        generatedAt: "2026-09-16T12:00:00+02:00",
        recordHash: "A".repeat(64),
      },
    });

    expect(xml).toContain('xmlns:sfLR="https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroLR.xsd"');
    expect(xml).toContain("<sf:PrimerRegistro>S</sf:PrimerRegistro>");
    expect(xml).toContain("<sf:NombreRazon>Acme &amp; Sons</sf:NombreRazon>");
    expect(xml).toContain("<sf:NombreRazon>Client &lt;one&gt;</sf:NombreRazon>");
    expect(xml).toContain("<sf:DescripcionOperacion>Services &amp; support</sf:DescripcionOperacion>");
    expect(xml).toContain("<sf:TipoHuella>01</sf:TipoHuella>");
    expectValidAeatXml(xml);
  });

  it("renders cancellation identity and the previous chain record", () => {
    const xml = renderSifAeatXml({
      header,
      record: {
        kind: "CANCELLATION",
        issuerTaxId: "B12345674",
        invoiceNumber: "F2026-0001",
        issueDate: "16-09-2026",
        previousRecord: { issuerTaxId: "B12345674", invoiceNumber: "F2026-0001", issueDate: "16-09-2026", hash: "B".repeat(64) },
        software,
        generatedAt: "2026-09-16T12:01:00+02:00",
        recordHash: "C".repeat(64),
      },
    });

    expect(xml).toContain("<sf:RegistroAnulacion>");
    expect(xml).toContain("<sf:IDEmisorFacturaAnulada>B12345674</sf:IDEmisorFacturaAnulada>");
    expect(xml).toContain("<sf:Huella>" + "B".repeat(64) + "</sf:Huella>");
    expect(xml).toContain("<sf:Huella>" + "C".repeat(64) + "</sf:Huella>");
    expectValidAeatXml(xml);
  });

  it("renders an accepted-with-errors subsanation in XSD order", () => {
    const xml = renderSifAeatXml({
      header,
      record: {
        kind: "REGISTRATION", subsanacion: "S",
        issuerTaxId: "B12345674", invoiceNumber: "F2026-0001",
        issueDate: "16-09-2026", issuerLegalName: header.issuerLegalName,
        invoiceType: "F1", customer: { legalName: "Client", taxId: "B76543210" },
        description: "Services", taxLines: [{ taxableBase: "100.00", taxRate: "21.00", taxAmount: "21.00", reverseCharge: false }],
        taxTotal: "21.00", total: "121.00", previousRecord: null,
        software, generatedAt: "2026-09-16T12:00:00+02:00", recordHash: "A".repeat(64),
      },
    });
    expect(xml).toMatch(/<sf:NombreRazonEmisor>.*<\/sf:NombreRazonEmisor>\s*<sf:Subsanacion>S<\/sf:Subsanacion>\s*<sf:TipoFactura>/);
    expect(xml).not.toContain("<sf:RechazoPrevio>");
    expectValidAeatXml(xml);
  });

  it("validates an alta after a definitive rejection with RechazoPrevio=X", () => {
    const xml = renderSifAeatXml({
      header,
      record: {
        kind: "REGISTRATION", subsanacion: "S", rechazoPrevio: "X",
        issuerTaxId: "B12345674", invoiceNumber: "F2026-0001",
        issueDate: "16-09-2026", issuerLegalName: header.issuerLegalName,
        invoiceType: "F1", customer: { legalName: "Client", taxId: "B76543210" },
        description: "Services", taxLines: [{ taxableBase: "100.00", taxRate: "21.00", taxAmount: "21.00", reverseCharge: false }],
        taxTotal: "21.00", total: "121.00",
        previousRecord: { issuerTaxId: "B12345674", invoiceNumber: "F2026-0001", issueDate: "16-09-2026", hash: "A".repeat(64) },
        software, generatedAt: "2026-09-16T12:01:00+02:00", recordHash: "B".repeat(64),
      },
    });
    expect(xml).toMatch(/<sf:Subsanacion>S<\/sf:Subsanacion>\s*<sf:RechazoPrevio>X<\/sf:RechazoPrevio>/);
    expectValidAeatXml(xml);
  });

  it("marks cancellation of a confirmed rejected alta as having no prior AEAT registration", () => {
    const xml = renderSifAeatXml({
      header,
      record: {
        kind: "CANCELLATION", sinRegistroPrevio: "S",
        issuerTaxId: "B12345674", invoiceNumber: "F2026-0001", issueDate: "16-09-2026",
        previousRecord: null, software,
        generatedAt: "2026-09-16T12:01:00+02:00", recordHash: "C".repeat(64),
      },
    });
    expect(xml).toContain("<sf:SinRegistroPrevio>S</sf:SinRegistroPrevio>");
    expect(xml).not.toContain("<sf:RechazoPrevio>");
    expectValidAeatXml(xml);
  });

  it("renders an R4 difference rectification with the original invoice identity", () => {
    const xml = renderSifAeatXml({
      header,
      record: {
        kind: "REGISTRATION",
        issuerTaxId: "B12345674",
        invoiceNumber: "R2026-0001",
        issueDate: "16-09-2026",
        issuerLegalName: header.issuerLegalName,
        invoiceType: "R4",
        rectification: {
          type: "I",
          original: {
            issuerTaxId: "B12345674",
            invoiceNumber: "F2026-0001",
            issueDate: "15-09-2026",
          },
        },
        customer: { legalName: "Client", taxId: "B76543210" },
        description: "Partial refund",
        taxLines: [{ taxableBase: "-100.00", taxRate: "21.00", taxAmount: "-21.00", reverseCharge: false }],
        taxTotal: "-21.00",
        total: "-121.00",
        previousRecord: null,
        software,
        generatedAt: "2026-09-16T12:00:00+02:00",
        recordHash: "A".repeat(64),
      },
    });

    expect(xml).toContain("<sf:TipoFactura>R4</sf:TipoFactura>");
    expect(xml).toContain("<sf:TipoRectificativa>I</sf:TipoRectificativa>");
    expect(xml).toContain("<sf:NumSerieFactura>F2026-0001</sf:NumSerieFactura>");
    expect(xml).toContain("<sf:BaseImponibleOimporteNoSujeto>-100.00</sf:BaseImponibleOimporteNoSujeto>");
    expect(xml).not.toContain("<sf:ImporteRectificacion>");
    expectValidAeatXml(xml);
  });

  it("places the original operation date in an R1 difference rectification", () => {
    const xml = renderSifAeatXml({
      header,
      record: {
        kind: "REGISTRATION", issuerTaxId: "B12345674", invoiceNumber: "R2026-0002",
        issueDate: "18-09-2026", issuerLegalName: header.issuerLegalName,
        invoiceType: "R1", operationDate: "10-09-2026",
        rectification: { type: "I", original: {
          issuerTaxId: "B12345674", invoiceNumber: "F2026-0002", issueDate: "11-09-2026",
        } },
        customer: { legalName: "Client", taxId: "B76543210" },
        description: "Returned goods", taxLines: [{
          taxableBase: "-100.00", taxRate: "21.00", taxAmount: "-21.00", reverseCharge: false,
        }],
        taxTotal: "-21.00", total: "-121.00", previousRecord: null,
        software, generatedAt: "2026-09-18T12:00:00+02:00", recordHash: "A".repeat(64),
      },
    });
    expect(xml).toMatch(/<sf:FacturasRectificadas>[\s\S]*<\/sf:FacturasRectificadas>\s*<sf:FechaOperacion>10-09-2026<\/sf:FechaOperacion>\s*<sf:DescripcionOperacion>/);
    expectValidAeatXml(xml);
  });

  it.each(["R2", "R3"])("validates a VAT-only %s difference with zero base and negative VAT", (invoiceType) => {
    const xml = renderSifAeatXml({
      header,
      record: {
        kind: "REGISTRATION", issuerTaxId: "B12345674", invoiceNumber: "R2026-0003",
        issueDate: "18-09-2026", issuerLegalName: header.issuerLegalName,
        invoiceType, operationDate: "08-09-2026",
        rectification: { type: "I", original: {
          issuerTaxId: "B12345674", invoiceNumber: "F2026-0003", issueDate: "09-09-2026",
        } },
        customer: { legalName: "Client", taxId: "B76543210" },
        description: "Ajuste de cuota IVA por impago", taxLines: [{
          taxableBase: "0.00", taxRate: "21.00", taxAmount: "-210.00", reverseCharge: false,
        }],
        taxTotal: "-210.00", total: "-210.00", previousRecord: null,
        software, generatedAt: "2026-09-18T12:00:00+02:00", recordHash: "A".repeat(64),
      },
    });
    expect(xml).toContain(`<sf:TipoFactura>${invoiceType}</sf:TipoFactura>`);
    expect(xml).toContain("<sf:FechaOperacion>08-09-2026</sf:FechaOperacion>");
    expect(xml).toContain("<sf:BaseImponibleOimporteNoSujeto>0.00</sf:BaseImponibleOimporteNoSujeto>");
    expect(xml).toContain("<sf:CuotaRepercutida>-210.00</sf:CuotaRepercutida>");
    expect(xml).toContain("<sf:ImporteTotal>-210.00</sf:ImporteTotal>");
    expectValidAeatXml(xml);
  });
});
