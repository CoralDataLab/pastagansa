ALTER TABLE "contacts" ADD COLUMN "tax_country" CHAR(2) NOT NULL DEFAULT 'ES';
ALTER TABLE "purchase_invoices" ADD COLUMN "supplier_tax_country" CHAR(2) NOT NULL DEFAULT 'ES';
