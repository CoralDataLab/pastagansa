CREATE TYPE "SifAeatSubmissionStatus" AS ENUM (
  'PENDING', 'SENDING', 'RETRY', 'ACCEPTED', 'ACCEPTED_WITH_ERRORS', 'REJECTED', 'FAILED', 'UNKNOWN'
);

CREATE TABLE "sif_aeat_submissions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "record_id" UUID NOT NULL,
  "status" "SifAeatSubmissionStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "locked_at" TIMESTAMPTZ(6),
  "last_attempt_at" TIMESTAMPTZ(6),
  "completed_at" TIMESTAMPTZ(6),
  "request_sha256" CHAR(64) NOT NULL,
  "http_status" INTEGER,
  "global_status" VARCHAR(30),
  "record_status" VARCHAR(30),
  "csv" VARCHAR(120),
  "error_code" VARCHAR(20),
  "error_description" TEXT,
  "wait_seconds" INTEGER,
  "response_xml" TEXT,
  "last_error" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sif_aeat_submissions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sif_aeat_submissions_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "sif_aeat_submissions_digest_check" CHECK ("request_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "sif_aeat_submissions_wait_check" CHECK ("wait_seconds" IS NULL OR "wait_seconds" >= 0)
);

CREATE UNIQUE INDEX "sif_aeat_submissions_company_record_key"
  ON "sif_aeat_submissions"("company_id", "record_id");
CREATE INDEX "sif_aeat_submissions_status_available_created_idx"
  ON "sif_aeat_submissions"("status", "available_at", "created_at");
CREATE INDEX "sif_aeat_submissions_company_created_idx"
  ON "sif_aeat_submissions"("company_id", "created_at");

ALTER TABLE "sif_aeat_submissions" ADD CONSTRAINT "sif_aeat_submissions_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
ALTER TABLE "sif_aeat_submissions" ADD CONSTRAINT "sif_aeat_submissions_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT;
ALTER TABLE "sif_aeat_submissions" ADD CONSTRAINT "sif_aeat_submissions_record_tenant_fkey"
  FOREIGN KEY ("record_id", "organization_id", "company_id")
  REFERENCES "sif_records"("id", "organization_id", "company_id") ON DELETE RESTRICT;

ALTER TABLE "sif_aeat_submissions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sif_aeat_submissions_organization_isolation" ON "sif_aeat_submissions"
  USING ("organization_id" = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.organization_id', true), '')::uuid);
ALTER TABLE "sif_aeat_submissions" FORCE ROW LEVEL SECURITY;
