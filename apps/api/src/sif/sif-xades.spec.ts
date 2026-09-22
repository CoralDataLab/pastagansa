import { X509Certificate } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import * as forge from "node-forge";
import { renderSifBasicEventXml } from "./sif-event-xml";
import { AEAT_SIF_INFO_NAMESPACE, AEAT_SIF_LR_NAMESPACE, renderSifAeatXml } from "./sif-xml";
import { signSifRecordXml, verifySifRecordSignature } from "./sif-xades";

function testIdentity() {
  const pair = forge.pki.rsa.generateKeyPair(2048);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = pair.publicKey;
  certificate.serialNumber = "01";
  certificate.validity.notBefore = new Date(Date.now() - 86_400_000);
  certificate.validity.notAfter = new Date(Date.now() + 86_400_000);
  certificate.setSubject([{ name: "commonName", value: "SIF test signer" }]);
  certificate.setIssuer([{ name: "commonName", value: "SIF test signer" }]);
  certificate.sign(pair.privateKey, forge.md.sha256.create());
  const certDer = Buffer.from(forge.asn1.toDer(
    forge.pki.certificateToAsn1(certificate),
  ).getBytes(), "binary");
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(pair.privateKey, certificate, "test-pass", {
    algorithm: "3des",
  });
  return {
    p12: Buffer.from(forge.asn1.toDer(p12Asn1).getBytes(), "binary"),
    passphrase: "test-pass",
    expectedCertificateSha256: new X509Certificate(certDer).fingerprint256.replaceAll(":", "").toLowerCase(),
  };
}

describe("AEAT NO VERI*FACTU XAdES-EPES", () => {
  const identity = testIdentity();
  const xml = `<?xml version="1.0" encoding="UTF-8"?>` +
    `<sfLR:RegFactuSistemaFacturacion xmlns:sfLR="${AEAT_SIF_LR_NAMESPACE}" xmlns:sf="${AEAT_SIF_INFO_NAMESPACE}">` +
    `<sfLR:Cabecera><sf:ObligadoEmision><sf:NIF>B12345674</sf:NIF></sf:ObligadoEmision></sfLR:Cabecera>` +
    `<sfLR:RegistroFactura><sf:RegistroAlta><sf:IDVersion>1.0</sf:IDVersion></sf:RegistroAlta></sfLR:RegistroFactura>` +
    `</sfLR:RegFactuSistemaFacturacion>`;

  it("signs only the record node with the AEAT AGE policy and detects tampering", async () => {
    const signed = await signSifRecordXml(xml, identity);
    expect(signed).toContain("<sf:RegistroAlta ");
    expect(signed).toContain("urn:oid:2.16.724.1.3.1.1.2.1.9");
    expect(signed).toContain("G7roucf600+f03r/o0bAOQ6WAs0=");
    expect(signed).toMatch(/<[^>]*Signature[^>]*>/);
    expect(await verifySifRecordSignature(signed)).toBe(true);
    expect(await verifySifRecordSignature(signed.replace(
      "<sf:IDVersion>1.0</sf:IDVersion>", "<sf:IDVersion>2.0</sf:IDVersion>",
    ))).toBe(false);
  });

  it("refuses the wrong mounted certificate", async () => {
    await expect(signSifRecordXml(xml, {
      ...identity, expectedCertificateSha256: "0".repeat(64),
    })).rejects.toThrow("fingerprint does not match");
  });

  it("refuses a certificate without the configured issuing company NIF", async () => {
    await expect(signSifRecordXml(xml, {
      ...identity, expectedIssuerTaxId: "B12345674",
    })).rejects.toThrow("subject does not identify the issuing company");
  });

  it.each(["REGISTRATION", "CANCELLATION"] as const)(
    "keeps a signed %s valid under the AEAT XSD", async (kind) => {
      const software = {
        producerName: "Test Producer", producerTaxId: "B12345674",
        softwareName: "PastaGansa", softwareId: "PG", softwareVersion: "0.1.0",
        installationNumber: "test-1",
      };
      const common = {
        issuerTaxId: "B12345674", invoiceNumber: "F2026-0001", issueDate: "22-09-2026",
        previousRecord: null, software, generatedAt: "2026-09-22T09:00:00+02:00",
        recordHash: "A".repeat(64),
      };
      const full = renderSifAeatXml({
        header: { issuerLegalName: "Test Producer", issuerTaxId: "B12345674" },
        record: kind === "REGISTRATION" ? {
          kind, ...common, issuerLegalName: "Coral Data Lab", invoiceType: "F1",
          customer: { legalName: "Client", taxId: "B76543210" },
          description: "Services", taxLines: [{
            taxableBase: "100.00", taxRate: "21.00", taxAmount: "21.00", reverseCharge: false,
          }],
          taxTotal: "21.00", total: "121.00",
        } : { kind, ...common },
      });
      const signed = await signSifRecordXml(full, identity);
      expect(await verifySifRecordSignature(signed)).toBe(true);
      const validation = spawnSync("xmllint", ["--noout", "--schema", join(__dirname, "xsd", "SuministroLR.xsd"), "-"],
        { input: signed, encoding: "utf8" });
      expect(validation.status).toBe(0);
    },
  );

  it("places a signed event inside Evento and validates its XML against AEAT", async () => {
    const event = renderSifBasicEventXml({
      eventType: "01", producerName: "Test Producer", producerTaxId: "B12345674",
      softwareName: "PastaGansa", softwareId: "PG", softwareVersion: "0.1.0",
      installationNumber: "test-1", issuerName: "Test Issuer", issuerTaxId: "B12345674",
      generatedAt: "2026-09-22T09:00:00+02:00",
    });
    const signed = await signSifRecordXml(event.xml, identity);
    expect(signed).toContain(`<ev:HuellaEvento>${event.hash}</ev:HuellaEvento>`);
    expect(signed).toMatch(/<ev:Evento>[\s\S]*<[^>]*Signature/);
    expect(await verifySifRecordSignature(signed)).toBe(true);
    expect(await verifySifRecordSignature(signed.replace("<ev:TipoEvento>01</ev:TipoEvento>",
      "<ev:TipoEvento>02</ev:TipoEvento>"))).toBe(false);
    const validation = spawnSync("xmllint", ["--noout", "--schema", join(__dirname, "xsd", "EventosSIF.xsd"), "-"],
      { input: signed, encoding: "utf8" });
    expect(validation.status).toBe(0);

    const stop = renderSifBasicEventXml({
      eventType: "02", producerName: "Test Producer", producerTaxId: "B12345674",
      softwareName: "PastaGansa", softwareId: "PG", softwareVersion: "0.1.0",
      installationNumber: "test-1", issuerName: "Test Issuer", issuerTaxId: "B12345674",
      generatedAt: "2026-09-22T10:00:00+02:00",
      previous: { eventType: "01", generatedAt: "2026-09-22T09:00:00+02:00", hash: event.hash },
    });
    const signedStop = await signSifRecordXml(stop.xml, identity);
    expect(signedStop).toContain(`<ev:HuellaEvento>${event.hash}</ev:HuellaEvento>`);
    expect(await verifySifRecordSignature(signedStop)).toBe(true);
    expect(spawnSync("xmllint", ["--noout", "--schema", join(__dirname, "xsd", "EventosSIF.xsd"), "-"],
      { input: signedStop, encoding: "utf8" }).status).toBe(0);
  });
});
