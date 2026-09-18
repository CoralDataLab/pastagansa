ALTER TYPE "JournalSourceType" ADD VALUE 'INVOICE_CANCELLATION';

ALTER TABLE "invoices"
  ADD COLUMN "cancelled_at" TIMESTAMPTZ(6),
  ADD COLUMN "cancellation_reason" VARCHAR(1000);

CREATE OR REPLACE FUNCTION enforce_issued_invoice_immutability() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'issued invoices cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."status" <> 'DRAFT' THEN
    IF NEW."status" = 'DRAFT' OR
       (to_jsonb(NEW) - ARRAY['status', 'amount_paid', 'amount_due', 'cancelled_at', 'cancellation_reason', 'updated_at']) IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['status', 'amount_paid', 'amount_due', 'cancelled_at', 'cancellation_reason', 'updated_at']) THEN
      RAISE EXCEPTION 'issued invoice contents are immutable';
    END IF;
    IF (NEW."cancelled_at" IS DISTINCT FROM OLD."cancelled_at" OR
        NEW."cancellation_reason" IS DISTINCT FROM OLD."cancellation_reason") AND
       (OLD."status" = 'CANCELLED' OR NEW."status" <> 'CANCELLED' OR
        NEW."cancelled_at" IS NULL OR NULLIF(BTRIM(NEW."cancellation_reason"), '') IS NULL) THEN
      RAISE EXCEPTION 'cancellation metadata requires a one-way invoice cancellation';
    END IF;
    IF OLD."status" = 'CANCELLED' AND NEW."status" <> 'CANCELLED' THEN
      RAISE EXCEPTION 'cancelled invoices cannot be reopened';
    END IF;
    IF NEW."status" = 'CANCELLED' AND OLD."status" <> 'CANCELLED' AND
       (NEW."cancelled_at" IS NULL OR
        NULLIF(BTRIM(NEW."cancellation_reason"), '') IS NULL OR
        NEW."amount_paid" <> 0 OR NEW."amount_due" <> 0) THEN
      RAISE EXCEPTION 'cancelled invoices require a reason and zero unpaid/paid balances';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE "tax_ledger_entries" ADD COLUMN "cancellation_of_id" UUID;
ALTER TABLE "tax_ledger_entries" DROP CONSTRAINT "tax_ledger_entries_source_check";
ALTER TABLE "tax_ledger_entries" ADD CONSTRAINT "tax_ledger_entries_source_check"
  CHECK (num_nonnulls("invoice_id", "purchase_invoice_id", "cancellation_of_id") = 1);
ALTER TABLE "tax_ledger_entries" ADD CONSTRAINT "tax_ledger_entries_cancellation_shape_check"
  CHECK ("cancellation_of_id" IS NULL OR
    ("direction" = 'SALES' AND "book_type" = 'ISSUED_INVOICES' AND
     "correction_of_id" IS NULL AND "rectification_impact" IS NULL));
CREATE UNIQUE INDEX "tax_ledger_entries_cancellation_of_id_key"
  ON "tax_ledger_entries"("cancellation_of_id");
CREATE UNIQUE INDEX "tax_ledger_entries_cancellation_tenant_key"
  ON "tax_ledger_entries"("cancellation_of_id", "organization_id", "company_id");
ALTER TABLE "tax_ledger_entries" ADD CONSTRAINT "tax_ledger_entries_cancellation_tenant_fkey"
  FOREIGN KEY ("cancellation_of_id", "organization_id", "company_id")
  REFERENCES "tax_ledger_entries"("id", "organization_id", "company_id") ON DELETE RESTRICT;
