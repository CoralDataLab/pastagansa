import { createPrivateKey, createPublicKey, type KeyObject, X509Certificate, webcrypto } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DOMImplementation, DOMParser, XMLSerializer } from "@xmldom/xmldom";
import * as xadesjs from "xadesjs";
import { SignedXml as XmlSignedXml, XmlDsigExcC14NTransform, type Signature } from "xmldsigjs";
import * as xpath from "xpath";
import { AEAT_SIF_INFO_NAMESPACE, AEAT_SIF_LR_NAMESPACE } from "./sif-xml";

const POLICY_ID = "urn:oid:2.16.724.1.3.1.1.2.1.9";
const POLICY_URL = "https://sede.administracion.gob.es/politica_de_firma_anexo_1.pdf";
const POLICY_DIGEST = "G7roucf600+f03r/o0bAOQ6WAs0=";
const XMLDSIG_NAMESPACE = "http://www.w3.org/2000/09/xmldsig#";
const XADES_NAMESPACE = "http://uri.etsi.org/01903/v1.3.2#";
export const AEAT_SIF_EVENT_NAMESPACE =
  "https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/EventosSIF.xsd";

xadesjs.setNodeDependencies({ DOMImplementation, DOMParser, XMLSerializer, xpath });
xadesjs.Application.setEngine("NodeJS", webcrypto as Crypto);

class SifSignedXml extends xadesjs.SignedXml {
  protected override async ApplySignOptions(
    signature: Signature, algorithm: Algorithm, key: CryptoKey, options: xadesjs.OptionsXAdES,
  ) {
    await super.ApplySignOptions(signature, algorithm, key, options);
    for (const reference of signature.SignedInfo.References.GetIterator())
      if (reference.Type === "http://uri.etsi.org/01903#SignedProperties")
        reference.Transforms.Add(new XmlDsigExcC14NTransform());
  }
}

export type SifSigningIdentity = {
  p12: Buffer;
  passphrase: string;
  expectedCertificateSha256: string;
  expectedIssuerTaxId?: string;
};

export function validateSifSigningIdentity(identity: SifSigningIdentity): void {
  openIdentity(identity);
}

