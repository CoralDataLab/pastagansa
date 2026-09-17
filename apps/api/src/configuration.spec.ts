import { validateConfiguration } from "./configuration";

const base = {
  DATABASE_URL: "postgresql://app:app@localhost:5432/test",
  DIRECT_DATABASE_URL: "postgresql://admin:admin@localhost:5432/test",
  JWT_SECRET: "test-secret-with-at-least-32-characters",
  AEAT_TEST_ENABLED: "true",
  AEAT_TEST_PFX_PATH: "/run/secrets/aeat-test.p12",
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
});
