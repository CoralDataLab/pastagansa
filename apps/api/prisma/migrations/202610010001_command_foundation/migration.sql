CREATE TYPE "CommandProposalStatus" AS ENUM ('PENDING_REVIEW', 'EXECUTED', 'REJECTED');
CREATE TYPE "CommandReviewDecision" AS ENUM ('EXECUTE', 'REJECT');

CREATE TABLE "command_executions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "company_id" UUID NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "command_id" VARCHAR(128) NOT NULL CHECK (length(btrim("command_id")) > 0),
  "name" VARCHAR(100) NOT NULL,
  "version" INTEGER NOT NULL CHECK ("version" > 0),
  "payload_hash" CHAR(64) NOT NULL CHECK ("payload_hash" ~ '^[0-9a-f]{64}$'),
  "payload" JSONB NOT NULL,
  "evidence" JSONB NOT NULL CHECK (jsonb_typeof("evidence") = 'array'),
  "result" JSONB NOT NULL,
  "actor_user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "executed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("company_id", "command_id"),
  UNIQUE ("id", "organization_id", "company_id")
);
CREATE INDEX "command_executions_company_executed_idx" ON "command_executions"("company_id", "executed_at");

CREATE TABLE "command_proposals" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "company_id" UUID NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "command_id" VARCHAR(128) NOT NULL CHECK (length(btrim("command_id")) > 0),
  "name" VARCHAR(100) NOT NULL,
  "version" INTEGER NOT NULL CHECK ("version" > 0),
  "payload_hash" CHAR(64) NOT NULL CHECK ("payload_hash" ~ '^[0-9a-f]{64}$'),
  "payload" JSONB NOT NULL,
  "evidence" JSONB NOT NULL CHECK (jsonb_typeof("evidence") = 'array'),
  "provenance" JSONB NOT NULL,
  "proposed_by_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "status" "CommandProposalStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
  "execution_id" UUID UNIQUE,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("company_id", "command_id"),
  UNIQUE ("id", "organization_id", "company_id"),
  FOREIGN KEY ("execution_id", "organization_id", "company_id")
    REFERENCES "command_executions"("id", "organization_id", "company_id") ON DELETE RESTRICT,
  UNIQUE ("execution_id", "organization_id", "company_id"),
  CHECK (("status" = 'EXECUTED') = ("execution_id" IS NOT NULL))
);
CREATE INDEX "command_proposals_company_status_created_idx" ON "command_proposals"("company_id", "status", "created_at");

CREATE TABLE "command_proposal_revisions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "company_id" UUID NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "proposal_id" UUID NOT NULL,
  "revision_number" INTEGER NOT NULL CHECK ("revision_number" > 0),
  "previous_payload" JSONB NOT NULL,
  "corrected_payload" JSONB NOT NULL,
  "changes" JSONB NOT NULL CHECK (jsonb_typeof("changes") = 'array' AND jsonb_array_length("changes") > 0),
  "reason" VARCHAR(1000) NOT NULL CHECK (length(btrim("reason")) > 0),
  "created_by_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("proposal_id", "organization_id", "company_id")
    REFERENCES "command_proposals"("id", "organization_id", "company_id") ON DELETE RESTRICT,
  UNIQUE ("proposal_id", "revision_number")
);
CREATE INDEX "command_proposal_revisions_company_proposal_created_idx" ON "command_proposal_revisions"("company_id", "proposal_id", "created_at");

CREATE TABLE "command_proposal_assignments" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "company_id" UUID NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "proposal_id" UUID NOT NULL,
  "assigned_to_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "assigned_by_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "reason" VARCHAR(1000) NOT NULL CHECK (length(btrim("reason")) > 0),
  "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("proposal_id", "organization_id", "company_id")
    REFERENCES "command_proposals"("id", "organization_id", "company_id") ON DELETE RESTRICT
);
CREATE INDEX "command_proposal_assignments_company_proposal_assigned_idx" ON "command_proposal_assignments"("company_id", "proposal_id", "assigned_at");

