CREATE TABLE "command_proposal_projections" (
  "proposal_id" UUID PRIMARY KEY,
  "organization_id" UUID NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "company_id" UUID NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "status" "CommandProposalStatus" NOT NULL,
  "current_assignee_id" UUID REFERENCES "users"("id") ON DELETE RESTRICT,
  "correction_count" INTEGER NOT NULL DEFAULT 0 CHECK ("correction_count" >= 0),
  "failed_attempt_count" INTEGER NOT NULL DEFAULT 0 CHECK ("failed_attempt_count" >= 0),
  "document_count" INTEGER NOT NULL DEFAULT 0 CHECK ("document_count" >= 0),
  "execution_id" UUID,
  "last_event_sequence" INTEGER NOT NULL CHECK ("last_event_sequence" > 0),
  "last_event_hash" CHAR(64) NOT NULL CHECK ("last_event_hash" ~ '^[0-9a-f]{64}$'),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("proposal_id", "organization_id", "company_id")
    REFERENCES "command_proposals"("id", "organization_id", "company_id") ON DELETE RESTRICT,
  FOREIGN KEY ("execution_id", "organization_id", "company_id")
    REFERENCES "command_executions"("id", "organization_id", "company_id") ON DELETE RESTRICT
);
CREATE INDEX "command_proposal_projections_company_status_idx" ON "command_proposal_projections"("company_id", "status", "updated_at");
CREATE INDEX "command_proposal_projections_company_assignee_idx" ON "command_proposal_projections"("company_id", "current_assignee_id") WHERE "current_assignee_id" IS NOT NULL;

INSERT INTO "command_proposal_projections" (
  "proposal_id", "organization_id", "company_id", "status", "current_assignee_id",
  "correction_count", "failed_attempt_count", "document_count", "execution_id",
  "last_event_sequence", "last_event_hash", "updated_at"
)
SELECT
  p."id",
  p."organization_id",
  p."company_id",
  p."status",
  a."assigned_to_id",
  COALESCE(r."count", 0),
  COALESCE(t."count", 0),
  COALESCE(d."count", 0),
  p."execution_id",
  e."sequence",
  e."event_hash",
  CURRENT_TIMESTAMP
FROM "command_proposals" p
JOIN LATERAL (
  SELECT "sequence", "event_hash"
  FROM "command_proposal_events"
  WHERE "proposal_id" = p."id"
    AND "organization_id" = p."organization_id"
    AND "company_id" = p."company_id"
  ORDER BY "sequence" DESC
  LIMIT 1
) e ON TRUE
LEFT JOIN LATERAL (
  SELECT "assigned_to_id"
  FROM "command_proposal_assignments"
  WHERE "proposal_id" = p."id"
    AND "organization_id" = p."organization_id"
    AND "company_id" = p."company_id"
  ORDER BY "assigned_at" DESC, "id" DESC
  LIMIT 1
) a ON TRUE
LEFT JOIN LATERAL (
  SELECT count(*)::integer AS "count"
  FROM "command_proposal_revisions"
  WHERE "proposal_id" = p."id"
    AND "organization_id" = p."organization_id"
    AND "company_id" = p."company_id"
) r ON TRUE
LEFT JOIN LATERAL (
  SELECT count(*)::integer AS "count"
  FROM "command_proposal_attempts"
  WHERE "proposal_id" = p."id"
    AND "organization_id" = p."organization_id"
    AND "company_id" = p."company_id"
) t ON TRUE
LEFT JOIN LATERAL (
  SELECT count(*)::integer AS "count"
  FROM "purchase_proposal_documents"
  WHERE "proposal_id" = p."id"
    AND "organization_id" = p."organization_id"
    AND "company_id" = p."company_id"
) d ON TRUE;

CREATE FUNCTION prevent_command_proposal_projection_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'command proposal projections cannot be deleted';
END;
$$;
CREATE TRIGGER "command_proposal_projection_no_delete" BEFORE DELETE ON "command_proposal_projections"
  FOR EACH ROW EXECUTE FUNCTION prevent_command_proposal_projection_delete();

CREATE TRIGGER "command_proposal_projections_tenant_check" BEFORE INSERT ON "command_proposal_projections"
  FOR EACH ROW EXECUTE FUNCTION validate_command_tenant();
ALTER TABLE "command_proposal_projections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "command_proposal_projections" FORCE ROW LEVEL SECURITY;
CREATE POLICY "command_proposal_projections_tenant_isolation" ON "command_proposal_projections"
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid AND company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid AND company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pastagansa_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "command_proposal_projections" TO pastagansa_app;
  END IF;
END;
$$;
