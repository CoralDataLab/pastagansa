DROP INDEX "sif_records_company_invoice_type_key";
CREATE INDEX "sif_records_company_invoice_type_idx"
  ON "sif_records"("company_id", "invoice_id", "record_type");
CREATE UNIQUE INDEX "sif_records_initial_type_key"
  ON "sif_records"("company_id", "invoice_id", "record_type")
  WHERE "record_type" IN ('REGISTRATION', 'CANCELLATION');
CREATE UNIQUE INDEX "sif_records_subsanation_source_key"
  ON "sif_records"("company_id", ("payload" #>> '{subsanationOf,recordId}'))
  WHERE "record_type" = 'SUBSANATION';

CREATE FUNCTION validate_sif_subsanation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_record sif_records%ROWTYPE;
BEGIN
  IF NEW.record_type <> 'SUBSANATION' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO source_record FROM sif_records
    WHERE id = NULLIF(NEW.payload #>> '{subsanationOf,recordId}', '')::uuid
      AND organization_id = NEW.organization_id
      AND company_id = NEW.company_id;
  IF source_record.id IS NULL
    OR source_record.record_type NOT IN ('REGISTRATION', 'SUBSANATION')
    OR source_record.invoice_id IS DISTINCT FROM NEW.invoice_id
    OR source_record.record_hash IS DISTINCT FROM (NEW.payload #>> '{subsanationOf,recordHash}')
    OR source_record.issuer_tax_id IS DISTINCT FROM NEW.issuer_tax_id
    OR source_record.invoice_number IS DISTINCT FROM NEW.invoice_number
    OR source_record.invoice_issue_date IS DISTINCT FROM NEW.invoice_issue_date
    OR source_record.invoice_type IS DISTINCT FROM NEW.invoice_type
    OR source_record.tax_total IS DISTINCT FROM NEW.tax_total
    OR source_record.total IS DISTINCT FROM NEW.total THEN
    RAISE EXCEPTION 'SIF subsanation must preserve its source invoice snapshot';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "sif_records_validate_subsanation"
BEFORE INSERT ON "sif_records"
FOR EACH ROW EXECUTE FUNCTION validate_sif_subsanation();
