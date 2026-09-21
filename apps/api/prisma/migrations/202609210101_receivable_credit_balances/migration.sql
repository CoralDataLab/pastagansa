ALTER TYPE "InvoiceStatus" ADD VALUE 'SETTLED' AFTER 'PAID';

ALTER TABLE "invoices"
  ADD COLUMN "credited_amount" DECIMAL(14,2) NOT NULL DEFAULT 0;

ALTER TABLE "invoice_installments"
  ADD COLUMN "credited_amount" DECIMAL(14,2) NOT NULL DEFAULT 0;

ALTER TABLE "invoices" DROP CONSTRAINT "invoices_payment_balance_check";
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_payment_balance_check" CHECK (
  "amount_paid" >= 0
  AND "credited_amount" >= 0
  AND "amount_due" >= 0
  AND "amount_paid" + "credited_amount" <= "total"
  AND (
    ("document_type" = 'CREDIT_NOTE'
      AND "amount_paid" = 0 AND "credited_amount" = 0 AND "amount_due" = 0)
    OR ("document_type" = 'INVOICE'
      AND "status" IN ('RECTIFIED', 'CANCELLED') AND "amount_due" = 0)
    OR ("document_type" = 'INVOICE'
      AND "status" NOT IN ('RECTIFIED', 'CANCELLED')
      AND "amount_paid" + "credited_amount" + "amount_due" = "total")
  )
);

ALTER TABLE "invoice_installments" DROP CONSTRAINT "invoice_installments_amount_check";
ALTER TABLE "invoice_installments" ADD CONSTRAINT "invoice_installments_amount_check" CHECK (
  "amount" > 0
  AND "paid_amount" >= 0
  AND "credited_amount" >= 0
  AND "paid_amount" + "credited_amount" <= "amount"
);

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
       (to_jsonb(NEW) - ARRAY['status', 'amount_paid', 'credited_amount', 'amount_due', 'updated_at']) IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['status', 'amount_paid', 'credited_amount', 'amount_due', 'updated_at']) THEN
      RAISE EXCEPTION 'issued invoice contents are immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_installment_immutability() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  invoice_status "InvoiceStatus";
  target_invoice_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_invoice_id := OLD."invoice_id";
  ELSE
    target_invoice_id := NEW."invoice_id";
  END IF;
  SELECT "status" INTO invoice_status
  FROM "invoices"
  WHERE "id" = target_invoice_id;

  IF invoice_status <> 'DRAFT' THEN
    IF TG_OP = 'DELETE' OR
       TG_OP = 'INSERT' OR
       (to_jsonb(NEW) - ARRAY['paid_amount', 'credited_amount', 'status', 'updated_at']) IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['paid_amount', 'credited_amount', 'status', 'updated_at']) THEN
      RAISE EXCEPTION 'issued invoice payment schedules are immutable';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
