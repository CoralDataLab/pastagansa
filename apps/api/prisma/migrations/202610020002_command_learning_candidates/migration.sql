CREATE TYPE "CommandLearningCandidateStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'REJECTED');

ALTER TABLE "command_proposal_revisions"
  ADD CONSTRAINT "command_proposal_revisions_id_organization_company_key"
  UNIQUE ("id", "organization_id", "company_id");

CREATE TABLE "command_learning_candidates" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "company_id" UUID NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "proposal_id" UUID NOT NULL,
  "revision_id" UUID NOT NULL,
  "command_name" VARCHAR(100) NOT NULL,
  "command_version" INTEGER NOT NULL CHECK ("command_version" > 0),
  "field_path" VARCHAR(240) NOT NULL CHECK (length(btrim("field_path")) > 0),
  "original_value" JSONB NOT NULL,
  "corrected_value" JSONB NOT NULL,
  "status" "CommandLearningCandidateStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
  "review_reason" VARCHAR(1000),
  "reviewed_by_id" UUID REFERENCES "users"("id") ON DELETE RESTRICT,
  "reviewed_at" TIMESTAMPTZ(6),
  "created_by_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("proposal_id", "organization_id", "company_id")
    REFERENCES "command_proposals"("id", "organization_id", "company_id") ON DELETE RESTRICT,
  FOREIGN KEY ("revision_id", "organization_id", "company_id")
    REFERENCES "command_proposal_revisions"("id", "organization_id", "company_id") ON DELETE RESTRICT,
  CHECK (("status" = 'PENDING_REVIEW') = ("reviewed_by_id" IS NULL AND "reviewed_at" IS NULL AND "review_reason" IS NULL))
);
CREATE UNIQUE INDEX "command_learning_candidates_revision_field_idx" ON "command_learning_candidates"("revision_id", "field_path");
CREATE INDEX "command_learning_candidates_company_status_created_idx" ON "command_learning_candidates"("company_id", "status", "created_at");
CREATE INDEX "command_learning_candidates_company_field_idx" ON "command_learning_candidates"("company_id", "command_name", "command_version", "field_path");

CREATE FUNCTION enforce_command_learning_candidate_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'learning candidates cannot be deleted';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD."status" <> 'PENDING_REVIEW'
       OR NEW."status" NOT IN ('APPROVED', 'REJECTED')
       OR NEW."reviewed_by_id" IS NULL
       OR NEW."reviewed_at" IS NULL
       OR NEW."review_reason" IS NULL
       OR length(btrim(NEW."review_reason")) = 0
       OR (to_jsonb(NEW) - ARRAY['status', 'review_reason', 'reviewed_by_id', 'reviewed_at']) IS DISTINCT FROM to_jsonb(OLD) THEN
      RAISE EXCEPTION 'learning candidates only allow one immutable review decision';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "command_learning_candidate_lifecycle" BEFORE UPDATE OR DELETE ON "command_learning_candidates"
  FOR EACH ROW EXECUTE FUNCTION enforce_command_learning_candidate_lifecycle();

CREATE TRIGGER "command_learning_candidates_tenant_check" BEFORE INSERT ON "command_learning_candidates"
  FOR EACH ROW EXECUTE FUNCTION validate_command_tenant();
ALTER TABLE "command_learning_candidates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "command_learning_candidates" FORCE ROW LEVEL SECURITY;
CREATE POLICY "command_learning_candidates_tenant_isolation" ON "command_learning_candidates"
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid AND company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid AND company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pastagansa_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "command_learning_candidates" TO pastagansa_app;
  END IF;
END;
$$;