/** Signs the AEAT record node, preserving the enclosing batch as an unsigned envelope. */
export async function signSifRecordXml(xml: string, identity: SifSigningIdentity): Promise<string> {
  const { privateKey, certificate } = openIdentity(identity);
  const document = xadesjs.Parse(xml);
  const records = [
    ...["RegistroAlta", "RegistroAnulacion"]
      .flatMap((name) => Array.from(document.getElementsByTagNameNS(AEAT_SIF_INFO_NAMESPACE, name))),
    ...Array.from(document.getElementsByTagNameNS(AEAT_SIF_EVENT_NAMESPACE, "RegistroEvento")),
  ];
  if (records.length !== 1) throw new Error("Exactly one AEAT record node is required for signing");
  const record = records[0];
  if (record.getElementsByTagNameNS(XMLDSIG_NAMESPACE, "Signature").length)
    throw new Error("AEAT record is already signed");
  const recordDocument = xadesjs.Parse(new XMLSerializer().serializeToString(
    record as unknown as Parameters<XMLSerializer["serializeToString"]>[0],
  ));
  // Inclusive canonicalization of SignedProperties must see the same ancestor
  // namespaces before and after the signed record is placed in its AEAT batch.
  recordDocument.documentElement.setAttribute("xmlns:sfLR", AEAT_SIF_LR_NAMESPACE);
  recordDocument.documentElement.setAttribute("xmlns:sf", AEAT_SIF_INFO_NAMESPACE);
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
  const key = await webcrypto.subtle.importKey(
    "pkcs8", new Uint8Array(pkcs8),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const certBase64 = certificate.raw.toString("base64");
  const signed = new SifSignedXml();
  signed.XmlSignature.SignedInfo.CanonicalizationMethod.Algorithm =
    "http://www.w3.org/2001/10/xml-exc-c14n#";
  await signed.Sign({ name: "RSASSA-PKCS1-v1_5" }, key, recordDocument, {
    x509: [certBase64],
    signingCertificate: { certificate: certBase64, digestAlgorithm: "SHA-256" },
    references: [{ hash: "SHA-256", transforms: ["enveloped"] }],
    policy: {
      identifier: { value: POLICY_ID },
      hash: "SHA-1",
      digestValue: POLICY_DIGEST,
      qualifiers: [POLICY_URL],
    },
  });
  const standalone = signed.toString();
  const signedDocument = xadesjs.Parse(standalone);
  if (record.localName === "RegistroEvento") {
    const event = signedDocument.documentElement.getElementsByTagNameNS(AEAT_SIF_EVENT_NAMESPACE, "Evento")[0];
    const eventSignature = signedDocument.documentElement.getElementsByTagNameNS(XMLDSIG_NAMESPACE, "Signature")[0];
    if (!event || !eventSignature) throw new Error("AEAT event signature location is unavailable");
    event.appendChild(eventSignature);
  }
  const locatedStandalone = new XMLSerializer().serializeToString(
    signedDocument as unknown as Parameters<XMLSerializer["serializeToString"]>[0],
  );
  if (!await verifySifRecordSignature(locatedStandalone))
    throw new Error("Standalone AEAT record failed local signature verification");
  record.parentNode?.replaceChild(signedDocument.documentElement, record);
  const output = new XMLSerializer().serializeToString(
    document as unknown as Parameters<XMLSerializer["serializeToString"]>[0],
  );
  if (!await verifySifRecordSignature(output))
    throw new Error("Signed AEAT record failed local signature verification");
  return output;
}

/** Checks XMLDSIG cryptography; certificate trust and qualification need external review. */
export async function verifySifRecordSignature(xml: string): Promise<boolean> {
  const document = xadesjs.Parse(xml);
  const signatures = document.getElementsByTagNameNS(XMLDSIG_NAMESPACE, "Signature");
  if (signatures.length !== 1) return false;
  const signature = signatures[0];
  const parent = signature.parentNode as Element | null;
  const isEvent = parent?.localName === "Evento" && parent.namespaceURI === AEAT_SIF_EVENT_NAMESPACE;
  const record = isEvent
    ? parent.parentNode as Element | null : parent;
  if (!record || record.nodeType !== 1 || !(
    (["RegistroAlta", "RegistroAnulacion"].includes(record.localName) && record.namespaceURI === AEAT_SIF_INFO_NAMESPACE) ||
    (record.localName === "RegistroEvento" && record.namespaceURI === AEAT_SIF_EVENT_NAMESPACE)
  ))
    return false;
  if (record.localName === "RegistroEvento" && !isEvent) return false;
  const policy = signature.getElementsByTagNameNS(XADES_NAMESPACE, "SignaturePolicyIdentifier")[0];
  if (!policy ||
      policy.getElementsByTagNameNS(XADES_NAMESPACE, "Identifier")[0]?.textContent !== POLICY_ID ||
      policy.getElementsByTagNameNS(XMLDSIG_NAMESPACE, "DigestValue")[0]?.textContent !== POLICY_DIGEST ||
      policy.getElementsByTagNameNS(XADES_NAMESPACE, "SPURI")[0]?.textContent !== POLICY_URL)
    return false;
  // xmldsigjs' enveloped transform removes only direct Signature children.
  // AEAT places an event Signature inside Evento while signing RegistroEvento.
  // Normalize a clone solely for local verification; the returned XML retains
  // AEAT's required nested location and the signed data is otherwise identical.
  let verificationRecord = record;
  let verificationSignature = signature;
  if (isEvent) {
    const clone = xadesjs.Parse(new XMLSerializer().serializeToString(
      record as unknown as Parameters<XMLSerializer["serializeToString"]>[0],
    ));
    verificationRecord = clone.documentElement;
    verificationSignature = clone.documentElement.getElementsByTagNameNS(XMLDSIG_NAMESPACE, "Signature")[0];
    verificationRecord.appendChild(verificationSignature);
  }
  const verifier = new XmlSignedXml(verificationRecord);
  try {
    verifier.LoadXml(verificationSignature);
    return await verifier.Verify();
  } catch {
    return false;
  }
}

function openIdentity(identity: SifSigningIdentity): { privateKey: KeyObject; certificate: X509Certificate } {
  if (!/^[0-9a-f]{64}$/i.test(identity.expectedCertificateSha256))
    throw new Error("Expected signing certificate SHA-256 fingerprint is required");
  const { privateKey, certificates } = extractPkcs12(identity.p12, identity.passphrase);
  if (privateKey.asymmetricKeyType !== "rsa")
    throw new Error("AEAT SIF signing requires an RSA certificate");
  const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const matches = certificates.filter((cert) =>
    cert.publicKey.export({ format: "der", type: "spki" }).equals(publicKey),
  );
  if (matches.length !== 1) throw new Error("SIF signing P12 has no unique matching certificate");
  const certificate = matches[0];
  if (certificate.fingerprint256.replaceAll(":", "").toLowerCase() !==
      identity.expectedCertificateSha256.toLowerCase())
    throw new Error("SIF signing certificate fingerprint does not match company binding");
  if (identity.expectedIssuerTaxId && !certificate.subject.split("\n").some((line) => {
    const match = /^(?:organizationIdentifier|2\.5\.4\.97)=VATES-(.+)$/i.exec(line.trim());
    return match?.[1].toUpperCase() === identity.expectedIssuerTaxId?.toUpperCase();
  }))
    throw new Error("SIF signing certificate subject does not identify the issuing company");
  const now = Date.now();
  if (now < Date.parse(certificate.validFrom) || now >= Date.parse(certificate.validTo))
    throw new Error("SIF signing certificate is outside its validity period");
  return { privateKey, certificate };
}

function extractPkcs12(p12: Buffer, passphrase: string): { privateKey: KeyObject; certificates: X509Certificate[] } {
  const dir = mkdtempSync(join(tmpdir(), "pastagansa-sif-"));
  try {
    const p12Path = join(dir, "identity.p12");
    writeFileSync(p12Path, p12);
    const env = { ...process.env, SIF_P12_PASSWORD: passphrase };
    const keyResult = spawnSync("openssl", ["pkcs12", "-in", p12Path, "-passin", "env:SIF_P12_PASSWORD", "-nocerts", "-nodes"], { encoding: "utf8", env });
    const certResult = spawnSync("openssl", ["pkcs12", "-in", p12Path, "-passin", "env:SIF_P12_PASSWORD", "-clcerts", "-nokeys"], { encoding: "utf8", env });
    if (keyResult.status !== 0 || certResult.status !== 0)
      throw new Error("Unable to unlock SIF signing certificate");
    const privateKeys = keyResult.stdout.match(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g) ?? [];
    if (privateKeys.length !== 1) throw new Error("SIF signing P12 must contain one private key");
    const certs = certResult.stdout.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
    if (!certs.length) throw new Error("SIF signing P12 must contain a certificate");
    return {
      privateKey: createPrivateKey(privateKeys[0]),
      certificates: certs.map((cert) => new X509Certificate(cert)),
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("SIF signing")) throw error;
    throw new Error("Unable to unlock SIF signing certificate");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
