# API platform foundation

Initial implementation of the Platform Ready milestone: multi-organization data, company-scoped memberships, audit events, and a tenant guard.

## Local run

```bash
cp apps/api/.env.example apps/api/.env
docker compose up -d postgres
npm install
npm run db:generate
npm run db:migrate
npm run dev
```

`GET /v1/health` and the identity endpoints are public. `POST /v1/identity/register` creates an owner, organization, and first company atomically; `login` and `refresh` use Argon2id password/refresh-token hashes and rotate refresh tokens.

Authenticated clients use `GET /v1/identity/context` to discover the active user's organizations, companies, roles, and permission codes before selecting tenant headers. Password hashes and session secrets are never included.

Future business controllers must use `@TenantProtected()`; the authentication and tenant guards then require a verified bearer token, check the requested organization/company against active memberships, and write the approved context to `request.tenant`.

`GET` and `PATCH /v1/companies/current` are company-scoped endpoints. They require tenant headers, a bearer token, and the `company.read` or `company.update` permission respectively. The optional document profile keeps commercial contact, payment and presentation defaults separately from legal identity; its IBAN is checksum-validated. `PUT`, `GET`, and `DELETE /v1/companies/current/logo` manage one validated PNG/JPEG logo (maximum 512 KiB) per company. Company and logo updates are recorded in `audit_events` without storing file bytes or sensitive field values there. Invoice and quote drafts capture this profile, then freeze a versioned snapshot and an exact logo copy at issuance or first send; rendering historical PDFs never queries the live company profile.

`/v1/contacts` provides company-scoped customer/supplier master data. Contact deletion is an archive operation; all writes carry tenant, permission, and audit enforcement.

`POST /v1/contacts/import` accepts an object with a `csv` string. Required headers are `legal_name,trade_name,tax_id,email,phone,is_customer,is_supplier`; the import validates every row, rejects duplicate tax IDs, and executes atomically.

`/v1/quotes` creates commercial quotations with a required active `QUOTE` document sequence. Number allocation is atomic and tenant-scoped; the resulting commercial code is preserved through PDF generation, status changes, and idempotent conversion to an invoice draft.

`/v1/catalog-items` manages products and services, including commercial defaults used when document lines are created. Tax codes are suggestions only; they will be resolved by the versioned fiscal engine, not trusted as tax calculations.

`POST /v1/catalog-items/import` accepts a `csv` string with the catalog fields in its documented header. It validates all rows and executes an all-or-nothing import.

Contact and catalog list endpoints return `{ data, nextCursor }`. Provide `cursor` from the previous response together with an optional `limit` (1–100) to fetch the next page; cursors are validated against the selected company.

`/v1/invoices` supports draft creation, atomic issuance through a company document sequence, official PDF download, and transactional email enqueueing. Issuance and email requests require an `Idempotency-Key` header. Once issued, invoice headers and lines are immutable at the database layer.

Invoice lines resolve a versioned fiscal rule for their issue date and persist an immutable tax snapshot. The common Spanish VAT rates of 21%, 10%, and 4% remain backwards-compatible through `taxRate`; zero-rated, exempt, and non-subject operations require an explicit `taxRuleId` because they are legally distinct. Exempt operations also require `exemptionReason`.

`GET /v1/tax-rules?effectiveOn=YYYY-MM-DD` returns the rules applicable on a date. Rules are append-versioned: existing versions cannot be edited or deleted.

Issuing an invoice posts its frozen breakdown to the append-only Tax Ledger in the same transaction. `GET /v1/tax-ledger` supports date, direction, book, and cursor filters; `GET /v1/tax-ledger/:id` returns one entry. Decreasing rectifications post negative bases and quotas linked to the corrected entry. Both endpoints are company-scoped and protected by RLS.

