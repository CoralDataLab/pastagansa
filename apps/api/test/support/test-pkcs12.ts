import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export function createTestPkcs12Identity(issuerTaxId?: string) {
  const dir = mkdtempSync(join(tmpdir(), "pastagansa-test-p12-"));
  try {
    const keyPath = join(dir, "key.pem");
    const certPath = join(dir, "cert.pem");
    const p12Path = join(dir, "identity.p12");
    runOpenSsl([
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath,
      "-days", "1", "-sha256",
      "-subj", issuerTaxId ? `/CN=SIF test signer/2.5.4.97=VATES-${issuerTaxId}` : "/CN=SIF test signer",
    ]);
    runOpenSsl([
      "pkcs12", "-export", "-inkey", keyPath, "-in", certPath,
      "-out", p12Path, "-passout", "pass:test-pass",
    ]);
    const certificate = new X509Certificate(readFileSync(certPath));
    return {
      p12: readFileSync(p12Path),
      passphrase: "test-pass",
      expectedCertificateSha256: certificate.fingerprint256.replaceAll(":", "").toLowerCase(),
      ...(issuerTaxId ? { expectedIssuerTaxId: issuerTaxId } : {}),
      certificate,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runOpenSsl(args: string[]) {
  const result = spawnSync("openssl", args, { encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`openssl ${args[0]} failed: ${result.stderr || result.stdout}`);
}