CREATE TABLE "command_proposal_attempts" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "company_id" UUID NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "proposal_id" UUID NOT NULL,
  "attempted_payload" JSONB NOT NULL,
  "reason" VARCHAR(1000) NOT NULL CHECK (length(btrim("reason")) > 0),
  "error_code" VARCHAR(80) NOT NULL CHECK ("error_code" ~ '^[A-Z0-9_]+$'),
  "error_message" VARCHAR(2000) NOT NULL CHECK (length(btrim("error_message")) > 0),
  "attempted_by_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "attempted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("proposal_id", "organization_id", "company_id")
    REFERENCES "command_proposals"("id", "organization_id", "company_id") ON DELETE RESTRICT
);
CREATE INDEX "command_proposal_attempts_company_proposal_attempted_idx" ON "command_proposal_attempts"("company_id", "proposal_id", "attempted_at");

CREATE TABLE "command_proposal_events" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "company_id" UUID NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "proposal_id" UUID NOT NULL,
  "sequence" INTEGER NOT NULL CHECK ("sequence" > 0),
  "type" VARCHAR(80) NOT NULL CHECK ("type" ~ '^[a-z0-9_.]+$'),
  "payload" JSONB NOT NULL,
  "payload_hash" CHAR(64) NOT NULL CHECK ("payload_hash" ~ '^[0-9a-f]{64}$'),
  "previous_event_hash" CHAR(64) CHECK ("previous_event_hash" ~ '^[0-9a-f]{64}$'),
  "event_hash" CHAR(64) NOT NULL CHECK ("event_hash" ~ '^[0-9a-f]{64}$'),
  "actor_user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("proposal_id", "organization_id", "company_id")
    REFERENCES "command_proposals"("id", "organization_id", "company_id") ON DELETE RESTRICT,
  UNIQUE ("proposal_id", "sequence")
);
CREATE INDEX "command_proposal_events_company_proposal_sequence_idx" ON "command_proposal_events"("company_id", "proposal_id", "sequence");

CREATE TABLE "command_reviews" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "company_id" UUID NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "proposal_id" UUID NOT NULL UNIQUE,
  "decision" "CommandReviewDecision" NOT NULL,
  "accepted_payload" JSONB,
  "reason" VARCHAR(1000) NOT NULL CHECK (length(btrim("reason")) > 0),
  "reviewed_by_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "reviewed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("proposal_id", "organization_id", "company_id")
    REFERENCES "command_proposals"("id", "organization_id", "company_id") ON DELETE RESTRICT,
  UNIQUE ("proposal_id", "organization_id", "company_id"),
  CHECK (("decision" = 'EXECUTE') = ("accepted_payload" IS NOT NULL))
);

CREATE TABLE "purchase_proposal_documents" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "company_id" UUID NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "proposal_id" UUID NOT NULL,
  "original_name" VARCHAR(240) NOT NULL CHECK (length(btrim("original_name")) > 0),
  "media_type" VARCHAR(40) NOT NULL CHECK ("media_type" IN ('application/pdf', 'image/png', 'image/jpeg')),
  "size_bytes" INTEGER NOT NULL CHECK ("size_bytes" > 0 AND "size_bytes" <= 10485760),
  "sha256" CHAR(64) NOT NULL CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  "content" BYTEA NOT NULL,
  "created_by_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("proposal_id", "organization_id", "company_id")
    REFERENCES "command_proposals"("id", "organization_id", "company_id") ON DELETE RESTRICT,
  UNIQUE ("proposal_id", "sha256")
);
CREATE INDEX "purchase_proposal_documents_company_proposal_created_idx" ON "purchase_proposal_documents"("company_id", "proposal_id", "created_at");

CREATE FUNCTION validate_command_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "companies" WHERE "id" = NEW."company_id"
      AND "organization_id" = NEW."organization_id") THEN
    RAISE EXCEPTION 'command company must belong to its organization';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION prevent_command_fact_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'command receipts and reviews are immutable';
END;
$$;

