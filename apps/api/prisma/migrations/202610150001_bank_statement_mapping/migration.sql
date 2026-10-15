-- Column mapping remembered per bank account for CSV and Excel statement imports.
ALTER TABLE "bank_accounts" ADD COLUMN "statement_mapping" JSONB;
