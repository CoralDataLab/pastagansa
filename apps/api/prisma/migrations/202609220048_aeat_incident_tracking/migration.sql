ALTER TABLE "sif_aeat_submissions"
  ADD COLUMN "incident" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "last_attempted_xml" TEXT,
  ADD COLUMN "last_attempted_sha256" CHAR(64);

ALTER TABLE "sif_aeat_submissions"
  ADD CONSTRAINT "sif_aeat_submissions_last_attempted_digest_check"
  CHECK ("last_attempted_sha256" IS NULL OR "last_attempted_sha256" ~ '^[0-9a-f]{64}$');

UPDATE "sif_aeat_submissions"
  SET "incident" = true
  WHERE "status" IN ('RETRY', 'UNKNOWN');

CREATE INDEX "sif_aeat_submissions_company_incident_status_idx"
  ON "sif_aeat_submissions"("company_id", "incident", "status");
