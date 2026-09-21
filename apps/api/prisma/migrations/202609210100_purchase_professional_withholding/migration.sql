ALTER TYPE "AccountingRole" ADD VALUE 'WITHHOLDING_PAYABLE';

ALTER TABLE "purchase_invoices"
  ADD COLUMN "withholding_rate" DECIMAL(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN "withholding_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD CONSTRAINT "purchase_withholding_valid" CHECK (
    withholding_rate BETWEEN 0 AND 100 AND withholding_amount >= 0
    AND withholding_amount <= total
  );

ALTER TABLE "purchase_invoices" DROP CONSTRAINT "purchase_invoices_payment_balance_check";
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_payment_balance_check" CHECK (
  "amount_paid" >= 0 AND "amount_due" >= 0
  AND (
    ("status" IN ('DRAFT', 'PENDING_APPROVAL', 'CANCELLED')
      AND "amount_paid" = 0 AND "amount_due" = 0)
    OR
    ("status" = 'APPROVED'
      AND "amount_paid" + "amount_due" = "total" - "withholding_amount")
  )
);

ALTER TABLE "supplier_payments"
  ADD COLUMN "withholding_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "withholding_base" DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD CONSTRAINT "supplier_payment_withholding_valid" CHECK (
    withholding_amount >= 0 AND withholding_base >= 0
  );

CREATE OR REPLACE FUNCTION validate_accounting_rule() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actual_class "AccountClass";
  account_active BOOLEAN;
  expected_class "AccountClass";
BEGIN
  IF NOT (
    (NEW."source_type" = 'SALES_INVOICE' AND NEW."accounting_role" IN ('CUSTOMER_RECEIVABLE', 'SALES_REVENUE', 'OUTPUT_VAT')) OR
    (NEW."source_type" = 'PURCHASE_INVOICE' AND NEW."accounting_role" IN ('PURCHASE_EXPENSE', 'INPUT_VAT', 'SUPPLIER_PAYABLE')) OR
    (NEW."source_type" = 'PAYMENT' AND NEW."accounting_role" IN ('BANK', 'CUSTOMER_RECEIVABLE')) OR
    (NEW."source_type" = 'SUPPLIER_PAYMENT' AND NEW."accounting_role" IN ('SUPPLIER_PAYABLE', 'BANK', 'WITHHOLDING_PAYABLE'))
  ) THEN
    RAISE EXCEPTION 'accounting role is not valid for source type';
  END IF;

  expected_class := CASE NEW."accounting_role"
    WHEN 'CUSTOMER_RECEIVABLE' THEN 'ASSET'::"AccountClass"
    WHEN 'SUPPLIER_PAYABLE' THEN 'LIABILITY'::"AccountClass"
    WHEN 'WITHHOLDING_PAYABLE' THEN 'LIABILITY'::"AccountClass"
    WHEN 'SALES_REVENUE' THEN 'INCOME'::"AccountClass"
    WHEN 'PURCHASE_EXPENSE' THEN 'EXPENSE'::"AccountClass"
    WHEN 'OUTPUT_VAT' THEN 'LIABILITY'::"AccountClass"
    WHEN 'INPUT_VAT' THEN 'ASSET'::"AccountClass"
    WHEN 'BANK' THEN 'ASSET'::"AccountClass"
  END;

  SELECT "account_class", "active" INTO actual_class, account_active
  FROM "accounts"
  WHERE "id" = NEW."account_id"
    AND "organization_id" = NEW."organization_id"
    AND "company_id" = NEW."company_id";

  IF NOT FOUND OR account_active IS NOT TRUE OR actual_class <> expected_class THEN
    RAISE EXCEPTION 'accounting rule requires an active account of the expected class';
  END IF;
  RETURN NEW;
END;
$$;
