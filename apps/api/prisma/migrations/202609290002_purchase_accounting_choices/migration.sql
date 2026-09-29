ALTER TABLE "purchase_invoice_lines" ADD COLUMN "expense_account_code" VARCHAR(6) NOT NULL DEFAULT '600000';
ALTER TABLE "supplier_payments" ADD COLUMN "paid_by_shareholder" BOOLEAN NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION validate_accounting_rule() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actual_class "AccountClass";
  account_active BOOLEAN;
  expected_class "AccountClass";
BEGIN
  IF NOT (
    (NEW."source_type" = 'SALES_INVOICE' AND NEW."accounting_role" IN ('CUSTOMER_RECEIVABLE', 'SALES_REVENUE', 'OUTPUT_VAT')) OR
    (NEW."source_type" = 'PURCHASE_INVOICE' AND NEW."accounting_role" IN ('PURCHASE_EXPENSE', 'INPUT_VAT', 'SUPPLIER_PAYABLE', 'WITHHOLDING_PAYABLE')) OR
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
