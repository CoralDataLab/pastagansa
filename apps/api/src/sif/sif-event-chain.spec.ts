import { X509Certificate, createHash } from "node:crypto";
import * as forge from "node-forge";
import { verifySifEventChain, verifySifEventTail } from "./sif-event-chain";
import { renderSifBasicEventXml } from "./sif-event-xml";
import { signSifRecordXml } from "./sif-xades";

async function fixtures() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "02";
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + 86_400_000);
  cert.setSubject([{ name: "commonName", value: "Event test signer" }]);
  cert.setIssuer([{ name: "commonName", value: "Event test signer" }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, cert, "test-pass", { algorithm: "3des" });
  const identity = {
    p12: Buffer.from(forge.asn1.toDer(p12).getBytes(), "binary"),
    passphrase: "test-pass",
    expectedCertificateSha256: new X509Certificate(Buffer.from(
      forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), "binary",
    )).fingerprint256.replaceAll(":", "").toLowerCase(),
  };
  const common = {
    producerName: "Test Producer", producerTaxId: "B12345674",
    softwareName: "PastaGansa", softwareId: "PG", softwareVersion: "0.1.0",
    installationNumber: "test-1", issuerName: "Test Issuer", issuerTaxId: "B12345674",
  };
  const firstAt = "2026-09-22T09:00:00+02:00";
  const first = renderSifBasicEventXml({ ...common, eventType: "01", generatedAt: firstAt });
  const secondAt = "2026-09-22T10:00:00+02:00";
  const second = renderSifBasicEventXml({ ...common, eventType: "02", generatedAt: secondAt,
    previous: { eventType: "01", generatedAt: firstAt, hash: first.hash } });
  const signedFirst = await signSifRecordXml(first.xml, identity);
  const signedSecond = await signSifRecordXml(second.xml, identity);
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  return [{
    id: "11111111-1111-4111-8111-111111111111", eventType: "01", chainPosition: 1n,
    generatedAt: new Date(firstAt), previousEventId: null, previousEventHash: null,
    eventHash: first.hash, hashInput: {
      producerTaxId: common.producerTaxId, softwareId: common.softwareId,
      softwareVersion: common.softwareVersion, installationNumber: common.installationNumber,
      issuerTaxId: common.issuerTaxId, eventType: "01", previousHash: null, generatedAt: firstAt,
    }, signedXml: signedFirst, signedXmlSha256: sha(signedFirst),
  }, {
    id: "22222222-2222-4222-8222-222222222222", eventType: "02", chainPosition: 2n,
    generatedAt: new Date(secondAt),
    previousEventId: "11111111-1111-4111-8111-111111111111", previousEventHash: first.hash,
    eventHash: second.hash, hashInput: {
      producerTaxId: common.producerTaxId, softwareId: common.softwareId,
      softwareVersion: common.softwareVersion, installationNumber: common.installationNumber,
      issuerTaxId: common.issuerTaxId, eventType: "02", previousHash: first.hash, generatedAt: secondAt,
    }, signedXml: signedSecond, signedXmlSha256: sha(signedSecond),
  }];
}

describe("NO VERI*FACTU event chain verification", () => {
  it("verifies links, AEAT hashes, frozen bytes, signed XML and field agreement", async () => {
    const records = await fixtures();
    expect(await verifySifEventChain(records)).toEqual({
      valid: true, recordsChecked: 2, firstInvalid: null,
    });
    expect((await verifySifEventTail(records[1], records[0])).valid).toBe(true);
    expect((await verifySifEventTail(records[1], null)).firstInvalid?.reason)
      .toBe("Unexpected event chain position");
    const corrupted = [{ ...records[0], signedXml: records[0].signedXml.replace(
      "Test Issuer", "Other Issuer",
    ) }, records[1]];
    expect((await verifySifEventChain(corrupted)).firstInvalid?.reason).toBe("Signed event XML bytes changed");
    corrupted[0].signedXmlSha256 = createHash("sha256").update(corrupted[0].signedXml).digest("hex");
    expect((await verifySifEventChain(corrupted)).firstInvalid?.reason).toBe("Event XML signature or policy is invalid");
    expect((await verifySifEventChain([records[0], {
      ...records[1], previousEventHash: "0".repeat(64),
    }])).firstInvalid?.reason).toBe("Previous event reference does not match");
  });
});