`/v1/purchase-invoices` provides company-scoped supplier invoice drafts with supplier snapshots, duplicate supplier-number protection, fiscal lines, and partial input-VAT deductibility. Drafts accept a due date and `GET`/`PUT /v1/purchase-invoices/:id/payment-schedule` expose configurable installments whose total must match the invoice; approval freezes the schedule and creates a single fallback maturity when none was supplied. `GET`/`POST /v1/purchase-invoices/:id/attachments` and the authenticated download/delete endpoints manage up to 20 transactional database attachments per draft. Files are limited to 10 MiB, restricted to PDF, PNG, or JPEG, checked by content signature, deduplicated by SHA-256, tenant-isolated, and frozen on approval. `GET`/`PUT /v1/purchase-approval-policy` configures amount tiers requiring one to five distinct approvers. Each idempotent `POST /v1/purchase-invoices/:id/approve` records one approval and snapshots the tier and `PURCHASE_INVOICE` reception sequence; pending documents are frozen, can be returned to draft through `POST /v1/purchase-invoices/:id/reject`, and only the final approval allocates the number and posts Tax Ledger and accounting atomically. `GET` and `POST /v1/purchase-invoices/:id/payments` expose and record append-only, idempotent supplier payments allocated oldest-due-first; each payment updates installment and invoice balances and posts suppliers against bank atomically. The ledger retains the supplier document number, internal reception number, issue/operation/receipt dates, deduction date, supported VAT, and deductible VAT.

`POST /v1/purchase-invoices/:id/ocr/attachments/:attachmentId` queues offline Spanish OCR for PNG/JPEG attachments. `GET /v1/purchase-invoices/:id/ocr` and `GET /v1/purchase-invoices/:id/ocr/:jobId` expose status, raw text, field evidence, and confidence; `POST /v1/purchase-invoices/:id/ocr/:jobId/review` stores explicit human corrections and reviewer identity. OCR suggestions never update fiscal data automatically, reviewed results are immutable, and purchase approval is blocked while a requested extraction remains unreviewed. Set `OCR_WORKER_ENABLED=true` with `DIRECT_DATABASE_URL` to run the leased three-attempt worker. Tesseract.js does not support PDF input, so PDF jobs are rejected until a PDF-capable provider or renderer is configured.

`/v1/accounting` exposes the company chart of accounts, fiscal years and monthly periods, journal entries, reversals, and a date-filtered trial balance. A small PGC-inspired default chart is created on demand. Issuing a sales invoice, approving a supplier invoice, or recording a customer/supplier payment posts its balanced entry atomically with the source operation; non-deductible input VAT is included in purchase expense. Manual posting and reversal require an `Idempotency-Key`. Posted entries and lines are database-immutable, numbering is serialized per fiscal year, and locked periods reject new postings.

`GET /v1/accounting/rules` exposes the company posting rules for sales, purchases, customer receipts, and supplier payments. `PUT /v1/accounting/rules/:sourceType/:accountingRole` maps a semantic posting role to an active account of the required class for future entries. PostgreSQL validates permitted event/role combinations, account class, activity, and tenant ownership; changing a rule never rewrites posted history.

`/v1/accounting/reports` provides bounded, company-scoped journal and general-ledger reports in JSON and semicolon-delimited CSV. Reports validate date ranges, cap exports at 100,000 lines, preserve deterministic accounting order, include journal totals or ledger opening/running/closing balances, and protect text cells against spreadsheet formula injection.

`/v1/banking/accounts` links a bank account to an active reconcilable ledger account. `POST /v1/banking/transactions/import` atomically imports normalized bank transactions with duplicate external-ID protection. Unmatched transactions can be listed and inspected for exact-amount journal suggestions within a configurable date window. `POST /v1/banking/transactions/:id/reconcile` explicitly confirms one suggestion; the database enforces matching direction, amount, ledger account, posted status, one-to-one use, and append-only reconciliation. Bank data never creates tax records.

`GET /v1/collections/summary` and `GET /v1/collections/invoices` expose company-scoped receivables as of an explicit date (or the company-local current date), including aging buckets, customer balances, contractual 30/60/90-day forecast, and the last relevant commercial event. `GET /v1/collections/invoices.csv` exports the same filtered result with spreadsheet-formula neutralization and an audit record.

`POST /v1/invoices/:id/rectifications` creates a rectifying draft linked to an issued standard invoice. `sifInvoiceType` is required and preserves the legal AEAT classification R1–R4; R5 is rejected until simplified F2 invoices exist. Total rectifications copy the frozen original lines; ordinary partial and difference rectifications require explicit lines. R2/R3 accept only a VAT-only difference derived from one fully unpaid EUR F1 original with one ordinary VAT rate. Issuance requires `vatRecoveryReview` with confirmed fiscal and exclusion review, legal-event date and reference, and an R3 collection-claim reference. The review and original VAT amounts are frozen on the issued document. Rectifications record their reason and impact, use a `CREDIT_NOTE` sequence at issuance, and retain the PDF, email, tenant, audit, idempotency, and immutability guarantees. The SIF XML freezes the selected classification, original operation date, zero base, and negative corrected VAT. Concurrent issuance is serialized against the original invoice so decreases cannot exceed its corrected balance. Delivery of R2/R3 to the customer and the separate AEAT VAT-base communication remain external follow-up steps.

