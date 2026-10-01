import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { expectNoSeriousAccessibilityViolations } from "./accessibility";

test("reviews corrections into a draft, rejects another proposal and preserves originals", async ({
  page,
  request,
}) => {
  test.skip(
    process.env.AI_NATIVE_ENABLED !== "true" || !!process.env.E2E_BASE_URL,
    "Local opt-in pilot test requires AI_NATIVE_ENABLED=true and a disposable database",
  );
  const registration = await page.request.post("/api/auth/register", {
    data: {
      email: `proposal-review-${randomUUID()}@example.com`,
      password: "playwright-password-123",
      organizationName: "Proposal Review",
      legalName: "Proposal Review SL",
      taxId: "Q5000001G",
    },
  });
  expect(registration.ok()).toBeTruthy();
  // Production builds issue Secure cookies; this isolated fixture runs over local HTTP.
  await page
    .context()
    .addCookies(
      (await page.context().cookies()).map((cookie) => ({
        ...cookie,
        secure: false,
      })),
    );
  const session = await (await page.request.get("/api/auth/session")).json();
  const access = (await page.context().cookies()).find(
    (cookie) => cookie.name === "pg_access",
  )!.value;
  const headers = {
    authorization: `Bearer ${access}`,
    "x-organization-id": session.membership.organization.id,
    "x-company-id": session.membership.company.id,
  };
  const supplierResponse = await page.request.post("/api/contacts", {
    data: {
      legalName: "Review Supplier",
      taxCountry: "ES",
      isCustomer: false,
      isSupplier: true,
    },
  });
  expect(supplierResponse.ok()).toBeTruthy();
  const supplier = await supplierResponse.json();
  const payload = {
    supplierId: supplier.id,
    supplierInvoiceNumber: `REVIEW-${randomUUID()}`,
    issueDate: "2026-09-01",
    receivedDate: "2026-09-02",
    currency: "EUR",
    operationDate: "2026-08-31",
    lines: [
      {
        description: "Consulting",
        quantity: 1,
        unitPrice: 100,
        taxRate: 21,
        deductiblePct: 100,
      },
    ],
  };
  async function propose(data = payload) {
    const response = await request.post(
      "http://127.0.0.1:3100/v1/purchase-command-proposals",
      {
        headers,
        data: {
          commandId: randomUUID(),
          payload: data,
          evidence: [
            {
              reference: "document:review-test",
              description: "Trusted fixture document",
            },
          ],
          provenance: {
            channel: "UPLOAD",
            agentId: "browser-test",
            agentVersion: "1",
          },
        },
      },
    );
    expect(response.status()).toBe(201);
    return response.json();
  }
  const proposed = await propose();
  await page.goto("/compras/propuestas");
  await expect(
    page.getByRole("heading", { name: "Propuestas de compra" }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: payload.supplierInvoiceNumber, exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "2. Revisa los datos propuestos" }),
  ).toBeVisible();
  await expectNoSeriousAccessibilityViolations(
    page,
    "purchase proposal review",
  );
  const create = page.getByRole("button", { name: "Crear solo borrador" });
  await expect(create).toBeDisabled();
  await page
    .getByLabel("Notas", { exact: true })
    .fill("Checked against document");
  await expect(
    page.getByRole("cell", { name: '"Checked against document"', exact: true }),
  ).toBeVisible();
  await page.getByRole("checkbox", { name: /He contrastado/ }).check();
  await create.click();
  await expect(page.locator(".inline-error[role=alert]")).toContainText(
    "reason",
  );
  await page
    .getByLabel("Motivo obligatorio")
    .fill("Document and tax treatment checked");
  await create.click();
  await expect(
    page.getByRole("heading", { name: "Resultado de la revisión" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Crear solo borrador" }),
  ).toHaveCount(0);
  const result = await (
    await page.request.get(`/api/purchase-proposals/${proposed.id}`)
  ).json();
  expect(result.payload.notes).toBeUndefined();
  expect(result.payload.operationDate).toBe(payload.operationDate);
  expect(result.review.acceptedPayload.notes).toBe("Checked against document");
  expect(result.execution.result.status).toBe("DRAFT");
  const draft = await (
    await page.request.get(`/api/purchases/${result.execution.result.id}`)
  ).json();
  expect(draft.status).toBe("DRAFT");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Resultado de la revisión" }),
  ).toBeVisible();

  const rejected = await propose({
    ...payload,
    supplierInvoiceNumber: `REJECT-${randomUUID()}`,
  });
  await page.goto(`/compras/propuestas/${rejected.id}`);
  await page.getByLabel("Motivo obligatorio").fill("Duplicate document");
  await page.getByRole("button", { name: "Rechazar propuesta" }).click();
  await expect(
    page.getByRole("heading", { name: "Resultado de la revisión" }),
  ).toBeVisible();
  const rejection = await (
    await page.request.get(`/api/purchase-proposals/${rejected.id}`)
  ).json();
  expect(rejection.status).toBe("REJECTED");
  expect(rejection.execution).toBeNull();

  const failed = await propose({
    ...payload,
    supplierId: randomUUID(),
    supplierInvoiceNumber: `FIX-${randomUUID()}`,
  });
  await page.goto(`/compras/propuestas/${failed.id}`);
  await page.getByLabel("Motivo obligatorio").fill("Reviewed document");
  await page.getByRole("checkbox", { name: /He contrastado/ }).check();
  await page.getByRole("button", { name: "Crear solo borrador" }).click();
  await expect(page.locator(".inline-error[role=alert]")).toContainText(
    "supplier",
  );
  await expect(
    page.getByRole("heading", { name: "2. Revisa los datos propuestos" }),
  ).toBeVisible();
  await page.getByLabel("Proveedor *", { exact: true }).selectOption(supplier.id);
  await expect(
    page.getByRole("checkbox", { name: /He contrastado/ }),
  ).not.toBeChecked();
  await page.getByRole("checkbox", { name: /He contrastado/ }).check();
  await page.getByRole("button", { name: "Crear solo borrador" }).click();
  await expect(
    page.getByRole("heading", { name: "Resultado de la revisión" }),
  ).toBeVisible();
});
