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
       (to_jsonb(NEW) - ARRAY['status', 'amount_paid', 'credited_amount', 'amount_due', 'cancelled_at', 'cancellation_reason', 'updated_at']) IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['status', 'amount_paid', 'credited_amount', 'amount_due', 'cancelled_at', 'cancellation_reason', 'updated_at']) THEN
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
