ALTER TABLE "purchase_proposal_documents"
  ADD CONSTRAINT "purchase_proposal_documents_id_organization_company_key"
  UNIQUE ("id", "organization_id", "company_id");

CREATE TABLE "purchase_proposal_ocr_extractions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "company_id" UUID NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "proposal_id" UUID NOT NULL,
  "document_id" UUID NOT NULL,
  "document_sha256" CHAR(64) NOT NULL CHECK ("document_sha256" ~ '^[0-9a-f]{64}$'),
  "engine" VARCHAR(120) NOT NULL CHECK (length(btrim("engine")) > 0),
  "engine_version" VARCHAR(120) NOT NULL CHECK (length(btrim("engine_version")) > 0),
  "confidence" NUMERIC(5,2) NOT NULL CHECK ("confidence" >= 0 AND "confidence" <= 100),
  "raw_text" TEXT NOT NULL CHECK (length("raw_text") <= 100000),
  "fields" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_by_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("proposal_id", "organization_id", "company_id")
    REFERENCES "command_proposals"("id", "organization_id", "company_id") ON DELETE RESTRICT,
  FOREIGN KEY ("document_id", "organization_id", "company_id")
    REFERENCES "purchase_proposal_documents"("id", "organization_id", "company_id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "purchase_proposal_ocr_extractions_document_idx" ON "purchase_proposal_ocr_extractions"("document_id");
CREATE INDEX "purchase_proposal_ocr_extractions_company_proposal_created_idx" ON "purchase_proposal_ocr_extractions"("company_id", "proposal_id", "created_at");

CREATE FUNCTION enforce_purchase_proposal_ocr_extraction_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'purchase proposal OCR extractions are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "purchase_proposal_ocr_extraction_immutable" BEFORE UPDATE OR DELETE ON "purchase_proposal_ocr_extractions"
  FOR EACH ROW EXECUTE FUNCTION enforce_purchase_proposal_ocr_extraction_immutable();

CREATE TRIGGER "purchase_proposal_ocr_extractions_tenant_check" BEFORE INSERT ON "purchase_proposal_ocr_extractions"
  FOR EACH ROW EXECUTE FUNCTION validate_command_tenant();
ALTER TABLE "purchase_proposal_ocr_extractions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_proposal_ocr_extractions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "purchase_proposal_ocr_extractions_tenant_isolation" ON "purchase_proposal_ocr_extractions"
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid AND company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid AND company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pastagansa_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "purchase_proposal_ocr_extractions" TO pastagansa_app;
  END IF;
END;
$$;
