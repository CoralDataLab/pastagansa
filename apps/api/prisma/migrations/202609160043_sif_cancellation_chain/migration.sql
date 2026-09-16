CREATE OR REPLACE FUNCTION validate_sif_record_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous_position BIGINT;
  previous_hash CHAR(64);
  previous_generated_at TIMESTAMPTZ(6);
  invoice_issuer_tax_id VARCHAR(40);
  invoice_number VARCHAR(80);
  invoice_issue_date DATE;
  invoice_sif_type "SifInvoiceType";
  invoice_status "InvoiceStatus";
  registration_id UUID;
  registration_hash CHAR(64);
  registration_issuer_tax_id VARCHAR(40);
  registration_invoice_number VARCHAR(80);
  registration_invoice_issue_date DATE;
  registration_invoice_type VARCHAR(2);
  registration_tax_total DECIMAL(14,2);
  registration_total DECIMAL(14,2);
BEGIN
  SELECT i."issuer_tax_id", i."full_number", i."issue_date", i."sif_invoice_type", i."status"
    INTO invoice_issuer_tax_id, invoice_number, invoice_issue_date, invoice_sif_type, invoice_status
  FROM "invoices" i
  WHERE i."id" = NEW."invoice_id"
    AND i."organization_id" = NEW."organization_id"
    AND i."company_id" = NEW."company_id";

  IF invoice_status IS NULL OR invoice_status = 'DRAFT'
    OR invoice_issuer_tax_id IS DISTINCT FROM NEW."issuer_tax_id"
    OR invoice_number IS DISTINCT FROM NEW."invoice_number"
    OR invoice_issue_date IS DISTINCT FROM NEW."invoice_issue_date"
    OR invoice_sif_type::text IS DISTINCT FROM NEW."invoice_type" THEN
    RAISE EXCEPTION 'SIF record must snapshot an issued invoice';
  END IF;

  IF NEW."record_type" = 'CANCELLATION' THEN
    SELECT r."id", r."record_hash", r."issuer_tax_id", r."invoice_number", r."invoice_issue_date",
           r."invoice_type", r."tax_total", r."total"
      INTO registration_id, registration_hash, registration_issuer_tax_id, registration_invoice_number,
           registration_invoice_issue_date, registration_invoice_type, registration_tax_total,
           registration_total
    FROM "sif_records" r
    WHERE r."invoice_id" = NEW."invoice_id"
      AND r."organization_id" = NEW."organization_id"
      AND r."company_id" = NEW."company_id"
      AND r."record_type" = 'REGISTRATION';

    IF registration_id IS NULL
      OR NEW."payload" #>> '{cancellationOf,registrationId}' IS DISTINCT FROM registration_id::text
      OR NEW."payload" #>> '{cancellationOf,registrationHash}' IS DISTINCT FROM registration_hash
      OR registration_issuer_tax_id IS DISTINCT FROM NEW."issuer_tax_id"
      OR registration_invoice_number IS DISTINCT FROM NEW."invoice_number"
      OR registration_invoice_issue_date IS DISTINCT FROM NEW."invoice_issue_date"
      OR registration_invoice_type IS DISTINCT FROM NEW."invoice_type"
      OR registration_tax_total IS DISTINCT FROM NEW."tax_total"
      OR registration_total IS DISTINCT FROM NEW."total" THEN
      RAISE EXCEPTION 'SIF cancellation must preserve its registration snapshot';
    END IF;
  END IF;

  IF NEW."chain_position" > 1 THEN
    SELECT r."chain_position", r."record_hash", r."generated_at"
      INTO previous_position, previous_hash, previous_generated_at
    FROM "sif_records" r
    WHERE r."id" = NEW."previous_record_id"
      AND r."organization_id" = NEW."organization_id"
      AND r."company_id" = NEW."company_id";
    IF previous_position IS NULL
      OR previous_position <> NEW."chain_position" - 1
      OR previous_hash IS DISTINCT FROM NEW."previous_record_hash"
      OR previous_generated_at > NEW."generated_at" THEN
      RAISE EXCEPTION 'invalid SIF record chain';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
