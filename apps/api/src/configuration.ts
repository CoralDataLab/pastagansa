export function validateConfiguration(values: Record<string, unknown>) {
  const required = ["DATABASE_URL", "JWT_SECRET"];
  for (const name of required)
    if (typeof values[name] !== "string" || !values[name])
      throw new Error(`${name} is required`);
  if (String(values.JWT_SECRET).length < 32)
    throw new Error("JWT_SECRET must contain at least 32 characters");
  positiveInteger(values, "ACCESS_TOKEN_TTL_SECONDS", 900);
  positiveInteger(values, "REFRESH_TOKEN_TTL_DAYS", 30);
  positiveInteger(values, "THROTTLE_LIMIT", 120);
  positiveInteger(values, "SMTP_PORT", 587);
  const smtpFields = ["SMTP_HOST", "SMTP_FROM"].filter(
    (name) => typeof values[name] === "string" && values[name],
  );
  if (smtpFields.length && smtpFields.length !== 2)
    throw new Error("SMTP_HOST and SMTP_FROM must be configured together");
  if (values.SMTP_USER && !values.SMTP_PASSWORD)
    throw new Error("SMTP_PASSWORD is required when SMTP_USER is configured");
  if (
    values.SMTP_SECURE &&
    !["true", "false"].includes(String(values.SMTP_SECURE))
  )
    throw new Error("SMTP_SECURE must be true or false");
  if (smtpFields.length && !values.DIRECT_DATABASE_URL)
    throw new Error(
      "DIRECT_DATABASE_URL is required for the email outbox worker",
    );
  if (
    values.OCR_WORKER_ENABLED &&
    !["true", "false"].includes(String(values.OCR_WORKER_ENABLED))
  )
    throw new Error("OCR_WORKER_ENABLED must be true or false");
  if (
    String(values.OCR_WORKER_ENABLED) === "true" &&
    !values.DIRECT_DATABASE_URL
  )
    throw new Error(
      "DIRECT_DATABASE_URL is required when the OCR worker is enabled",
    );
  if (values.AEAT_TEST_ENABLED && !["true", "false"].includes(String(values.AEAT_TEST_ENABLED)))
    throw new Error("AEAT_TEST_ENABLED must be true or false");
  if (String(values.AEAT_TEST_ENABLED) === "true") {
    for (const name of ["AEAT_TEST_PFX_PATH", "AEAT_TEST_PFX_PASSPHRASE_FILE", "DIRECT_DATABASE_URL"])
      if (typeof values[name] !== "string" || !values[name])
        throw new Error(`${name} is required when AEAT_TEST_ENABLED is true`);
    for (const name of ["AEAT_TEST_PFX_PATH", "AEAT_TEST_PFX_PASSPHRASE_FILE"])
      if (!String(values[name]).startsWith("/"))
        throw new Error(`${name} must be an absolute path`);
  }
  return values;
}
function positiveInteger(
  values: Record<string, unknown>,
  name: string,
  fallback: number,
) {
  const value = Number(values[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`);
  values[name] = String(value);
}
