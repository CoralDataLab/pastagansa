import { validateConfiguration } from "./configuration";

const base = {
  DATABASE_URL: "postgresql://app:app@localhost:5432/test",
  DIRECT_DATABASE_URL: "postgresql://admin:admin@localhost:5432/test",
  JWT_SECRET: "test-secret-with-at-least-32-characters",
  AEAT_TEST_ENABLED: "true",
  AEAT_TEST_PFX_PATH: "/run/secrets/aeat-test.p12",
  AEAT_TEST_COMPANY_ID: "22222222-2222-4222-8222-222222222222",
  AEAT_TEST_ISSUER_TAX_ID: "B12345674",
};

describe("AEAT test certificate configuration", () => {
  it("requires a passphrase file rather than a password in the container environment", () => {
    expect(() => validateConfiguration({
      ...base, AEAT_TEST_PFX_PASSPHRASE: "password-in-environment",
    })).toThrow("AEAT_TEST_PFX_PASSPHRASE_FILE is required");
  });

  it("accepts absolute paths to both mounted files", () => {
    expect(validateConfiguration({
      ...base, AEAT_TEST_PFX_PASSPHRASE_FILE: "/run/secrets/aeat-test-passphrase",
    })).toMatchObject({ AEAT_TEST_ENABLED: "true" });
    expect(() => validateConfiguration({
      ...base, AEAT_TEST_PFX_PASSPHRASE_FILE: "relative-secret",
    })).toThrow("AEAT_TEST_PFX_PASSPHRASE_FILE must be an absolute path");
  });

  it("requires a company and issuer binding for the mounted certificate", () => {
    expect(() => validateConfiguration({
      ...base, AEAT_TEST_COMPANY_ID: undefined,
      AEAT_TEST_PFX_PASSPHRASE_FILE: "/run/secrets/passphrase",
    })).toThrow("AEAT_TEST_COMPANY_ID is required");
    expect(() => validateConfiguration({
      ...base, AEAT_TEST_COMPANY_ID: "wrong",
      AEAT_TEST_PFX_PASSPHRASE_FILE: "/run/secrets/passphrase",
    })).toThrow("AEAT_TEST_COMPANY_ID must be a UUID");
  });
});

describe("NO VERI*FACTU signing configuration", () => {
  const signing = {
    DATABASE_URL: base.DATABASE_URL, DIRECT_DATABASE_URL: base.DIRECT_DATABASE_URL,
    JWT_SECRET: base.JWT_SECRET,
    SIF_NO_SIGNING_ENABLED: "true", SIF_NO_COMPANY_ID: base.AEAT_TEST_COMPANY_ID,
    SIF_NO_ISSUER_TAX_ID: base.AEAT_TEST_ISSUER_TAX_ID,
    SIF_NO_CERT_SHA256: "a".repeat(64),
    SIF_NO_PFX_PATH: "/run/secrets/sif-no.p12",
    SIF_NO_PFX_PASSPHRASE_FILE: "/run/secrets/sif-no-passphrase",
  };
  it("requires absolute secret paths and a pinned certificate fingerprint", () => {
    expect(validateConfiguration({ ...signing })).toMatchObject(signing);
    expect(() => validateConfiguration({ ...signing, SIF_NO_PFX_PATH: "relative.p12" }))
      .toThrow("SIF_NO_PFX_PATH must be an absolute path");
    expect(() => validateConfiguration({ ...signing, SIF_NO_CERT_SHA256: "short" }))
      .toThrow("SIF_NO_CERT_SHA256 must contain 64 hexadecimal characters");
  });
});

describe("SIF production configuration", () => {
  const release = {
    DATABASE_URL: base.DATABASE_URL, DIRECT_DATABASE_URL: base.DIRECT_DATABASE_URL,
    JWT_SECRET: base.JWT_SECRET,
    SIF_PRODUCTION_RELEASE_ENABLED: "true",
    SIF_PRODUCTION_RELEASE_COMPANY_ID: base.AEAT_TEST_COMPANY_ID,
    SIF_PRODUCTION_DECLARATION_PATH: "/run/secrets/sif-declaration.pdf",
    SIF_PRODUCTION_DECLARATION_SHA256: "a".repeat(64),
  };
  it("requires a pinned declaration and company binding before enabling the sender", () => {
    expect(validateConfiguration({ ...release })).toMatchObject(release);
    expect(() => validateConfiguration({ ...release, SIF_PRODUCTION_DECLARATION_PATH: "draft.pdf" }))
      .toThrow("SIF_PRODUCTION_DECLARATION_PATH must be an absolute path");
    expect(() => validateConfiguration({ ...release, SIF_PRODUCTION_DECLARATION_SHA256: "short" }))
      .toThrow("SIF_PRODUCTION_DECLARATION_SHA256 must contain 64 hexadecimal characters");
    expect(() => validateConfiguration({ ...release, SIF_PRODUCTION_RELEASE_COMPANY_ID: "wrong" }))
      .toThrow("SIF_PRODUCTION_RELEASE_COMPANY_ID must be a UUID");
    expect(() => validateConfiguration({ ...release, SIF_PRODUCTION_RELEASE_ENABLED: "false",
      AEAT_PRODUCTION_ENABLED: "true" }))
      .toThrow("AEAT_PRODUCTION_ENABLED requires SIF_PRODUCTION_RELEASE_ENABLED");
  });
  it("requires matching issuer configuration for AEAT production", () => {
    const sender = {
      ...release, AEAT_PRODUCTION_ENABLED: "true",
      AEAT_PRODUCTION_COMPANY_ID: base.AEAT_TEST_COMPANY_ID,
      AEAT_PRODUCTION_ISSUER_TAX_ID: base.AEAT_TEST_ISSUER_TAX_ID,
      AEAT_PRODUCTION_CERT_SHA256: "b".repeat(64),
      AEAT_PRODUCTION_PFX_PATH: "/run/secrets/aeat-production.p12",
      AEAT_PRODUCTION_PFX_PASSPHRASE_FILE: "/run/secrets/aeat-production-passphrase",
    };
    expect(validateConfiguration({ ...sender })).toMatchObject(sender);
    expect(() => validateConfiguration({ ...sender, AEAT_PRODUCTION_COMPANY_ID: "33333333-3333-4333-8333-333333333333" }))
      .toThrow("AEAT_PRODUCTION_COMPANY_ID must match SIF_PRODUCTION_RELEASE_COMPANY_ID");
    expect(() => validateConfiguration({ ...sender, AEAT_PRODUCTION_CERT_SHA256: "short" }))
      .toThrow("AEAT_PRODUCTION_CERT_SHA256 must contain 64 hexadecimal characters");
  });
});
