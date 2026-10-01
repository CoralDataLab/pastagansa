import { validateConfiguration } from "../configuration";

const base = {
  DATABASE_URL: "postgresql://app:app@localhost:5432/test",
  JWT_SECRET: "test-secret-with-at-least-32-characters",
};

describe("command pilot configuration", () => {
  it("does not enable the pilot implicitly and accepts explicit opt-in/out", () => {
    expect(
      validateConfiguration({ ...base }).AI_NATIVE_ENABLED,
    ).toBeUndefined();
    for (const enabled of ["true", "false"])
      expect(
        validateConfiguration({ ...base, AI_NATIVE_ENABLED: enabled })
          .AI_NATIVE_ENABLED,
      ).toBe(enabled);
  });
  it("rejects misspelled activation values", () => {
    expect(() =>
      validateConfiguration({ ...base, AI_NATIVE_ENABLED: "yes" }),
    ).toThrow("true or false");
  });
});