CREATE FUNCTION enforce_command_proposal_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'command proposals cannot be deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING_REVIEW' OR NEW."execution_id" IS NOT NULL THEN
      RAISE EXCEPTION 'command proposals must start pending review';
    END IF;
  ELSE
    IF OLD."status" <> 'PENDING_REVIEW' OR NEW."status" NOT IN ('EXECUTED', 'REJECTED') OR
       (to_jsonb(NEW) - ARRAY['status', 'execution_id', 'updated_at']) IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['status', 'execution_id', 'updated_at']) THEN
      RAISE EXCEPTION 'only a pending proposal can receive an immutable final decision';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "command_proposal_lifecycle" BEFORE INSERT OR UPDATE OR DELETE ON "command_proposals"
  FOR EACH ROW EXECUTE FUNCTION enforce_command_proposal_lifecycle();

CREATE FUNCTION enforce_purchase_proposal_document_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "command_proposals"
    WHERE "id" = NEW."proposal_id"
      AND "organization_id" = NEW."organization_id"
      AND "company_id" = NEW."company_id"
      AND "status" = 'PENDING_REVIEW'
  ) THEN
    RAISE EXCEPTION 'documents cannot be added after a final decision';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "purchase_proposal_document_insert" BEFORE INSERT ON "purchase_proposal_documents"
  FOR EACH ROW EXECUTE FUNCTION enforce_purchase_proposal_document_insert();

CREATE FUNCTION enforce_command_proposal_revision_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "command_proposals"
    WHERE "id" = NEW."proposal_id"
      AND "organization_id" = NEW."organization_id"
      AND "company_id" = NEW."company_id"
      AND "status" = 'PENDING_REVIEW'
  ) THEN
    RAISE EXCEPTION 'proposal revisions cannot be added after a final decision';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "command_proposal_revision_insert" BEFORE INSERT ON "command_proposal_revisions"
  FOR EACH ROW EXECUTE FUNCTION enforce_command_proposal_revision_insert();

CREATE FUNCTION enforce_command_proposal_assignment_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "command_proposals"
    WHERE "id" = NEW."proposal_id"
      AND "organization_id" = NEW."organization_id"
      AND "company_id" = NEW."company_id"
      AND "status" = 'PENDING_REVIEW'
  ) THEN
    RAISE EXCEPTION 'proposal assignments cannot be added after a final decision';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "memberships"
    WHERE "organization_id" = NEW."organization_id"
      AND "company_id" = NEW."company_id"
      AND "user_id" = NEW."assigned_to_id"
      AND "status" = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'assignee must be an active member of the proposal company';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "command_proposal_assignment_insert" BEFORE INSERT ON "command_proposal_assignments"
  FOR EACH ROW EXECUTE FUNCTION enforce_command_proposal_assignment_insert();

CREATE FUNCTION enforce_command_proposal_event_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous_sequence INTEGER;
  previous_hash CHAR(64);
BEGIN
  SELECT "sequence", "event_hash" INTO previous_sequence, previous_hash
  FROM "command_proposal_events"
  WHERE "proposal_id" = NEW."proposal_id"
    AND "organization_id" = NEW."organization_id"
    AND "company_id" = NEW."company_id"
  ORDER BY "sequence" DESC
  LIMIT 1;
  IF previous_sequence IS NULL THEN
    IF NEW."sequence" <> 1 OR NEW."previous_event_hash" IS NOT NULL THEN
      RAISE EXCEPTION 'first proposal event must start the chain';
    END IF;
  ELSIF NEW."sequence" <> previous_sequence + 1 OR NEW."previous_event_hash" <> previous_hash THEN
    RAISE EXCEPTION 'proposal event chain is not contiguous';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "command_proposal_event_insert" BEFORE INSERT ON "command_proposal_events"
  FOR EACH ROW EXECUTE FUNCTION enforce_command_proposal_event_insert();

CREATE FUNCTION enforce_command_proposal_attempt_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "command_proposals"
    WHERE "id" = NEW."proposal_id"
      AND "organization_id" = NEW."organization_id"
      AND "company_id" = NEW."company_id"
      AND "status" = 'PENDING_REVIEW'
  ) THEN
    RAISE EXCEPTION 'failed attempts can only be recorded while proposal is pending';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "command_proposal_attempt_insert" BEFORE INSERT ON "command_proposal_attempts"
  FOR EACH ROW EXECUTE FUNCTION enforce_command_proposal_attempt_insert();

