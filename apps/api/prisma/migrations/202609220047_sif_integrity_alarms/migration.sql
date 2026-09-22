CREATE TABLE "sif_integrity_alarms" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "fingerprint" CHAR(64) NOT NULL,
  "source" VARCHAR(20) NOT NULL,
  "chain_position" BIGINT,
  "reason" VARCHAR(300) NOT NULL,
  "first_detected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_detected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMPTZ(6),
  CONSTRAINT "sif_integrity_alarms_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sif_integrity_alarms_source_check" CHECK ("source" IN ('INVOICE', 'EVENT')),
  CONSTRAINT "sif_integrity_alarms_fingerprint_check" CHECK ("fingerprint" ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX "sif_integrity_alarms_company_fingerprint_key"
  ON "sif_integrity_alarms"("company_id", "fingerprint");
CREATE INDEX "sif_integrity_alarms_company_resolved_detected_idx"
  ON "sif_integrity_alarms"("company_id", "resolved_at", "last_detected_at");
ALTER TABLE "sif_integrity_alarms" ADD CONSTRAINT "sif_integrity_alarms_organization_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
ALTER TABLE "sif_integrity_alarms" ADD CONSTRAINT "sif_integrity_alarms_company_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT;
ALTER TABLE "sif_integrity_alarms" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sif_integrity_alarms_organization_isolation" ON "sif_integrity_alarms"
  USING ("organization_id" = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.organization_id', true), '')::uuid);
ALTER TABLE "sif_integrity_alarms" FORCE ROW LEVEL SECURITY;
