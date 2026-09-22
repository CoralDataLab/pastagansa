CREATE TABLE "sif_event_records" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "event_type" CHAR(2) NOT NULL,
  "chain_position" BIGINT NOT NULL,
  "generated_at" TIMESTAMPTZ(6) NOT NULL,
  "previous_event_id" UUID,
  "previous_event_hash" CHAR(64),
  "event_hash" CHAR(64) NOT NULL,
  "hash_input" JSONB NOT NULL,
  "signed_xml" TEXT NOT NULL,
  "signed_xml_sha256" CHAR(64) NOT NULL,
  "software_snapshot" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sif_event_records_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sif_event_records_type_check" CHECK ("event_type" ~ '^(0[1-9]|10|90)$'),
  CONSTRAINT "sif_event_records_position_check" CHECK ("chain_position" >= 1),
  CONSTRAINT "sif_event_records_hash_check" CHECK ("event_hash" ~ '^[0-9A-F]{64}$'),
  CONSTRAINT "sif_event_records_previous_hash_check" CHECK (
    "previous_event_hash" IS NULL OR "previous_event_hash" ~ '^[0-9A-F]{64}$'
  ),
  CONSTRAINT "sif_event_records_xml_hash_check" CHECK ("signed_xml_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "sif_event_records_first_check" CHECK (
    ("chain_position" = 1 AND "previous_event_id" IS NULL AND "previous_event_hash" IS NULL)
    OR
    ("chain_position" > 1 AND "previous_event_id" IS NOT NULL AND "previous_event_hash" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "sif_event_records_company_position_key"
  ON "sif_event_records"("company_id", "chain_position");
CREATE UNIQUE INDEX "sif_event_records_previous_event_key"
  ON "sif_event_records"("previous_event_id");
CREATE UNIQUE INDEX "sif_event_records_id_tenant_key"
  ON "sif_event_records"("id", "organization_id", "company_id");
CREATE INDEX "sif_event_records_company_generated_id_idx"
  ON "sif_event_records"("company_id", "generated_at", "id");

ALTER TABLE "sif_event_records" ADD CONSTRAINT "sif_event_records_organization_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
ALTER TABLE "sif_event_records" ADD CONSTRAINT "sif_event_records_company_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT;
ALTER TABLE "sif_event_records" ADD CONSTRAINT "sif_event_records_previous_tenant_fkey"
  FOREIGN KEY ("previous_event_id", "organization_id", "company_id")
  REFERENCES "sif_event_records"("id", "organization_id", "company_id") ON DELETE RESTRICT;

CREATE FUNCTION validate_sif_event_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous_position BIGINT;
  previous_hash CHAR(64);
  previous_generated_at TIMESTAMPTZ(6);
BEGIN
  IF NEW."chain_position" > 1 THEN
    SELECT e."chain_position", e."event_hash", e."generated_at"
      INTO previous_position, previous_hash, previous_generated_at
    FROM "sif_event_records" e
    WHERE e."id" = NEW."previous_event_id"
      AND e."organization_id" = NEW."organization_id"
      AND e."company_id" = NEW."company_id";
    IF previous_position IS NULL
      OR previous_position <> NEW."chain_position" - 1
      OR previous_hash IS DISTINCT FROM NEW."previous_event_hash"
      OR previous_generated_at > NEW."generated_at" THEN
      RAISE EXCEPTION 'invalid SIF event chain';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "sif_event_records_validate_chain"
BEFORE INSERT ON "sif_event_records"
FOR EACH ROW EXECUTE FUNCTION validate_sif_event_chain();

CREATE TRIGGER "sif_event_records_immutable"
BEFORE UPDATE OR DELETE ON "sif_event_records"
FOR EACH ROW EXECUTE FUNCTION prevent_sif_record_mutation();

ALTER TABLE "sif_event_records" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sif_event_records_organization_isolation" ON "sif_event_records"
  USING ("organization_id" = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.organization_id', true), '')::uuid);
ALTER TABLE "sif_event_records" FORCE ROW LEVEL SECURITY;
