CREATE TABLE "company_document_profiles" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "company_id" uuid NOT NULL,
  "trade_name" varchar(240),
  "address_line_1" varchar(240),
  "address_line_2" varchar(240),
  "postal_code" varchar(20),
  "city" varchar(120),
  "province" varchar(120),
  "address_country" char(2),
  "email" varchar(320),
  "phone" varchar(40),
  "website" varchar(500),
  "bank_iban" varchar(34),
  "payment_instructions" varchar(2000),
  "payment_terms" varchar(1000),
  "default_notes" varchar(5000),
  "document_footer" varchar(1000),
  "primary_color" char(7),
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "company_document_profiles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "company_document_profiles_company_id_key" UNIQUE ("company_id"),
  CONSTRAINT "company_document_profiles_color_check" CHECK ("primary_color" IS NULL OR "primary_color" ~ '^#[0-9A-Fa-f]{6}$')
);

CREATE TABLE "company_document_logos" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "company_id" uuid NOT NULL,
  "media_type" varchar(100) NOT NULL,
  "size_bytes" integer NOT NULL,
  "width" integer NOT NULL,
  "height" integer NOT NULL,
  "sha256" char(64) NOT NULL,
  "content" bytea NOT NULL,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "company_document_logos_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "company_document_logos_company_id_key" UNIQUE ("company_id"),
  CONSTRAINT "company_document_logos_type_check" CHECK ("media_type" IN ('image/png', 'image/jpeg')),
  CONSTRAINT "company_document_logos_size_check" CHECK ("size_bytes" > 0 AND "size_bytes" <= 524288 AND octet_length("content") = "size_bytes"),
  CONSTRAINT "company_document_logos_dimensions_check" CHECK ("width" BETWEEN 1 AND 2048 AND "height" BETWEEN 1 AND 2048 AND "width" * "height" <= 4194304),
  CONSTRAINT "company_document_logos_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$')
);

ALTER TABLE "company_document_profiles"
  ADD CONSTRAINT "company_document_profiles_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "company_document_profiles_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "company_document_logos"
  ADD CONSTRAINT "company_document_logos_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "company_document_logos_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "company_document_profiles_organization_id_idx" ON "company_document_profiles"("organization_id");
CREATE INDEX "company_document_logos_organization_id_idx" ON "company_document_logos"("organization_id");

ALTER TABLE "company_document_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_document_profiles" FORCE ROW LEVEL SECURITY;
CREATE POLICY "company_document_profiles_tenant_isolation" ON "company_document_profiles"
  USING (
    "organization_id" = NULLIF(current_setting('app.organization_id', true), '')::uuid
    AND "company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid
  )
  WITH CHECK (
    "organization_id" = NULLIF(current_setting('app.organization_id', true), '')::uuid
    AND "company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid
  );

ALTER TABLE "company_document_logos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_document_logos" FORCE ROW LEVEL SECURITY;
CREATE POLICY "company_document_logos_tenant_isolation" ON "company_document_logos"
  USING (
    "organization_id" = NULLIF(current_setting('app.organization_id', true), '')::uuid
    AND "company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid
  )
  WITH CHECK (
    "organization_id" = NULLIF(current_setting('app.organization_id', true), '')::uuid
    AND "company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid
  );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pastagansa_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "company_document_profiles" TO pastagansa_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "company_document_logos" TO pastagansa_app;
  END IF;
END
$$;