-- The receipt, human decision and proposal transition must commit together.
CREATE FUNCTION validate_command_review_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  proposal "command_proposals"%ROWTYPE;
  review "command_reviews"%ROWTYPE;
  receipt "command_executions"%ROWTYPE;
  expected_evidence JSONB;
  target_proposal_id UUID;
BEGIN
  IF TG_TABLE_NAME = 'command_proposals' THEN target_proposal_id := NEW."id";
  ELSE target_proposal_id := NEW."proposal_id"; END IF;
  SELECT * INTO proposal FROM "command_proposals" WHERE "id" = target_proposal_id;
  SELECT * INTO review FROM "command_reviews" WHERE "proposal_id" = target_proposal_id;
  IF proposal."status" = 'PENDING_REVIEW' THEN
    IF review."id" IS NOT NULL THEN RAISE EXCEPTION 'pending proposal cannot have a final review'; END IF;
  ELSIF proposal."status" = 'REJECTED' THEN
    IF review."id" IS NULL OR review."decision" <> 'REJECT' THEN
      RAISE EXCEPTION 'rejected proposal requires its rejection decision';
    END IF;
  ELSE
    SELECT * INTO receipt FROM "command_executions" WHERE "id" = proposal."execution_id";
    SELECT proposal."evidence" || COALESCE(jsonb_agg(
      jsonb_build_object(
        'reference', 'purchase-proposal-document:' || "id",
        'sha256', "sha256",
        'description', "original_name"
      ) ORDER BY "created_at", "id"
    ), '[]'::jsonb) INTO expected_evidence
    FROM "purchase_proposal_documents"
    WHERE "proposal_id" = target_proposal_id
      AND "organization_id" = proposal."organization_id"
      AND "company_id" = proposal."company_id";
    IF review."id" IS NULL OR review."decision" <> 'EXECUTE' OR receipt."id" IS NULL OR
       receipt."name" <> proposal."name" OR receipt."version" <> proposal."version" OR
       receipt."payload" IS DISTINCT FROM review."accepted_payload" OR
       receipt."evidence" IS DISTINCT FROM expected_evidence OR
       receipt."actor_user_id" <> review."reviewed_by_id" THEN
      RAISE EXCEPTION 'executed proposal requires its matching review and receipt';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "command_proposal_review_consistency" AFTER INSERT OR UPDATE ON "command_proposals"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_command_review_consistency();
CREATE CONSTRAINT TRIGGER "command_review_proposal_consistency" AFTER INSERT ON "command_reviews"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_command_review_consistency();

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['command_executions', 'command_proposals', 'command_proposal_revisions', 'command_proposal_assignments', 'command_proposal_attempts', 'command_proposal_events', 'command_reviews', 'purchase_proposal_documents'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION validate_command_tenant()', table_name || '_tenant_check', table_name);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON %I USING (organization_id = NULLIF(current_setting(''app.organization_id'', true), '''')::uuid AND company_id = NULLIF(current_setting(''app.company_id'', true), '''')::uuid) WITH CHECK (organization_id = NULLIF(current_setting(''app.organization_id'', true), '''')::uuid AND company_id = NULLIF(current_setting(''app.company_id'', true), '''')::uuid)', table_name || '_tenant_isolation', table_name);
    IF table_name <> 'command_proposals' THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION prevent_command_fact_mutation()', table_name || '_immutable', table_name);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pastagansa_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO pastagansa_app', table_name);
    END IF;
  END LOOP;
END;
$$;

INSERT INTO "permissions" ("id", "code", "name") VALUES
  (gen_random_uuid(), 'command_proposal.create', 'Submit business command proposals'),
  (gen_random_uuid(), 'command_proposal.read', 'Read business command proposals'),
  (gen_random_uuid(), 'command_proposal.review', 'Review and execute business command proposals')
ON CONFLICT ("code") DO NOTHING;
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "roles" r CROSS JOIN "permissions" p
WHERE r."code" = 'organization.owner' AND p."code" IN
  ('command_proposal.create', 'command_proposal.read', 'command_proposal.review')
ON CONFLICT DO NOTHING;
