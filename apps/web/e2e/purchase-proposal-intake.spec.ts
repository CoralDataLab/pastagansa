import { expect, test } from "@playwright/test";
const supplierId = "22222222-2222-4222-8222-222222222222";
const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aEXcAAAAASUVORK5CYII=", "base64");
async function fixtures(page: import("@playwright/test").Page, permissions: string[]) {
  const membership = { organization: { id: "org", name: "Test" }, company: { id: "company", legalName: "Test", taxId: "B12345674", baseCurrency: "EUR" }, role: { code: "reviewer", name: "Reviewer", permissions } };
  await page.route("**/api/auth/session", route => route.fulfill({ json: { user: { id: "user", email: "review@example.com" }, membership, memberships: [membership] } }));
  await page.route("**/api/purchase-proposals/capabilities", route => route.fulfill({ json: { enabled: true } }));
  await page.route("**/api/contacts?**", route => route.fulfill({ json: { data: [{ id: supplierId, legalName: "Supplier SL", taxId: "B12345674" }], nextCursor: null } }));
}
test("reads locally, requires review, and uploads original with confirmed data", async ({ page }) => {
  await fixtures(page, ["command_proposal.create", "command_proposal.read", "purchase_invoice.ocr"]);
  let saved = false;
  await page.route("**/api/purchase-proposals/ocr-preview", route => route.fulfill({ json: {
    sha256: "a".repeat(64), engine: "tesseract-spa-local", engineVersion: "1",
    issuedAt: "2026-10-02T09:00:00.000Z", signature: "b".repeat(64),
    confidence: 90, rawText: "FACTURA F-123 BASE 100,00", fields: {
      invoiceNumber: { value: "F-123", confidence: 90, evidence: "FACTURA F-123" },
      issueDate: { value: "2026-10-01", confidence: 90, evidence: "FECHA 01/10/2026" },
      taxableBase: { value: "100.00", confidence: 90, evidence: "BASE 100,00" },
    },
  } }));
  await page.route("**/api/purchase-proposals/from-document", route => {
    const body = route.request().postDataBuffer()!.toString("utf8");
    expect(body).toContain('filename="invoice.png"');
    expect(body).toContain('"supplierInvoiceNumber":"F-123"');
    expect(body).toContain('"taxRate":21');
    expect(body).toContain('name="ocrPreview"');
    expect(body).toContain(`"signature":"${"b".repeat(64)}"`);
    saved = true;
    return route.fulfill({ json: { id: "saved-proposal" } });
  });
  await page.route("**/api/purchase-proposals/saved-proposal**", route => route.fulfill({ status: 404, json: { error: "Fixture end" } }));
  await page.goto("/compras/propuestas/nueva");
  await page.getByLabel("Imagen de la factura").setInputFiles({ name: "invoice.png", mimeType: "image/png", buffer: image });
  await page.getByRole("button", { name: "Leer con OCR local" }).click();
  await expect(page.getByLabel("Número de factura *", { exact: true })).toHaveValue("F-123");
  const save = page.getByRole("button", { name: "Guardar propuesta y continuar revisión" });
  await expect(save).toBeDisabled();
  expect(saved).toBe(false);
  await page.getByLabel("Proveedor *", { exact: true }).selectOption(supplierId);
  await page.getByLabel("Descripción de línea revisada *").fill("Service");
  await page.getByLabel("IVA de esta línea (%) *", { exact: true }).fill("21");
  await page.getByRole("checkbox", { name: /He contrastado/ }).check();
  await page.getByLabel("Base de esta línea (EUR) *", { exact: true }).fill("101.00");
  await expect(page.getByRole("checkbox", { name: /He contrastado/ })).not.toBeChecked();
  await page.getByRole("checkbox", { name: /He contrastado/ }).check();
  await save.click();
  await expect(page).toHaveURL(/\/compras\/propuestas\/saved-proposal$/);
  expect(saved).toBe(true);
});

test("does not offer OCR intake without OCR permission", async ({ page }) => {
  await fixtures(page, ["command_proposal.create", "command_proposal.read"]);
  await page.goto("/compras/propuestas/nueva");
  await expect(page.getByText("Necesitas permisos de creación y lectura de propuestas y de OCR de compras.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Leer con OCR local" })).toHaveCount(0);
});
