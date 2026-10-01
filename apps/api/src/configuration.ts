export function validateConfiguration(values: Record<string, unknown>) {
  const required = ["DATABASE_URL", "JWT_SECRET"];
  for (const name of required)
    if (typeof values[name] !== "string" || !values[name])
      throw new Error(`${name} is required`);
  if (String(values.JWT_SECRET).length < 32)
    throw new Error("JWT_SECRET must contain at least 32 characters");
  if (values.AI_NATIVE_ENABLED !== undefined &&
      !["true", "false"].includes(String(values.AI_NATIVE_ENABLED)))
    throw new Error("AI_NATIVE_ENABLED must be true or false");
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
    for (const name of ["AEAT_TEST_PFX_PATH", "AEAT_TEST_PFX_PASSPHRASE_FILE", "AEAT_TEST_COMPANY_ID", "AEAT_TEST_ISSUER_TAX_ID", "DIRECT_DATABASE_URL"])
      if (typeof values[name] !== "string" || !values[name])
        throw new Error(`${name} is required when AEAT_TEST_ENABLED is true`);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(values.AEAT_TEST_COMPANY_ID)))
      throw new Error("AEAT_TEST_COMPANY_ID must be a UUID");
    for (const name of ["AEAT_TEST_PFX_PATH", "AEAT_TEST_PFX_PASSPHRASE_FILE"])
      if (!String(values[name]).startsWith("/"))
        throw new Error(`${name} must be an absolute path`);
  }
  for (const name of ["AEAT_PRODUCTION_ENABLED", "SIF_PRODUCTION_RELEASE_ENABLED"])
    if (values[name] && !["true", "false"].includes(String(values[name])))
      throw new Error(`${name} must be true or false`);
  if (String(values.SIF_PRODUCTION_RELEASE_ENABLED) === "true") {
    for (const name of ["SIF_PRODUCTION_RELEASE_COMPANY_ID", "SIF_PRODUCTION_DECLARATION_PATH", "SIF_PRODUCTION_DECLARATION_SHA256"])
      if (typeof values[name] !== "string" || !values[name])
        throw new Error(`${name} is required when SIF_PRODUCTION_RELEASE_ENABLED is true`);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(values.SIF_PRODUCTION_RELEASE_COMPANY_ID)))
      throw new Error("SIF_PRODUCTION_RELEASE_COMPANY_ID must be a UUID");
    if (!String(values.SIF_PRODUCTION_DECLARATION_PATH).startsWith("/"))
      throw new Error("SIF_PRODUCTION_DECLARATION_PATH must be an absolute path");
    if (!/^[0-9a-f]{64}$/i.test(String(values.SIF_PRODUCTION_DECLARATION_SHA256)))
      throw new Error("SIF_PRODUCTION_DECLARATION_SHA256 must contain 64 hexadecimal characters");
  }
  if (String(values.AEAT_PRODUCTION_ENABLED) === "true") {
    if (String(values.SIF_PRODUCTION_RELEASE_ENABLED) !== "true")
      throw new Error("AEAT_PRODUCTION_ENABLED requires SIF_PRODUCTION_RELEASE_ENABLED");
    for (const name of ["AEAT_PRODUCTION_PFX_PATH", "AEAT_PRODUCTION_PFX_PASSPHRASE_FILE", "AEAT_PRODUCTION_COMPANY_ID", "AEAT_PRODUCTION_ISSUER_TAX_ID", "AEAT_PRODUCTION_CERT_SHA256", "DIRECT_DATABASE_URL"])
      if (typeof values[name] !== "string" || !values[name])
        throw new Error(`${name} is required when AEAT_PRODUCTION_ENABLED is true`);
    if (values.AEAT_PRODUCTION_COMPANY_ID !== values.SIF_PRODUCTION_RELEASE_COMPANY_ID)
      throw new Error("AEAT_PRODUCTION_COMPANY_ID must match SIF_PRODUCTION_RELEASE_COMPANY_ID");
    for (const name of ["AEAT_PRODUCTION_PFX_PATH", "AEAT_PRODUCTION_PFX_PASSPHRASE_FILE"])
      if (!String(values[name]).startsWith("/"))
        throw new Error(`${name} must be an absolute path`);
    if (!/^[0-9a-f]{64}$/i.test(String(values.AEAT_PRODUCTION_CERT_SHA256)))
      throw new Error("AEAT_PRODUCTION_CERT_SHA256 must contain 64 hexadecimal characters");
  }
  if (values.SIF_NO_SIGNING_ENABLED && !["true", "false"].includes(String(values.SIF_NO_SIGNING_ENABLED)))
    throw new Error("SIF_NO_SIGNING_ENABLED must be true or false");
  if (String(values.SIF_NO_SIGNING_ENABLED) === "true") {
    for (const name of ["SIF_NO_PFX_PATH", "SIF_NO_PFX_PASSPHRASE_FILE", "SIF_NO_COMPANY_ID", "SIF_NO_ISSUER_TAX_ID", "SIF_NO_CERT_SHA256", "DIRECT_DATABASE_URL"])
      if (typeof values[name] !== "string" || !values[name])
        throw new Error(`${name} is required when SIF_NO_SIGNING_ENABLED is true`);
    for (const name of ["SIF_NO_PFX_PATH", "SIF_NO_PFX_PASSPHRASE_FILE"])
      if (!String(values[name]).startsWith("/"))
        throw new Error(`${name} must be an absolute path`);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(values.SIF_NO_COMPANY_ID)))
      throw new Error("SIF_NO_COMPANY_ID must be a UUID");
    if (!/^[0-9a-f]{64}$/i.test(String(values.SIF_NO_CERT_SHA256)))
      throw new Error("SIF_NO_CERT_SHA256 must contain 64 hexadecimal characters");
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
