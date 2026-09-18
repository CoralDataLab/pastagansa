ALTER TABLE "invoices" ADD COLUMN "operation_date" DATE;

ALTER TABLE "invoices" ADD CONSTRAINT "invoices_operation_date_not_after_issue_check"
  CHECK ("operation_date" IS NULL OR "operation_date" <= "issue_date");

-- Historical invoices remain NULL: their operation date cannot be inferred.
-- New invoices capture the user's date (or an explicit same-as-issue default).
