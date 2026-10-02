import { expect, test } from "@playwright/test";
const membership = {
  organization: { id: "org", name: "Fixture Org" },
  company: {
    id: "company",
    legalName: "Fixture Company",
    taxId: "B12345674",
    baseCurrency: "EUR",
  },
  role: { code: "reviewer", name: "Reviewer", permissions: [] as string[] },
};

test("hides the pilot navigation and data requests when the API flag is off", async ({
  page,
}) => {
  let dataRequests = 0;
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: {
        user: { id: "user", email: "review@example.com" },
        membership: {
          ...membership,
          role: {
            ...membership.role,
            permissions: [
              "command_proposal.read",
              "command_proposal.review",
              "purchase_invoice.create",
            ],
          },
        },
        memberships: [membership],
      },
    }),
  );
  await page.route("**/api/purchase-proposals**", (route) => {
    if (route.request().url().endsWith("/capabilities"))
      return route.fulfill({ json: { enabled: false } });
    dataRequests++;
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected data access" },
    });
  });
  await page.goto("/compras/propuestas");
  await expect(
    page.getByText("La revisión supervisada de facturas está desactivada en esta API."),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Revisar facturas recibidas" }),
  ).toHaveCount(0);
  expect(dataRequests).toBe(0);
});

test("requires read permissions and does not offer creation to a review-only actor", async ({
  page,
}) => {
  let permissions: string[] = [];
  let proposalRequests = 0;
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: {
        user: { id: "user", email: "review@example.com" },
        membership: {
          ...membership,
          role: { ...membership.role, permissions },
        },
        memberships: [membership],
      },
    }),
  );
  await page.route("**/api/purchase-proposals**", (route) => {
    proposalRequests++;
    if (route.request().url().endsWith("/capabilities"))
      return route.fulfill({ json: { enabled: true } });
    if (route.request().url().endsWith("/projection"))
      return route.fulfill({ json: { chainValid: true, eventCount: 1, matchesCurrentState: true, discrepancies: [], projected: { status: "PENDING_REVIEW", currentAssigneeId: null, correctionCount: 0, documentCount: 0, failedAttemptCount: 0 } } });
    if (route.request().url().endsWith("/assignees"))
      return route.fulfill({ json: [] });
    return route.fulfill({
      json: {
        id: "11111111-1111-4111-8111-111111111111",
        commandId: "fixture-1",
        name: "registrar_factura_recibida",
        version: 1,
        status: "PENDING_REVIEW",
        proposedById: "agent",
        createdAt: "2026-10-01T10:00:00Z",
        payload: {
          supplierId: "22222222-2222-4222-8222-222222222222",
          supplierInvoiceNumber: "FIXTURE-1",
          issueDate: "2026-09-01",
          receivedDate: "2026-09-02",
          lines: [{ description: "Service", quantity: 1, unitPrice: 100 }],
        },
        evidence: [],
        provenance: { channel: "API" },
        review: null,
        execution: null,
      },
    });
  });
  await page.goto("/compras/propuestas/11111111-1111-4111-8111-111111111111");
  await expect(
    page.getByText("No tienes permiso para leer propuestas."),
  ).toBeVisible();
  expect(proposalRequests).toBe(0);
  permissions = ["command_proposal.read", "command_proposal.review"];
  await page.reload();
  await expect(
    page.getByText(
      "No tienes permisos para crear el borrador desde esta propuesta.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Crear solo borrador" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Rechazar propuesta" }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Proveedor *", { exact: true }),
  ).toHaveCount(0);
});

test("lets reviewers decide governed learning candidates without automatic application", async ({
  page,
}) => {
  let decisionBody: unknown;
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: {
        user: { id: "user", email: "review@example.com" },
        membership: {
          ...membership,
          role: {
            ...membership.role,
            permissions: ["command_proposal.read", "command_proposal.review"],
          },
        },
        memberships: [membership],
      },
    }),
  );
  await page.route("**/api/purchase-proposals/capabilities", (route) =>
    route.fulfill({ json: { enabled: true } }),
  );
  await page.route("**/api/purchase-proposals/learning-candidates**", async (route) => {
    if (route.request().method() === "POST") {
      decisionBody = route.request().postDataJSON();
      return route.fulfill({
        json: {
          id: "33333333-3333-4333-8333-333333333333",
          proposalId: "11111111-1111-4111-8111-111111111111",
          revisionId: "22222222-2222-4222-8222-222222222222",
          commandName: "registrar_factura_recibida",
          commandVersion: 1,
          fieldPath: "supplierId",
          originalValue: "old",
          correctedValue: "new",
          status: "APPROVED",
          reviewReason: "Useful correction",
          reviewedById: "user",
          reviewedAt: "2026-10-02T10:00:00Z",
          createdById: "user",
          createdAt: "2026-10-02T09:00:00Z",
        },
      });
    }
    return route.fulfill({
      json: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          proposalId: "11111111-1111-4111-8111-111111111111",
          revisionId: "22222222-2222-4222-8222-222222222222",
          commandName: "registrar_factura_recibida",
          commandVersion: 1,
          fieldPath: "supplierId",
          originalValue: "old",
          correctedValue: "new",
          status: "PENDING_REVIEW",
          reviewReason: null,
          reviewedById: null,
          reviewedAt: null,
          createdById: "user",
          createdAt: "2026-10-02T09:00:00Z",
        },
      ],
    });
  });
  await page.goto("/compras/propuestas/aprendizaje");
  await expect(page.getByRole("heading", { name: "Candidatos de aprendizaje" })).toBeVisible();
  await expect(page.getByText("Aprobar un candidato no cambia reglas fiscales")).toBeVisible();
  await page.getByLabel("Motivo para supplierId").fill("Useful correction");
  await page.getByRole("button", { name: "Aprobar" }).click();
  await expect.poll(() => decisionBody).toEqual({ reason: "Useful correction" });
});