`PUT /v1/invoices/:id/payment-schedule` replaces the installments of a standard invoice draft; installment amounts must add up exactly to the invoice total. Issuance creates one default installment when no custom schedule exists and then freezes its commercial fields. `POST /v1/invoices/:id/payments` records an idempotent manual collection, allocates it to the oldest open installments, rejects overpayment, atomically posts bank against customer receivables, and updates the invoice balance and `PARTIALLY_PAID`/`PAID` status. `GET /v1/invoices/:id/payment-schedule` and `GET /v1/invoices/:id/payments` expose the resulting detail. Recorded payments and allocations are append-only.

Invoices and quotes share one email-delivery outbox with idempotency keys, recipient/subject history, stored template parameters, SMTP provider message IDs, recoverable leases, and up to five exponential-backoff attempts. A quote changes from draft to sent only when SMTP accepts its PDF; a failed delivery never changes its commercial state. Configure staging/production SMTP with `SMTP_HOST`, `SMTP_FROM`, and optionally `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, and `SMTP_PASSWORD`; authenticated SMTP requires both user and password. The worker also requires `DIRECT_DATABASE_URL` so it can discover tenant queues before processing each delivery through an organization-scoped RLS transaction. With SMTP absent, the UI clearly leaves delivery unavailable and the PDF remains downloadable.

Tenant selection headers (`x-organization-id`, `x-company-id`) are never authorization. They are only candidates validated against the database membership.

## Supervised command pilot (opt-in)

`AI_NATIVE_ENABLED=false` by default. When enabled, purchase draft creation uses the
`registrar_factura_recibida` command handler and optionally accepts `Idempotency-Key`.
`/v1/purchase-command-proposals` provides a proposal/review API with distinct permissions,
immutable original proposals, corrected review payloads and successful execution receipts.
Corrected proposals can create governed learning candidates that require explicit
approval/rejection and are never applied automatically. Execution creates only a draft; purchase approval remains a separate operation.
Apply `202610010001_command_foundation` before enabling. No LLM or event sourcing is
introduced. See [pilot contract and activation](../../docs/24_base_comandos_ia_nativa.md).
The frontend inbox at `/compras/propuestas` supports original/corrected comparisons,
explicit review and rejection; see [frontend review](../../docs/25_bandeja_revision_compras.md).

## Database safety

Tenant-protected requests run inside one database transaction. The request interceptor sets `app.organization_id` on that transaction before domain work starts, and the database forces row-level security even for the table owner. Domain writes and their audit event therefore commit or roll back together.

## Verification

```bash
npm run lint
npm run build
npm test
npm run test:integration
npm audit --audit-level=high
```

The integration suite requires PostgreSQL with all migrations applied. CI provisions PostgreSQL, deploys migrations, and exercises tenant isolation, quotation persistence and races, refresh-token concurrency, revocation, invoice issuance concurrency, supplier-invoice approval and payment, fiscal snapshot immutability, issued/received Tax Ledger posting, automatic and manual accounting entries, reversal, period locking, bank-transaction import and reconciliation, and audit visibility.

OpenAPI is served at `/docs` and Prometheus-format metrics at `/v1/metrics`. Every response receives an `x-request-id`; errors include the same identifier. `GET /v1/health` checks process liveness, while `GET /v1/health/ready` also verifies a live database query and backs the staging readiness probe. `POST /v1/identity/password-reset` consumes a short-lived, single-use recovery token, changes the password, and revokes every active session. In self-hosted environments without SMTP, an operator creates that token with `npm run password:recovery-link -- user@example.com https://ledger.example.com`. Authenticated users can change their password with `PUT /v1/identity/password`, list sessions with `GET /v1/identity/sessions`, and revoke one they own with `DELETE /v1/identity/sessions/:id`.
